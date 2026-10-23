import { describe, expect, it } from 'vitest';
import { LOGS_MAX_FOLLOW_SECONDS, type LogLine, type LogsChunk } from '@shipyard/schema';
import {
  LOGS_MAX_PER_VIEWER,
  LOGS_MAX_TOTAL,
  LOGS_RELAY_CAP_BYTES,
  LOGS_TOMBSTONE_MS,
  LOGS_UNCLAIMED_MS,
  LogsHub,
  followSecondsFor,
  linesBytes,
  logsHubFor,
  type LogsEvent,
  type OpenLogsInput,
} from '../../src/logs/hub.js';
import { Bus } from '../../src/events.js';

/** SHP-T-15.4: the in-memory log session hub (SHP-ADR-011, SHP-REQ-189, SHP-REQ-191). */

const CONTAINER = 'c'.repeat(64);
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';

function input(over: Partial<OpenLogsInput> = {}): OpenLogsInput {
  return { agentId: AGENT, container: CONTAINER, containerName: 'web-1', tail: 200, follow: false, viewer: { type: 'user', id: 'u1' }, ...over };
}

function line(text: string): LogLine {
  return { at: null, stream: 'stdout', text };
}

function chunk(logsId: string, seq: number, texts: string[], done = false): LogsChunk {
  return { logsId, seq, lines: texts.map(line), done };
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function openOk(hub: LogsHub, over: Partial<OpenLogsInput> = {}) {
  const s = hub.open(input(over));
  if ('code' in s) throw new Error(s.message);
  return s;
}

describe('followSecondsFor', () => {
  it('is 0 unless following, and never past five minutes (SHP-REQ-189)', () => {
    expect(followSecondsFor(false)).toBe(0);
    expect(followSecondsFor(false, 120)).toBe(0);
    expect(followSecondsFor(true)).toBe(LOGS_MAX_FOLLOW_SECONDS);
    expect(followSecondsFor(true, 9999)).toBe(300);
    expect(followSecondsFor(true, 30)).toBe(30);
  });
});

describe('LogsHub', () => {
  it('hands a session only to its own agent, once, as a LogsJob', () => {
    const hub = new LogsHub();
    const s = openOk(hub, { follow: true });
    expect(hub.claim(OTHER_AGENT)).toBeNull();
    expect(hub.claim(AGENT)).toEqual({ logsId: s.id, containerId: CONTAINER, tail: 200, follow: true, followSeconds: 300 });
    expect(hub.claim(AGENT)).toBeNull();
    hub.release(s.id);
    expect(hub.claim(AGENT)?.logsId).toBe(s.id);
  });

  it('a non-follow job carries followSeconds 0', () => {
    const hub = new LogsHub();
    openOk(hub);
    expect(hub.claim(AGENT)?.followSeconds).toBe(0);
  });

  it('refuses a chunk from an agent it was not dispatched to', () => {
    const hub = new LogsHub();
    const s = openOk(hub);
    expect(hub.chunk(AGENT, chunk(s.id, 0, ['x']))).toBe('not_yours');
    hub.claim(AGENT);
    expect(hub.chunk(OTHER_AGENT, chunk(s.id, 0, ['x']))).toBe('not_yours');
  });

  it('holds chunks until the viewer attaches, then relays them in order and ends on done', () => {
    const hub = new LogsHub();
    const s = openOk(hub);
    hub.claim(AGENT);
    expect(hub.chunk(AGENT, chunk(s.id, 0, ['one', 'two']))).toEqual({ continue: true });
    const seen: LogsEvent[] = [];
    hub.subscribe(s.id, (e) => seen.push(e));
    expect(hub.chunk(AGENT, chunk(s.id, 1, ['three']))).toEqual({ continue: true });
    // A retried chunk is acknowledged but not relayed twice.
    expect(hub.chunk(AGENT, chunk(s.id, 1, ['three']))).toEqual({ continue: true });
    expect(hub.chunk(AGENT, chunk(s.id, 2, [], true))).toEqual({ continue: false });
    expect(seen).toEqual([
      { type: 'lines', seq: 0, lines: [line('one'), line('two')] },
      { type: 'lines', seq: 1, lines: [line('three')] },
      { type: 'end', reason: 'done' },
    ]);
    expect(hub.chunk(AGENT, chunk(s.id, 3, ['late']))).toEqual({ continue: false });
  });

  it('a viewer attaching after the end still gets the lines and the end', () => {
    const hub = new LogsHub();
    const s = openOk(hub);
    hub.claim(AGENT);
    hub.chunk(AGENT, chunk(s.id, 0, ['a'], true));
    const seen: LogsEvent[] = [];
    hub.subscribe(s.id, (e) => seen.push(e));
    expect(seen.map((e) => e.type)).toEqual(['lines', 'end']);
  });

  it('the viewer leaving ends the session: the next chunk is told to stop', () => {
    const hub = new LogsHub();
    const s = openOk(hub, { follow: true });
    hub.claim(AGENT);
    const unsubscribe = hub.subscribe(s.id, () => undefined);
    expect(hub.chunk(AGENT, chunk(s.id, 0, ['a']))).toEqual({ continue: true });
    unsubscribe();
    expect(hub.isLive(s.id)).toBe(false);
    expect(hub.chunk(AGENT, chunk(s.id, 1, ['b']))).toEqual({ continue: false });
  });

  it('stop ends it and tells listeners; stopping twice is a no-op', () => {
    const hub = new LogsHub();
    const s = openOk(hub, { follow: true });
    hub.claim(AGENT);
    const seen: LogsEvent[] = [];
    hub.subscribe(s.id, (e) => seen.push(e));
    expect(hub.stop(s.id)).toBe(true);
    expect(hub.stop(s.id)).toBe(false);
    expect(seen).toEqual([{ type: 'end', reason: 'stopped' }]);
    expect(hub.chunk(AGENT, chunk(s.id, 0, ['x']))).toEqual({ continue: false });
  });

  it('a chunk for a session it never had is told to stop', () => {
    const hub = new LogsHub();
    expect(hub.chunk(AGENT, chunk('33333333-3333-4333-8333-333333333333', 0, ['x']))).toEqual({ continue: false });
  });

  it('caps open sessions per viewer and in total', () => {
    const hub = new LogsHub();
    for (let i = 0; i < LOGS_MAX_PER_VIEWER; i += 1) openOk(hub);
    expect(hub.open(input())).toMatchObject({ code: 'too_many_attempts' });
    for (let i = 0; i < LOGS_MAX_TOTAL - LOGS_MAX_PER_VIEWER; i += 1) openOk(hub, { viewer: { type: 'token', id: `t${String(i)}` } });
    expect(hub.open(input({ viewer: { type: 'user', id: 'someone-else' } }))).toMatchObject({ code: 'too_many_attempts' });
  });

  it('ends the session once the relay cap is reached', () => {
    const hub = new LogsHub();
    const s = openOk(hub, { follow: true });
    hub.claim(AGENT);
    const seen: LogsEvent[] = [];
    hub.subscribe(s.id, (e) => seen.push(e));
    const big = 'x'.repeat(16_000);
    const perChunk = linesBytes(Array.from({ length: 100 }, () => line(big)));
    let seq = 0;
    let answer: unknown = { continue: true };
    while ((answer as { continue: boolean }).continue && seq < 1000) {
      answer = hub.chunk(AGENT, chunk(s.id, seq, Array.from({ length: 100 }, () => big)));
      seq += 1;
    }
    expect(answer).toEqual({ continue: false });
    expect((seq - 1) * perChunk).toBeLessThanOrEqual(LOGS_RELAY_CAP_BYTES + perChunk);
    const end = seen.at(-1);
    expect(end).toMatchObject({ type: 'end', reason: 'cap' });
  });

  it('expires a session no agent picks up, and forgets it after the tombstone', () => {
    const c = clock();
    const hub = new LogsHub(c.now);
    const s = openOk(hub);
    const seen: LogsEvent[] = [];
    hub.subscribe(s.id, (e) => seen.push(e));
    c.advance(LOGS_UNCLAIMED_MS + 1);
    hub.sweep();
    expect(seen).toEqual([{ type: 'end', reason: 'expired', error: expect.objectContaining({ code: 'agent_offline' }) as unknown }]);
    expect(hub.claim(AGENT)).toBeNull();
    c.advance(LOGS_TOMBSTONE_MS + 1);
    hub.sweep();
    expect(hub.get(s.id)).toBeNull();
    expect(hub.size).toBe(0);
  });

  it('ends a followed session past its window, however chatty the agent', () => {
    const c = clock();
    const hub = new LogsHub(c.now);
    const s = openOk(hub, { follow: true });
    hub.claim(AGENT);
    c.advance(LOGS_UNCLAIMED_MS + LOGS_MAX_FOLLOW_SECONDS * 1000 + 120_000);
    expect(hub.chunk(AGENT, chunk(s.id, 0, ['x']))).toEqual({ continue: false });
  });

  it('isViewer names only the opener', () => {
    const hub = new LogsHub();
    const s = openOk(hub);
    expect(hub.isViewer(s.id, { type: 'user', id: 'u1' })).toBe(true);
    expect(hub.isViewer(s.id, { type: 'user', id: 'u2' })).toBe(false);
    expect(hub.isViewer(s.id, { type: 'token', id: 'u1' })).toBe(false);
  });

  it('is one hub per bus', () => {
    const a = new Bus();
    expect(logsHubFor(a)).toBe(logsHubFor(a));
    expect(logsHubFor(a)).not.toBe(logsHubFor(new Bus()));
  });
});

describe('LogsHub memory caps (tombstones)', () => {
  it('counts an ended session still holding unread lines toward the caps until it is read or forgotten', () => {
    const c = clock();
    const hub = new LogsHub(c.now);
    const ids: string[] = [];
    for (let i = 0; i < LOGS_MAX_PER_VIEWER; i += 1) {
      const s = openOk(hub);
      ids.push(s.id);
      hub.claim(AGENT);
      // Finished before the viewer attached: its lines are held for them.
      expect(hub.chunk(AGENT, chunk(s.id, 0, ['held'], true))).toEqual({ continue: false });
      expect(hub.isLive(s.id)).toBe(false);
    }
    expect(hub.open(input())).toMatchObject({ code: 'too_many_attempts' });
    // Reading one releases what it held.
    hub.subscribe(ids[0] ?? '', () => undefined);
    openOk(hub);
    expect(hub.open(input())).toMatchObject({ code: 'too_many_attempts' });
    // After the tombstone window the rest are forgotten.
    c.advance(LOGS_TOMBSTONE_MS + 1);
    expect(hub.size).toBeGreaterThan(0);
    hub.sweep();
    openOk(hub);
  });

  it('a session the viewer stopped before attaching drops what it held and frees its slot', () => {
    const hub = new LogsHub();
    const ids: string[] = [];
    for (let i = 0; i < LOGS_MAX_PER_VIEWER; i += 1) {
      const s = openOk(hub, { follow: true });
      ids.push(s.id);
      hub.claim(AGENT);
      hub.chunk(AGENT, chunk(s.id, 0, ['held']));
    }
    expect(hub.open(input())).toMatchObject({ code: 'too_many_attempts' });
    expect(hub.stop(ids[0] ?? '')).toBe(true);
    const seen: LogsEvent[] = [];
    hub.subscribe(ids[0] ?? '', (e) => seen.push(e));
    expect(seen).toEqual([{ type: 'end', reason: 'stopped' }]);
    openOk(hub);
  });
});
