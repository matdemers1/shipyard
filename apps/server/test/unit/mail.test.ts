import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createMailer } from '../../src/mail/index.js';

const logger = pino({ enabled: false });

const CONFIGURED = {
  MAIL_RELAY_URL: 'https://relay.example/send',
  MAIL_RELAY_TOKEN: 'secret-token',
  ALERT_TO: 'ops@example.com',
  PUBLIC_URL: 'https://shipyard.example',
};

describe('createMailer (SHP-T-6.4)', () => {
  it('never throws and reports "no mail relay is configured" when unset', async () => {
    const mailer = createMailer({ MAIL_RELAY_URL: undefined, MAIL_RELAY_TOKEN: undefined, ALERT_TO: undefined, PUBLIC_URL: undefined }, logger);
    const result = await mailer.send({ kind: 'agent-stale', subject: 'x', body: 'y' });
    expect(result).toEqual({ sent: false, reason: 'no mail relay is configured' });
  });

  it('posts { to, subject, text } with a bearer token when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const mailer = createMailer(CONFIGURED, logger, { fetch: fetchMock as unknown as typeof fetch });

    const result = await mailer.send({ kind: 'agent-stale', subject: 'The agent is stale', body: 'details' });
    expect(result.sent).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONFIGURED.MAIL_RELAY_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret-token');
    const body = JSON.parse(init.body as string) as { to: string; subject: string; text: string };
    expect(body.to).toBe('ops@example.com');
    expect(body.subject).toBe('[Shipyard] The agent is stale');
    expect(body.text).toContain('details');
    expect(body.text).toContain(CONFIGURED.PUBLIC_URL);
  });

  it('never sends the same kind twice within an hour, and never throws on a network error', async () => {
    const now = { value: new Date('2026-09-25T00:00:00.000Z') };
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const mailer = createMailer(CONFIGURED, logger, { fetch: fetchMock as unknown as typeof fetch, now: () => now.value });

    const first = await mailer.send({ kind: 'backup-failed', subject: 'a', body: 'b' });
    expect(first).toEqual({ sent: false, reason: 'network down' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A network failure never counts as "already sent" — a retry the same tick still reaches out.
    const second = await mailer.send({ kind: 'backup-failed', subject: 'a', body: 'b' });
    expect(second.reason).toBe('network down');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dedupes a successful send for the same kind within the hour, but not a different kind', async () => {
    const now = { value: new Date('2026-09-25T00:00:00.000Z') };
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const mailer = createMailer(CONFIGURED, logger, { fetch: fetchMock as unknown as typeof fetch, now: () => now.value });

    const first = await mailer.send({ kind: 'agent-stale', subject: 'a', body: 'b' });
    expect(first.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.value = new Date(now.value.getTime() + 5 * 60 * 1000);
    const repeat = await mailer.send({ kind: 'agent-stale', subject: 'a', body: 'b' });
    expect(repeat).toEqual({ sent: false, reason: 'already alerted about this recently' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const other = await mailer.send({ kind: 'drill-failed', subject: 'c', body: 'd' });
    expect(other.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now.value = new Date(now.value.getTime() + 61 * 60 * 1000);
    const afterAnHour = await mailer.send({ kind: 'agent-stale', subject: 'a', body: 'b' });
    expect(afterAnHour.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never throws when the relay refuses the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));
    const mailer = createMailer(CONFIGURED, logger, { fetch: fetchMock as unknown as typeof fetch });
    const result = await mailer.send({ kind: 'agent-stale', subject: 'x', body: 'y' });
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('502');
  });
});
