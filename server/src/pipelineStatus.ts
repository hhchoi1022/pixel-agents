import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import {
  LAYOUT_FILE_DIR,
  NGSF_FIT_HEAD_BYTES,
  NGSF_SECURE_MARGIN,
  NGSF_SECURE_TYPES,
  PIPELINE_SOURCES_FILE,
  PIPELINE_STATUS_BROADCAST_MS,
  PIPELINE_STATUS_RECENT_DAYS,
  PIPELINE_STATUS_SCAN_MS,
} from './constants.js';

/**
 * The newest result of each pipeline stage for the in-office status board:
 * ezphot photometry runs, NGSF-7DT classification fits, and BRIDGE's
 * processed targets. Every source is another agent's output folder, so this
 * module only reads — and it reads the same files those agents' own status
 * pages read (ezphot.recipes.status, NGSF's classify/status.py), so the board
 * and the pages agree. Broadcast as `pipelineStatus`.
 */

export interface LiveProcess {
  argv: string[];
  cwd: string;
}

/** argv + cwd of every process we can read (others' are skipped). */
export function listProcesses(procRoot = '/proc'): LiveProcess[] {
  const out: LiveProcess[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = fs.readFileSync(path.join(procRoot, name, 'cmdline'), 'utf-8');
      if (!raw) continue;
      const argv = raw.split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
      out.push({ argv, cwd: fs.readlinkSync(path.join(procRoot, name, 'cwd')) });
    } catch {
      /* exited, or not ours to read */
    }
  }
  return out;
}

/** `~/x` and relative paths resolved the way the process saw them. */
function resolveArg(cwd: string, p: string): string {
  const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  const abs = path.resolve(cwd, expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function mtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// ── ezphot ──────────────────────────────────────────────────

export type EzphotRunState = 'running' | 'done' | 'stopped' | 'unreadable';

export interface EzphotLatest {
  objname: string;
  /** process_images_<tag>.{csv,log} */
  tag: string;
  state: EzphotRunState;
  nImages: number | null;
  nSucceeded: number | null;
  seconds: number | null;
  updatedAt: string;
  /** The object has a viz gallery page. */
  gallery: boolean;
}

/** {resolved --out csv: --paths count or null} of live process_images runs. */
function ezphotRunningOuts(procs: LiveProcess[]): Map<string, number | null> {
  const outs = new Map<string, number | null>();
  for (const { argv, cwd } of procs) {
    if (!argv.includes('ezphot.recipes.process_images')) continue;
    let out = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
    const i = argv.indexOf('--out');
    if (out === undefined && i >= 0 && i < argv.length - 1) out = argv[i + 1];
    if (!out) continue;
    let nPaths: number | null = null;
    const p = argv.indexOf('--paths');
    if (p >= 0) {
      const rest = argv.slice(p + 1);
      const end = rest.findIndex((a) => a.startsWith('--') || a === '');
      nPaths = end < 0 ? rest.length : end;
    }
    outs.set(resolveArg(cwd, out), nPaths);
  }
  return outs;
}

/** Rows and succeeded rows of a process_images summary csv. */
function readEzphotCsv(csv: string): { n: number; ok: number } {
  const lines = fs
    .readFileSync(csv, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
  const header = (lines[0] ?? '').split(',');
  const col = header.indexOf('success');
  if (col < 0) throw new Error('no success column');
  const rows = lines.slice(1);
  // Paths come first and hold no commas, so the column index holds.
  const ok = rows.filter((r) => r.split(',')[col] === 'True').length;
  return { n: rows.length, ok };
}

export function readEzphotLatest(
  procs: LiveProcess[],
  logRoot: string,
  vizRoot: string | null = null,
): EzphotLatest | null {
  let best: { obj: string; stem: string; mtime: number } | null = null;
  let objs: fs.Dirent[];
  try {
    objs = fs.readdirSync(logRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const obj of objs) {
    if (!obj.isDirectory()) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(logRoot, obj.name));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^(process_images_.+)\.(csv|log)$/.exec(f);
      if (!m) continue;
      const t = mtimeMs(path.join(logRoot, obj.name, f));
      if (t !== null && (!best || t > best.mtime)) best = { obj: obj.name, stem: m[1], mtime: t };
    }
  }
  if (!best) return null;

  const base = path.join(logRoot, best.obj, best.stem);
  const csv = `${base}.csv`;
  const log = `${base}.log`;
  const run: EzphotLatest = {
    objname: best.obj,
    tag: best.stem.slice('process_images_'.length),
    state: 'stopped',
    nImages: null,
    nSucceeded: null,
    seconds: null,
    updatedAt: iso(best.mtime),
    gallery:
      vizRoot !== null &&
      fs.existsSync(path.join(vizRoot, 'ezphot', best.obj, 'viz', 'index.html')),
  };
  try {
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    const n = /\[process_images\] (\d+) images\n/.exec(text);
    const ok = /\[process_images\] (\d+)\/(\d+) images succeeded in (\d+)s/.exec(text);
    if (n) run.nImages = Number(n[1]);
    if (ok) {
      run.nSucceeded = Number(ok[1]);
      run.nImages = Number(ok[2]);
      run.seconds = Number(ok[3]);
    }
    const running = ezphotRunningOuts(procs);
    const csvKey = resolveArg('/', csv);
    if (running.has(csvKey)) {
      run.state = 'running';
      // The log is block-buffered; count --paths instead.
      if (run.nImages === null) run.nImages = running.get(csvKey) ?? null;
    } else if (fs.existsSync(csv)) {
      run.state = 'done';
      const r = readEzphotCsv(csv);
      run.nImages = r.n;
      run.nSucceeded = r.ok;
    }
  } catch {
    run.state = 'unreadable';
  }
  return run;
}

// ── NGSF-7DT ────────────────────────────────────────────────

export type NgsfFitState = 'running' | 'qa' | 'done' | 'pending';

export interface NgsfLatest {
  objname: string;
  /** <objname>_epoch<N> */
  stem: string;
  state: NgsfFitState;
  type: string | null;
  subtype: string | null;
  z: number | null;
  /** chi2 ratio to the best template of the next type, minus 1. */
  margin: number | null;
  nextType: string | null;
  secure: boolean | null;
  /** QA overall: PASS / WARN / FAIL. */
  qa: string | null;
  /** accept / caveats / reject. */
  verdict: string | null;
  updatedAt: string;
}

/** {folder → stems} being fitted / QA'd by live ngsf7dt-fit and qa_report.py. */
function ngsfRunning(procs: LiveProcess[]): { fit: Set<string>; qa: Set<string> } {
  const fit = new Set<string>();
  const qa = new Set<string>();
  for (const { argv, cwd } of procs) {
    const names = argv.slice(0, 2).map((a) => path.basename(a));
    const i =
      names.indexOf('ngsf7dt-fit') >= 0
        ? names.indexOf('ngsf7dt-fit')
        : names.indexOf('qa_report.py');
    if (i < 0) continue;
    const pos = argv.slice(i + 1).find((a) => !a.startsWith('-'));
    if (!pos) continue;
    const p = resolveArg(cwd, pos);
    const key = path.join(path.dirname(p), path.basename(p).split('.')[0]);
    (names[i] === 'ngsf7dt-fit' ? fit : qa).add(key);
  }
  return { fit, qa };
}

const fitCache = new Map<
  string,
  Pick<NgsfLatest, 'type' | 'subtype' | 'z' | 'margin' | 'nextType'>
>();

/** Top-1 row of a .fit (CSV sorted by chi2) and the margin to the next type,
 *  from the file's head — the next type is almost always within a few rows. */
function readFitHead(fit: string, mtime: number) {
  const key = `${fit}:${mtime}`;
  const hit = fitCache.get(key);
  if (hit) return hit;
  const fd = fs.openSync(fit, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(NGSF_FIT_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (lines.length > 1 && !text.endsWith('\n')) lines.pop(); // cut row
  const header = lines[0].split(',');
  const col = (name: string) => header.indexOf(name);
  const [cType, cSub, cZ, cChi] = ['SN_TYPE', 'SN_SUBTYPE', 'Z', 'CHI2/dof2'].map(col);
  const rows = lines
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => l.split(','));
  const top = rows[0];
  const out = {
    type: top?.[cType] || null,
    subtype: top?.[cSub] || null,
    z: top && Number.isFinite(Number(top[cZ])) ? Number(top[cZ]) : null,
    margin: null as number | null,
    nextType: null as string | null,
  };
  if (top) {
    const next = rows.find((r) => r[cType] !== top[cType]);
    const best = Number(top[cChi]);
    if (next && best > 0) {
      out.margin = Number(next[cChi]) / best - 1;
      out.nextType = next[cType];
    }
  }
  if (fitCache.size > 64) fitCache.clear();
  fitCache.set(key, out);
  return out;
}

function readVerdict(file: string): string | null {
  try {
    const first = fs.readFileSync(file, 'utf-8').trim().split('\n')[0] ?? '';
    return /^\s*Verdict:\s*(.+)/.exec(first)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest epoch fitted in any object's main folder (variant subfolders are
 * reruns — NGSF's own status page also summarizes by the main folder). A
 * fit or QA in progress wins over finished ones.
 */
export function readNgsfLatest(
  procs: LiveProcess[],
  runsRoot: string,
  nowMs: number = Date.now(),
): NgsfLatest | null {
  const running = ngsfRunning(procs);
  let best: { folder: string; obj: string; stem: string; mtime: number; busy: boolean } | null =
    null;
  let objs: fs.Dirent[];
  try {
    objs = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const obj of objs) {
    if (!obj.isDirectory() || obj.name.startsWith('.')) continue;
    const folder = path.join(runsRoot, obj.name);
    let real = folder;
    let files: string[];
    try {
      real = fs.realpathSync(folder);
      files = fs.readdirSync(folder);
    } catch {
      continue;
    }
    const stems = new Set(files.filter((f) => f.endsWith('.fit')).map((f) => f.slice(0, -4)));
    for (const key of [...running.fit, ...running.qa]) {
      if (path.dirname(key) === real) stems.add(path.basename(key));
    }
    for (const stem of stems) {
      const busy = running.fit.has(path.join(real, stem)) || running.qa.has(path.join(real, stem));
      const times = ['.fit', '_qa.json', '_qa.html']
        .map((ext) => mtimeMs(path.join(folder, stem + ext)))
        .filter((t): t is number => t !== null);
      const mtime = times.length > 0 ? Math.max(...times) : nowMs;
      if (!best || (busy && !best.busy) || (busy === best.busy && mtime > best.mtime)) {
        best = { folder, obj: obj.name, stem, mtime, busy };
      }
    }
  }
  if (!best) return null;

  const base = path.join(best.folder, best.stem);
  const realBase = path.join(fs.realpathSync(best.folder), best.stem);
  const out: NgsfLatest = {
    objname: best.obj,
    stem: best.stem,
    state: running.fit.has(realBase) ? 'running' : running.qa.has(realBase) ? 'qa' : 'pending',
    type: null,
    subtype: null,
    z: null,
    margin: null,
    nextType: null,
    secure: null,
    qa: null,
    verdict: readVerdict(`${base}_qa_verdict.txt`),
    updatedAt: iso(best.mtime),
  };
  const fitMtime = mtimeMs(`${base}.fit`);
  if (fitMtime !== null) {
    try {
      Object.assign(out, readFitHead(`${base}.fit`, fitMtime));
      if (out.state === 'pending') out.state = 'done';
    } catch {
      /* half-written fit: leave the fields empty */
    }
  }
  if (out.type !== null) {
    out.secure =
      (NGSF_SECURE_TYPES as readonly string[]).includes(out.type) &&
      (out.margin ?? -Infinity) >= NGSF_SECURE_MARGIN;
  }
  try {
    const qa = JSON.parse(fs.readFileSync(`${base}_qa.json`, 'utf-8')) as Record<string, unknown>;
    if (typeof qa.overall === 'string') out.qa = qa.overall;
    // The QA re-fit's own margin and secure call win over our head read.
    if (typeof qa.margin_type === 'number') out.margin = qa.margin_type;
    if (typeof qa.next_type === 'string') out.nextType = qa.next_type;
    if (typeof qa.secure === 'boolean') out.secure = qa.secure;
  } catch {
    /* no QA yet */
  }
  return out;
}

// ── BRIDGE ──────────────────────────────────────────────────

export interface BridgeLatest {
  target: string;
  updatedAt: string;
  stages: {
    visibility: boolean;
    photometry: boolean;
    lightcurve: boolean;
    classification: boolean;
  };
  /** Top row of the newest classification summary. */
  classification: {
    label: string;
    type: string;
    redshift: number | null;
    /** Photometry it was fitted on (ezphot, ezphot_forced, tract7dt, ...). */
    source: string;
  } | null;
  /** Targets whose folder changed within PIPELINE_STATUS_RECENT_DAYS. */
  recentCount: number;
}

/** First data row of a `| a | b |` fixed-width table, keyed by its header. */
function readPipeTableTop(file: string): Record<string, string> | null {
  const lines = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length < 2) return null;
  const cells = (l: string) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const header = cells(lines[0]);
  const row = cells(lines[1]);
  return Object.fromEntries(header.map((h, i) => [h, row[i] ?? '']));
}

export function readBridgeLatest(
  resultsRoot: string,
  nowMs: number = Date.now(),
): BridgeLatest | null {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(resultsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  let recent = 0;
  const since = nowMs - PIPELINE_STATUS_RECENT_DAYS * 86_400_000;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const t = mtimeMs(path.join(resultsRoot, d.name));
    if (t === null) continue;
    if (t >= since) recent++;
    if (!best || t > best.mtime) best = { name: d.name, mtime: t };
  }
  if (!best) return null;

  const dir = path.join(resultsRoot, best.name);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* vanished between the scans */
  }
  const has = (re: RegExp) => entries.some((e) => re.test(e));
  const out: BridgeLatest = {
    target: best.name,
    updatedAt: iso(best.mtime),
    stages: {
      visibility: has(/_visibility\.png$/),
      photometry: has(/_(ezphot|tract7dt|py7dt)(_|$)/),
      lightcurve: has(/_LC[._]/),
      classification: has(/_CL_/),
    },
    classification: null,
    recentCount: recent,
  };
  const summaries = entries
    .filter((e) => e.endsWith('_CL_summary.ascii_fixed_width'))
    .map((e) => ({ e, t: mtimeMs(path.join(dir, e)) ?? 0 }))
    .sort((a, b) => b.t - a.t);
  if (summaries.length > 0) {
    try {
      const top = readPipeTableTop(path.join(dir, summaries[0].e));
      // <target>_<YYYYMMDD>_<HHMMSS>_<source>_CL_summary.ascii_fixed_width
      const source =
        /^.+?_\d{8}_\d{6}_(.+)_CL_summary\.ascii_fixed_width$/.exec(summaries[0].e)?.[1] ?? '';
      if (top && (top.classification || top.sn_type)) {
        const z = Number(top.redshift);
        out.classification = {
          label: top.classification || top.sn_type,
          type: top.sn_type || top.classification,
          redshift: top.redshift !== '' && Number.isFinite(z) ? z : null,
          source,
        };
      }
    } catch {
      /* unreadable summary: stages still tell the story */
    }
  }
  return out;
}

// ── Broadcast ───────────────────────────────────────────────

export interface PipelineStatusBroadcast {
  ezphot: EzphotLatest | null;
  ngsf: NgsfLatest | null;
  bridge: BridgeLatest | null;
  checkedAt: string;
}

/** This machine's source folders (~/.pixel-agents/pipeline-status.json);
 *  a folder it doesn't name is a source the board leaves empty. */
export interface PipelineSources {
  ezphotLogRoot: string | null;
  ezphotVizRoot: string | null;
  ngsfRunsRoot: string | null;
  bridgeResultsRoot: string | null;
}

export function loadPipelineSources(
  file: string = path.join(os.homedir(), LAYOUT_FILE_DIR, PIPELINE_SOURCES_FILE),
): PipelineSources {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    /* no file: every source empty */
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    ezphotLogRoot: str(raw.ezphotLogRoot),
    ezphotVizRoot: str(raw.ezphotVizRoot),
    ngsfRunsRoot: str(raw.ngsfRunsRoot),
    bridgeResultsRoot: str(raw.bridgeResultsRoot),
  };
}

export function readPipelineStatus(
  nowMs: number = Date.now(),
  sources: PipelineSources = loadPipelineSources(),
): PipelineStatusBroadcast {
  const procs = listProcesses();
  const safe = <T>(read: () => T | null): T | null => {
    try {
      return read();
    } catch (err) {
      console.warn('[Pixel Agents] pipelineStatus:', err);
      return null;
    }
  };
  return {
    ezphot: sources.ezphotLogRoot
      ? safe(() => readEzphotLatest(procs, sources.ezphotLogRoot!, sources.ezphotVizRoot))
      : null,
    ngsf: sources.ngsfRunsRoot
      ? safe(() => readNgsfLatest(procs, sources.ngsfRunsRoot!, nowMs))
      : null,
    bridge: sources.bridgeResultsRoot
      ? safe(() => readBridgeLatest(sources.bridgeResultsRoot!, nowMs))
      : null,
    checkedAt: iso(nowMs),
  };
}

/** Scan on a slow cadence, re-broadcast the last picture on a fast one so a
 *  newly opened office has it within seconds. Returns a stop function. */
export function startPipelineStatus(store: AgentStateStore): () => void {
  let latest = readPipelineStatus();
  const send = () => store.broadcast({ type: 'pipelineStatus', ...latest });
  send();
  const scan = setInterval(() => {
    latest = readPipelineStatus();
    send();
  }, PIPELINE_STATUS_SCAN_MS);
  const resend = setInterval(send, PIPELINE_STATUS_BROADCAST_MS);
  scan.unref();
  resend.unref();
  return () => {
    clearInterval(scan);
    clearInterval(resend);
  };
}
