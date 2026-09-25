import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SystemStatus } from '@shipyard/schema';
import { AuthProvider } from '../src/lib/auth';
import { System } from '../src/screens/System';
import { meReply, mockFetch, type Reply } from './fetch';

/** S15 System (SHP-T-6.5, SHP-REQ-095/106): versions, the outbox badge and Shipyard's own backups. */

function wrap(children: ReactNode) {
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="light">
      <TooltipProvider>
        <MemoryRouter initialEntries={['/system']}>
          <AuthProvider>{children}</AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    versions: { server: 'sha-abc123', agent: '0.3.0', compose: '5.0.1', engineApi: '1.51' },
    agent: {
      fingerprint: 'SHA256:abc',
      lastHeartbeatAt: '2026-09-25T00:00:00.000Z',
      stale: false,
      patExpiresAt: null,
      patWarning: 'none',
    },
    outbox: { unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null },
    backups: { lastBackup: null, lastDrill: null },
    ...overrides,
  };
}

function routes(body: SystemStatus): Record<string, Reply> {
  return {
    'GET /api/auth/me': meReply('deployer'),
    'GET /api/system': { status: 200, body },
  };
}

describe('System screen', () => {
  it('shows versions and "never run" backups when nothing has happened yet', async () => {
    mockFetch(routes(status()));
    wrap(<System />);
    expect(await screen.findByText('sha-abc123')).toBeInTheDocument();
    expect(screen.getByText('0.3.0')).toBeInTheDocument();
    expect(screen.getAllByText('Never run')).toHaveLength(2);
  });

  it('shows the outbox badge when a deploy has waited over an hour (SHP-REQ-095)', async () => {
    mockFetch(routes(status({ outbox: { unsent: 4, unsentOverHour: 2, oldestUnsentAt: '2026-09-24T00:00:00.000Z', lastError: 'timeout' } })));
    wrap(<System />);
    expect(await screen.findByText('Deploys not yet recorded in Foreman')).toBeInTheDocument();
    expect(screen.getByText(/2 deploys have been waiting/)).toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();
  });

  it('shows no outbox badge when nothing is over an hour', async () => {
    mockFetch(routes(status({ outbox: { unsent: 1, unsentOverHour: 0, oldestUnsentAt: '2026-09-25T00:00:00.000Z', lastError: null } })));
    wrap(<System />);
    await screen.findByText('sha-abc123');
    expect(screen.queryByText('Deploys not yet recorded in Foreman')).not.toBeInTheDocument();
  });

  it('shows a failed backup with its error', async () => {
    mockFetch(
      routes(
        status({
          backups: {
            lastBackup: { at: '2026-09-25T03:00:00.000Z', ok: false, file: null, bytes: null, durationMs: null, error: 'disk full' },
            lastDrill: { at: '2026-09-24T03:00:00.000Z', ok: true, file: 'restore.sql', bytes: 100, durationMs: 200, error: null },
          },
        }),
      ),
    );
    wrap(<System />);
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('shows the PAT expiring and expired warnings', async () => {
    mockFetch(
      routes(
        status({
          agent: { fingerprint: 'SHA256:abc', lastHeartbeatAt: null, stale: true, patExpiresAt: '2026-10-01T00:00:00.000Z', patWarning: 'expiring' },
        }),
      ),
    );
    const { unmount } = wrap(<System />);
    expect(await screen.findByText("The agent's GitHub token expires soon")).toBeInTheDocument();
    unmount();

    mockFetch(
      routes(
        status({
          agent: { fingerprint: 'SHA256:abc', lastHeartbeatAt: null, stale: true, patExpiresAt: '2026-09-01T00:00:00.000Z', patWarning: 'expired' },
        }),
      ),
    );
    wrap(<System />);
    expect(await screen.findByText("The agent's GitHub token has expired")).toBeInTheDocument();
  });
});
