/**
 * Sessions the launch drawer can resume.
 *
 * Closing an agent's terminal ends its process but not its session: the
 * transcript stays on disk, and `--resume <id>` picks the conversation up where
 * it stopped. So the office asks (`requestResumableSessions`) and the host
 * answers with the sessions that ran in one of the Directories, newest first,
 * minus every session a process still holds -- an agent in the office, or a CLI
 * running in some other terminal. Resuming one of those would put two
 * processes on one transcript.
 *
 * Enumeration goes through the provider's file-fallback surface
 * (`getSessionDirs` + `sessionFilePattern`), and liveness through its
 * `getLiveSessionIds`. The labels -- the session's name and its last prompt --
 * are read from Claude's own transcript records; a transcript that records
 * neither falls back to its first prompt, and one with no prompt at all (a
 * session opened and closed untouched) is not worth offering.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import {
  RESUMABLE_SESSION_HEAD_BYTES,
  RESUMABLE_SESSION_LIMIT,
  RESUMABLE_SESSION_PROMPT_MAX_CHARS,
  RESUMABLE_SESSION_TAIL_BYTES,
} from './constants.js';

export type ResumeProvider = Pick<
  HookProvider,
  'getSessionDirs' | 'sessionFilePattern' | 'getLiveSessionIds'
>;

export interface ResumableSession {
  sessionId: string;
  directoryPath: string;
  directoryName: string;
  title?: string;
  lastPrompt?: string;
  lastActiveMs: number;
}

/** Session ids are UUIDs; anything else in a session directory isn't one. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/**
 * Resumable sessions across `directories`, most recently written first, capped
 * at `RESUMABLE_SESSION_LIMIT`. `officeSessionIds` are the sessions the office
 * already tracks; the provider adds the ones running anywhere else. Every
 * failure is "not offered": nothing here may throw into the message dispatch.
 */
export function listResumableSessions(
  provider: ResumeProvider,
  directories: ReadonlyArray<{ name: string; path: string }>,
  officeSessionIds: ReadonlySet<string>,
): ResumableSession[] {
  const live = new Set([...officeSessionIds, ...(provider.getLiveSessionIds?.() ?? [])]);
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  const seen = new Set<string>();
  const candidates: Array<{
    file: string;
    sessionId: string;
    directory: { name: string; path: string };
    mtimeMs: number;
  }> = [];

  for (const directory of directories) {
    for (const sessionDir of provider.getSessionDirs?.(directory.path) ?? []) {
      let entries: string[];
      try {
        entries = fs.readdirSync(sessionDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(suffix)) continue;
        const sessionId = entry.slice(0, entry.length - suffix.length);
        if (!isSessionId(sessionId) || live.has(sessionId) || seen.has(sessionId)) continue;
        const file = path.join(sessionDir, entry);
        let mtimeMs: number;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          mtimeMs = stat.mtimeMs;
        } catch {
          continue;
        }
        seen.add(sessionId);
        candidates.push({ file, sessionId, directory, mtimeMs });
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions: ResumableSession[] = [];
  // Labels cost two reads each, so only as many candidates are read as it
  // takes to fill the list.
  for (const candidate of candidates) {
    if (sessions.length >= RESUMABLE_SESSION_LIMIT) break;
    const labels = readSessionLabels(candidate.file);
    if (labels === undefined) continue;
    sessions.push({
      sessionId: candidate.sessionId,
      directoryPath: candidate.directory.path,
      directoryName: candidate.directory.name,
      ...labels,
      lastActiveMs: candidate.mtimeMs,
    });
  }
  return sessions;
}

/**
 * The session's name and last prompt from the transcript's tail, the newest
 * record of each winning. Without a last prompt, the first one from the head
 * stands in. undefined when the transcript has no prompt at all.
 */
export function readSessionLabels(
  file: string,
): { title?: string; lastPrompt?: string } | undefined {
  let title: string | undefined;
  let lastPrompt: string | undefined;
  for (const record of readRecords(file, 'tail', RESUMABLE_SESSION_TAIL_BYTES)) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      title = record.customTitle;
    } else if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') {
      lastPrompt = record.lastPrompt;
    }
  }
  if (lastPrompt === undefined) {
    for (const record of readRecords(file, 'head', RESUMABLE_SESSION_HEAD_BYTES)) {
      const prompt = promptText(record);
      if (prompt !== undefined) {
        lastPrompt = prompt;
        break;
      }
    }
  }
  if (lastPrompt === undefined) return undefined;
  return { title, lastPrompt: clip(lastPrompt) };
}

/** A user record's typed prompt; undefined for tool results, slash-command
 *  echoes and other harness-injected text. */
function promptText(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) {
    return undefined;
  }
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find(
            (block): block is { type: 'text'; text: string } =>
              (block as { type?: unknown }).type === 'text' &&
              typeof (block as { text?: unknown }).text === 'string',
          )?.text ?? undefined)
        : undefined;
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed.length === 0 || trimmed.startsWith('<') ? undefined : trimmed;
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > RESUMABLE_SESSION_PROMPT_MAX_CHARS
    ? `${oneLine.slice(0, RESUMABLE_SESSION_PROMPT_MAX_CHARS - 1)}…`
    : oneLine;
}

/** Parse the whole JSON lines inside one end of a file. A slice that doesn't
 *  reach the file's other end cuts a line in half there, and that fragment is
 *  dropped rather than parsed. */
function readRecords(
  file: string,
  end: 'head' | 'tail',
  maxBytes: number,
): Array<Record<string, unknown>> {
  let text: string;
  let partial: boolean;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, end === 'head' ? 0 : size - length);
      text = buf.toString('utf-8');
      partial = length < size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = text.split('\n');
  if (partial) {
    if (end === 'head') lines.pop();
    else lines.shift();
  }
  const records: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (record !== null && typeof record === 'object') {
        records.push(record as Record<string, unknown>);
      }
    } catch {
      // Mid-write or malformed line: skip it.
    }
  }
  return records;
}

/** `'*.jsonl'` → `'.jsonl'`; no pattern matches every file. */
function transcriptSuffix(pattern: string | undefined): string {
  if (pattern === undefined) return '';
  return pattern.startsWith('*') ? pattern.slice(1) : pattern;
}
