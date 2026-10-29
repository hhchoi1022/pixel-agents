/**
 * The project's hosted web pages, from the `webPagesStatus` broadcast
 * (server/src/webPages.ts: ~/.pixel-agents/ports.md rows + the listener scan
 * of 8760–8780), grouped by the Area whose agents own them. Kept outside React like the rack and feed
 * snapshots; WebPagesOverlay reads it every frame.
 */

export type WebPageState = 'permanent' | 'running' | 'stopped' | 'oneoff' | 'other';

export interface WebPageLink {
  href: string;
  /** The URL as written when it held a placeholder (`<objname>`), else null. */
  template: string | null;
}

export interface WebPage {
  port: number;
  agents: string[];
  purpose: string;
  links: WebPageLink[];
  servingDir: string;
  started: string;
  /** The listening process (scanned), '' when none or not visible. */
  pid: string;
  state: WebPageState;
  statusText: string;
  /** Something is listening on the port. */
  live: boolean;
  /** The port is held by a process that isn't the registered server. */
  foreignHolder: boolean;
}

export interface WebPagesSnapshot {
  source: string | null;
  error: string | null;
  checkedAt: string | null;
  pages: WebPage[];
}

let snapshot: WebPagesSnapshot | null = null;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATES: readonly WebPageState[] = ['permanent', 'running', 'stopped', 'oneoff', 'other'];

function normalizePage(raw: Record<string, unknown>): WebPage | null {
  const port = typeof raw.port === 'number' ? raw.port : NaN;
  if (!Number.isInteger(port)) return null;
  const links = Array.isArray(raw.links) ? raw.links : [];
  return {
    port,
    agents: Array.isArray(raw.agents) ? raw.agents.filter((a) => typeof a === 'string') : [],
    purpose: str(raw.purpose),
    links: links
      .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
      .map((l) => ({
        href: str(l.href),
        template: typeof l.template === 'string' ? l.template : null,
      }))
      .filter((l) => /^https?:\/\//.test(l.href)),
    servingDir: str(raw.servingDir),
    started: str(raw.started),
    pid: str(raw.pid),
    state: STATES.includes(raw.state as WebPageState) ? (raw.state as WebPageState) : 'other',
    statusText: str(raw.statusText),
    live: raw.live === true,
    foreignHolder: raw.foreignHolder === true,
  };
}

export function setWebPages(msg: {
  source?: unknown;
  error?: unknown;
  checkedAt?: unknown;
  pages?: unknown;
}): void {
  const pages = Array.isArray(msg.pages) ? msg.pages : [];
  snapshot = {
    source: typeof msg.source === 'string' ? msg.source : null,
    error: typeof msg.error === 'string' ? msg.error : null,
    checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : null,
    pages: pages
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map(normalizePage)
      .filter((p): p is WebPage => p !== null),
  };
}

export function getWebPages(): WebPagesSnapshot | null {
  return snapshot;
}

/** A project's own page: its first registered (not one-off, not retired)
 *  row whose 담당 names the project's Directory. null when it has none. */
export function projectWebPage(projectName: string | null): WebPage | null {
  if (!snapshot || projectName === null) return null;
  const name = projectName.toLowerCase();
  return (
    snapshot.pages.find(
      (p) =>
        p.state !== 'oneoff' &&
        p.state !== 'stopped' &&
        p.links.length > 0 &&
        p.agents.some((a) => a.toLowerCase() === name),
    ) ?? null
  );
}

/** Leading alphanumeric run, lower-cased: "ngsf-7dt_developer" → "ngsf". */
const stem = (name: string) => /^[a-z0-9]+/.exec(name.toLowerCase())?.[0] ?? '';

/**
 * The Area that owns a page: the first agent whose name stem matches an Area
 * label's stem (ezphot-viz → ezphot, bridge-ops → bridge, ngsf-qa →
 * ngsf-7dt). null when no Area claims any of its agents.
 */
export function areaForPage(page: WebPage, areaLabels: readonly string[]): string | null {
  for (const agent of page.agents) {
    const s = stem(agent);
    if (!s) continue;
    const label = areaLabels.find((l) => stem(l) === s);
    if (label) return label;
  }
  return null;
}

/** The registry and reality disagree: recorded up but not answering, or
 *  recorded stopped yet something is listening on the port. */
export function pageMismatch(page: WebPage): string | null {
  if ((page.state === 'permanent' || page.state === 'running') && !page.live) {
    return `기록은 ${page.state === 'permanent' ? '상시' : '실행 중'}인데 응답 없음`;
  }
  if (page.state === 'stopped' && page.live) {
    return '기록은 종료인데 포트가 열려 있음 (다른 프로세스?)';
  }
  return null;
}
