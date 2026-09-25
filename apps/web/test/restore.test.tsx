import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RestoreCandidate, RestoreCandidates } from '@shipyard/schema';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { confirmMatches, formatBytes, lossSentence } from '../src/lib/restore';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * Restore (S7, SHP-T-5.6, SHP-REQ-083): each backup states its loss window in plain words; the
 * confirm sheet's button stays disabled until the app's name is typed exactly; confirming posts
 * the backup's deploy ID and the typed name and follows the restore live. The 24-hour limit
 * disables every backup; a viewer sees the list without actions.
 */

const BACKUP_DEPLOY = '3f0c1c1e-8a4b-4c1f-9a51-2f5d0b7c9e11';

function candidate(overrides: Partial<RestoreCandidate> = {}): RestoreCandidate {
  return {
    backupDeployId: BACKUP_DEPLOY,
    backupDeployKind: 'deploy',
    backupDeploySha: '2'.repeat(40),
    path: '/srv/web/backups/web.dump',
    size: 4096,
    createdAt: '2026-09-25T06:00:00.000Z',
    lossWindowSeconds: 11_520,
    lossWindow: '3 hours 12 minutes',
    releaseSha: '1'.repeat(40),
    available: true,
    ...overrides,
  };
}

function body(overrides: Partial<RestoreCandidates> = {}): RestoreCandidates {
  return { app: 'web', limited: null, candidates: [candidate()], ...overrides };
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function routes(role: 'deployer' | 'viewer', data: RestoreCandidates, extra: Record<string, Reply> = {}) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps/web/restore': { status: 200, body: data },
    ...extra,
  });
}

describe('restore helpers', () => {
  it('matches the confirmation exactly, with no trimming or case folding', () => {
    expect(confirmMatches('web', 'web')).toBe(true);
    expect(confirmMatches('Web', 'web')).toBe(false);
    expect(confirmMatches('web ', 'web')).toBe(false);
    expect(confirmMatches('', 'web')).toBe(false);
  });

  it('says the loss window and sizes in plain words', () => {
    expect(lossSentence({ lossWindow: '3 hours 12 minutes' })).toBe('Writes made in the last 3 hours 12 minutes will be lost.');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4096)).toBe('4.0 KB');
    expect(formatBytes(null)).toBe('size unknown');
  });
});

describe('the restore screen', () => {
  it('states the loss window, keeps confirm disabled until the name is typed exactly, then starts the restore and follows it', async () => {
    const calls = routes('deployer', body(), {
      'POST /api/apps/web/restore': { status: 201, body: { deployId: 'd-restore', state: 'locked' } },
      'GET /api/deploys/d-restore': { status: 200, body: {} },
    });
    const user = userEvent.setup();
    renderAt('/apps/web/restore');

    expect(await screen.findByText('Writes made in the last 3 hours 12 minutes will be lost.', {}, { timeout: 4000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Restore the backup taken/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Restore web' });
    expect(dialog).toHaveTextContent('Writes made in the last 3 hours 12 minutes will be lost.');
    const confirm = screen.getByRole('button', { name: 'Restore web' });
    expect(confirm).toBeDisabled();

    const field = screen.getByLabelText('Type web to confirm');
    await user.type(field, 'Web');
    expect(confirm).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'we');
    expect(confirm).toBeDisabled();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);

    await user.type(field, 'b');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/deploys/d-restore/live');
    });
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/apps/web/restore',
      body: { backupDeployId: BACKUP_DEPLOY, confirm: 'web' },
    });
  });

  it('shows the server refusal in the sheet and stays put', async () => {
    routes('deployer', body(), {
      'POST /api/apps/web/restore': {
        status: 409,
        body: { error: { code: 'locked', gate: 'G4', message: 'web is being deployed by claude.', fix: 'Wait for it to finish.' } },
      },
    });
    const user = userEvent.setup();
    renderAt('/apps/web/restore');
    await user.click(await screen.findByRole('button', { name: /^Restore the backup taken/ }, { timeout: 4000 }));
    await user.type(screen.getByLabelText('Type web to confirm'), 'web');
    await user.click(screen.getByRole('button', { name: 'Restore web' }));
    expect(await screen.findByText('web is being deployed by claude.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/apps/web/restore');
  });

  it('while the 24-hour limit holds, says when it frees up and disables every backup', async () => {
    routes('deployer', body({ limited: { lastRestoreAt: '2026-09-25T08:00:00.000Z', freesAt: '2026-09-26T08:00:00.000Z' }, candidates: [candidate({ available: false })] }));
    renderAt('/apps/web/restore');
    expect(await screen.findByText(/Another restore is allowed from/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Restore the backup taken/ })).toBeDisabled();
  });

  it('a viewer sees the backups and no restore action', async () => {
    routes('viewer', body());
    renderAt('/apps/web/restore');
    expect(await screen.findByText('Writes made in the last 3 hours 12 minutes will be lost.', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Restore the backup taken/ })).not.toBeInTheDocument();
  });

  it('says so when no deploy has taken a backup yet', async () => {
    routes('deployer', body({ candidates: [] }));
    renderAt('/apps/web/restore');
    expect(await screen.findByText('No backups yet', {}, { timeout: 4000 })).toBeInTheDocument();
  });
});
