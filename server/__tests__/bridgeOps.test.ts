import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBridgeOps, readLatestDiagnoses } from '../src/bridgeOps.js';
import { BRIDGE_OPS_SCHEMA } from '../src/constants.js';

const GENERATED = Date.parse('2026-10-24T00:00:00Z');

describe('readBridgeOps', () => {
  let dir: string;
  let file: string;
  const write = (body: unknown) =>
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  const status = (overrides: Record<string, unknown> = {}) => ({
    schema: BRIDGE_OPS_SCHEMA,
    generated_at: '2026-10-24T00:00:00Z',
    interval_sec: 600,
    overall: 'ok',
    feeds: [{ id: 'tns', state: 'ok' }],
    ...overrides,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ops-'));
    file = path.join(dir, 'status.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passes a fresh status through', () => {
    write(status());
    const r = readBridgeOps(GENERATED + 60_000, file);
    expect(r.error).toBeNull();
    expect(r.stale).toBe(false);
    expect(r.status?.overall).toBe('ok');
  });

  it('flags the monitor as dead after 3 × interval_sec', () => {
    write(status());
    expect(readBridgeOps(GENERATED + 1800_000, file).stale).toBe(false);
    expect(readBridgeOps(GENERATED + 1800_001, file).stale).toBe(true);
  });

  it('treats an unparseable generated_at as stale', () => {
    write(status({ generated_at: 'soon' }));
    expect(readBridgeOps(GENERATED, file).stale).toBe(true);
  });

  it('refuses a schema it does not know', () => {
    write(status({ schema: 'bridge-ops-status/2' }));
    const r = readBridgeOps(GENERATED, file);
    expect(r.status).toBeNull();
    expect(r.error).toContain('bridge-ops-status/2');
  });

  it('reports a missing or broken file instead of throwing', () => {
    expect(readBridgeOps(GENERATED, file).error).not.toBeNull();
    write('{not json');
    expect(readBridgeOps(GENERATED, file).status).toBeNull();
    write([]);
    expect(readBridgeOps(GENERATED, file).status).toBeNull();
  });
});

describe('readLatestDiagnoses', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-events-'));
    file = path.join(dir, 'events.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

  it('keeps the newest diagnosis per feed, skipping events without one', () => {
    fs.writeFileSync(
      file,
      line({ t: 'T1', feed: 'lsst_fink', state: 'down', diagnosis: 'diagnoses/a.md' }) +
        line({ t: 'T2', feed: 'lsst_fink', state: 'quiet' }) +
        line({ t: 'T3', feed: 'lsst_fink', state: 'stalled', diagnosis: 'diagnoses/b.md' }) +
        '{"t": "T4", "feed": "tns"' + // torn line
        '\n' +
        line({ t: 'T5', feed: 'tns', state: 'ok' }),
    );
    expect(readLatestDiagnoses(file)).toEqual({
      lsst_fink: { path: 'diagnoses/b.md', t: 'T3', state: 'stalled' },
    });
  });

  it('refuses report paths that could leave the dashboard root', () => {
    fs.writeFileSync(
      file,
      line({ t: 'T', feed: 'a', state: 'down', diagnosis: '../secret.md' }) +
        line({ t: 'T', feed: 'b', state: 'down', diagnosis: '/etc/passwd' }) +
        line({ t: 'T', feed: 'c', state: 'down', diagnosis: 'x?y=<script>' }),
    );
    expect(readLatestDiagnoses(file)).toEqual({});
  });

  it('returns nothing for a missing file', () => {
    expect(readLatestDiagnoses(file)).toEqual({});
  });
});
