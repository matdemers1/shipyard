import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SystemStatus } from '@shipyard/schema';
import type { AgentSummary } from '../src/lib/admin';
import { AuthProvider } from '../src/lib/auth';
import { HostSection, healthRows, type HealthInput } from '../src/screens/settings/HostSection';
import { useSystemStatus } from '../src/screens/settings/shared';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * Settings › Host's health checklist (SHP-T-6.5, SHP-T-13.6, SHP-REQ-095/106): every fact the old
 * System screen showed — versions, the Foreman outbox, Shipyard's own backup and drill, the build
 * cache — now one row each, quiet when fine and saying why and what to do when not.
 */

function Host() {
  const system = useSystemStatus(true);
  return <HostSection system={system} />;
}

function wrap(children: ReactNode) {
  return render(
    <ThemeProvider storageKey="test.theme" defaultPreference="light">
      <TooltipProvider>
        <MemoryRouter initialEntries={['/settings/host']}>
          <AuthProvider>{children}</AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const NOW = Date.parse('2026-09-25T00:01:00.000Z');

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    versions: { server: 'sha-abc123', agent: '0.3.0', compose: '5.0.1', engineApi: '1.51' },
    agent: {
      fingerprint: 'SHA256:abc',
      lastHeartbeatAt: new Date().toISOString(),
      stale: false,
      patExpiresAt: null,
      patWarning: 'none',
      unstartedTargets: 0,
    },
    outbox: { unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null },
    backups: { lastBackup: null, lastDrill: null },
    buildCache: null,
    ...overrides,
  };
}

function agentRow(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    fingerprint: 'SHA256:abc',
    confirmed: true,
    confirmedAt: '2026-09-20T00:00:00.000Z',
    confirmedBy: null,
    enrolledAt: '2026-09-20T00:00:00.000Z',
    lastHeartbeatAt: new Date().toISOString(),
    agentVersion: '0.3.0',
    composeVersion: '5.0.1',
    engineApiVersion: '1.51',
    stale: false,
    ...overrides,
  };
}

function routes(body: SystemStatus, apps: { name: string; drift: { id: string } | null }[] = []): Record<string, Reply> {
  return {
    'GET /api/auth/me': meReply('deployer'),
    'GET /api/system': { status: 200, body },
    'GET /api/agent': { status: 200, body: [agentRow()] },
    'GET /api/stats/out-of-band': { status: 200, body: { months: [] } },
    'GET /api/apps': { status: 200, body: { apps } },
  };
}

const health = () => screen.findByRole('list', { name: 'Host health' });

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    status: status(),
    agents: [agentRow({ lastHeartbeatAt: new Date(NOW - 12_000).toISOString() })],
    drifted: [],
    outOfBandThisMonth: 0,
    now: NOW,
    ...overrides,
  };
}

describe('healthRows', () => {
  it('lists the seven checks in order, every one quiet when the host is fine', () => {
    const rows = healthRows(
      input({
        status: status({
          backups: {
            lastBackup: { at: '2026-09-24T03:00:00.000Z', ok: true, file: 'a.dump', bytes: 1, durationMs: 1, error: null },
            lastDrill: { at: '2026-09-24T03:10:00.000Z', ok: true, file: 'a.dump', bytes: 1, durationMs: 1, error: null },
          },
        }),
      }),
    );
    expect(rows.map((r) => r.name)).toEqual([
      'Agent',
      "Agent's GitHub token",
      'Foreman outbox',
      'Nightly backup of Shipyard',
      'Restore drill',
      'Disk',
      'Drift',
    ]);
    expect(rows.every((r) => r.tone === 'idle' && r.fix === undefined)).toBe(true);
  });

  it('names the fix for each problem', () => {
    const rows = healthRows(
      input({
        status: status({
          agent: { fingerprint: 'x', lastHeartbeatAt: null, stale: false, patExpiresAt: new Date(NOW + 9 * 86_400_000).toISOString(), patWarning: 'expiring', unstartedTargets: 0 },
        }),
        drifted: ['foreman'],
      }),
    );
    const pat = rows.find((r) => r.key === 'pat');
    expect(pat?.tone).toBe('warning');
    expect(pat?.value).toMatch(/^Expires in 9 days · /);
    expect(pat?.fix).toEqual({ kind: 'renew' });
    expect(rows.find((r) => r.key === 'drift')?.fix).toEqual({ kind: 'route', label: 'Open foreman', to: '/apps/foreman' });
    expect(rows.find((r) => r.key === 'backup')?.tone).toBe('warning');
  });

  it('an unconfirmed agent asks for confirmation before anything else about it', () => {
    const [agent] = healthRows(input({ agents: [agentRow({ confirmed: false })] }));
    expect(agent?.tone).toBe('attention');
    expect(agent?.fix).toEqual({ kind: 'confirm' });
  });
});

describe('Host health on the page', () => {
  it('shows versions once and "never run" backups when nothing has happened yet', async () => {
    mockFetch(routes(status()));
    wrap(<Host />);
    expect(await screen.findByText(/^Versions:/)).toHaveTextContent('server sha-abc123');
    const list = await health();
    expect(within(list).getAllByText('Never run')).toHaveLength(2);
    expect(within(list).getAllByRole('link', { name: 'Backup runbook' })).toHaveLength(2);
  });

  it('warns when a deploy has waited over an hour for Foreman, with the last error (SHP-REQ-095)', async () => {
    mockFetch(routes(status({ outbox: { unsent: 4, unsentOverHour: 2, oldestUnsentAt: '2026-09-24T00:00:00.000Z', lastError: 'timeout' } })));
    wrap(<Host />);
    expect(await screen.findByText(/2 deploys have waited over an hour to be recorded in Foreman · 4 waiting in all/)).toBeInTheDocument();
    expect(screen.getByText('Last error: timeout')).toBeInTheDocument();
  });

  it('stays quiet when nothing is over an hour', async () => {
    mockFetch(routes(status({ outbox: { unsent: 1, unsentOverHour: 0, oldestUnsentAt: '2026-09-25T00:00:00.000Z', lastError: null } })));
    wrap(<Host />);
    expect(await screen.findByText(/^1 waiting · oldest since/)).toBeInTheDocument();
    expect(screen.queryByText(/waited over an hour/)).not.toBeInTheDocument();
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
    wrap(<Host />);
    expect(await screen.findByText(/^Failed · /)).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
    expect(screen.getByText(/^Ok · .* · restore\.sql$/)).toBeInTheDocument();
  });

  it('says when a heartbeating agent is not taking the work it is handed', async () => {
    const reporting = status().agent;
    if (reporting === null) throw new Error('the default status has an agent');
    mockFetch(routes(status({ agent: { ...reporting, unstartedTargets: 3 } })));
    wrap(<Host />);
    expect(await screen.findByText(/Not taking work: 3 deploys or dry runs handed to it never started/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upgrade runbook' })).toBeInTheDocument();
  });

  it('says "not yet reported" for the build cache when the agent has never reported one', async () => {
    mockFetch(routes(status()));
    wrap(<Host />);
    expect(await screen.findByText('Build cache not yet reported')).toBeInTheDocument();
  });

  it('shows the build cache size, cap, last clean and applied limits when reported (SHP-REQ-133)', async () => {
    mockFetch(
      routes(
        status({
          buildCache: {
            bytes: 1_500_000_000,
            capBytes: 21_474_836_480,
            lastGcAt: '2026-09-27T03:00:00.000Z',
            limitsApplied: { cpus: 4, memoryMb: 8192 },
          },
        }),
      ),
    );
    wrap(<Host />);
    expect(await screen.findByText(/Build cache 1\.50 GB of a 21\.5 GB cap · cleaned .* · limits 4 CPUs, 8192 MiB/)).toBeInTheDocument();
  });

  it('names a drifted app and links to it', async () => {
    mockFetch(routes(status(), [{ name: 'foreman', drift: { id: 'd1' } }, { name: 'bindery', drift: null }]));
    wrap(<Host />);
    expect(await screen.findByText(/^foreman running something Shipyard did not deploy/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open foreman' })).toHaveAttribute('href', '/apps/foreman');
  });
});
