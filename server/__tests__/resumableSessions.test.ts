import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESUMABLE_SESSION_LIMIT, RESUMABLE_SESSION_TAIL_BYTES } from '../src/constants.js';
import { listResumableSessions, type ResumeProvider } from '../src/resumableSessions.js';

/**
 * The launch drawer's resume list, read off real transcripts in a temp dir:
 * which sessions are offered, in what order, and under what labels.
 */
describe('listResumableSessions', () => {
  let tempDir: string;
  /** Session dir per Directory path, as the provider would encode it. */
  let sessionDirs: Map<string, string>;
  let live: Set<string>;

  const provider: ResumeProvider = {
    getSessionDirs: (directoryPath) => {
      const dir = sessionDirs.get(directoryPath);
      return dir ? [dir] : [];
    },
    sessionFilePattern: '*.jsonl',
    getLiveSessionIds: () => live,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resume-test-'));
    sessionDirs = new Map();
    live = new Set();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function directory(name: string): { name: string; path: string } {
    const dir = path.join(tempDir, 'sessions', name);
    fs.mkdirSync(dir, { recursive: true });
    const directoryPath = path.join(tempDir, name);
    sessionDirs.set(directoryPath, dir);
    return { name, path: directoryPath };
  }

  let counter = 0;
  function session(
    dir: { path: string },
    records: Array<Record<string, unknown>>,
    mtimeSec: number,
  ): string {
    const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
    const file = path.join(sessionDirs.get(dir.path)!, `${id}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(file, mtimeSec, mtimeSec);
    return id;
  }

  const prompt = (text: unknown) => ({ type: 'user', message: { role: 'user', content: text } });

  it('offers sessions newest first, labelled by their latest name and last prompt', () => {
    const superagent = directory('superagent');
    const ezphot = directory('ezphot');
    const older = session(ezphot, [prompt('fix the WCS solver')], 1_000);
    const newer = session(
      superagent,
      [
        { type: 'custom-title', customTitle: 'old name' },
        { type: 'last-prompt', lastPrompt: 'first' },
        { type: 'custom-title', customTitle: 'proj/superagent-e89e' },
        { type: 'last-prompt', lastPrompt: '응. 진행해줘.' },
      ],
      2_000,
    );

    const sessions = listResumableSessions(provider, [superagent, ezphot], new Set());

    expect(sessions).toEqual([
      {
        sessionId: newer,
        directoryPath: superagent.path,
        directoryName: 'superagent',
        title: 'proj/superagent-e89e',
        lastPrompt: '응. 진행해줘.',
        lastActiveMs: 2_000_000,
      },
      {
        sessionId: older,
        directoryPath: ezphot.path,
        directoryName: 'ezphot',
        title: undefined,
        lastPrompt: 'fix the WCS solver',
        lastActiveMs: 1_000_000,
      },
    ]);
  });

  it('leaves out sessions held by the office or by a process elsewhere', () => {
    const dir = directory('bridge');
    const inOffice = session(dir, [prompt('a')], 3_000);
    const elsewhere = session(dir, [prompt('b')], 2_000);
    const closed = session(dir, [prompt('c')], 1_000);
    live.add(elsewhere);

    const ids = listResumableSessions(provider, [dir], new Set([inOffice])).map((s) => s.sessionId);

    expect(ids).toEqual([closed]);
  });

  it('skips untouched sessions, harness-injected text and non-session files', () => {
    const dir = directory('ngsf');
    session(dir, [{ type: 'system', subtype: 'init' }], 3_000);
    const real = session(
      dir,
      [
        prompt('<command-name>/clear</command-name>'),
        { ...prompt('caveat'), isMeta: true },
        prompt([{ type: 'tool_result', content: 'x' }]),
        prompt([{ type: 'text', text: 'classify SN 2026abc' }]),
      ],
      2_000,
    );
    fs.writeFileSync(path.join(sessionDirs.get(dir.path)!, 'notes.jsonl'), '{}\n');

    const sessions = listResumableSessions(provider, [dir], new Set());

    expect(sessions.map((s) => [s.sessionId, s.lastPrompt])).toEqual([
      [real, 'classify SN 2026abc'],
    ]);
  });

  it('reads the name from the tail of a transcript too long to read whole', () => {
    const dir = directory('big');
    const filler = { type: 'assistant', text: 'x'.repeat(RESUMABLE_SESSION_TAIL_BYTES) };
    session(
      dir,
      [prompt('early'), filler, { type: 'custom-title', customTitle: 'named late' }],
      1_000,
    );

    const [only] = listResumableSessions(provider, [dir], new Set());

    // No last-prompt in the tail: the head's first prompt stands in.
    expect(only).toMatchObject({ title: 'named late', lastPrompt: 'early' });
  });

  it(`caps the list at ${RESUMABLE_SESSION_LIMIT}, keeping the newest`, () => {
    const dir = directory('many');
    const ids = Array.from({ length: RESUMABLE_SESSION_LIMIT + 3 }, (_, i) =>
      session(dir, [prompt(`p${i}`)], 1_000 + i),
    );

    const listed = listResumableSessions(provider, [dir], new Set()).map((s) => s.sessionId);

    expect(listed).toEqual(ids.reverse().slice(0, RESUMABLE_SESSION_LIMIT));
  });
});
