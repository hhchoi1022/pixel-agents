import {
  BRIDGE_FEED_STALE_COLOR,
  BRIDGE_FEED_STATE_COLORS,
  BRIDGE_YARD_COLORS,
} from '../../constants.js';
import { TILE_SIZE } from '../types.js';
import type { Rect } from './statusBoard.js';

/**
 * Alert-feed antenna yard: one receiver (dish + cabinet with a status screen)
 * per alert feed, standing on a pad, with a title line carrying the overall
 * (worst) state. Each project with an alert feed sends its own
 * `bridgeOpsStatus` broadcast (server/src/bridgeOps.ts, BRIDGE's STATUS_SCHEMA
 * `bridge-ops-status/1`); only the OPEN project's yard is drawn, in the band
 * the broadcast's anchor names (~/.pixel-agents/project-displays.json).
 * Drawn in world space inside renderScene's z-sorted pass, like the server
 * racks; BridgeFeedOverlay puts the click targets and panels over it.
 */

export const FEED_STATES = ['ok', 'quiet', 'unknown', 'stalled', 'down'] as const;
export type FeedState = (typeof FEED_STATES)[number];

/** Text glyph per state, for the DOM panels (the canvas draws pixel icons). */
export const FEED_STATE_GLYPH: Record<FeedState, string> = {
  ok: '✓',
  quiet: '◌',
  unknown: '?',
  stalled: '▲',
  down: '✕',
};

export interface BridgeFeed {
  id: string;
  label: string;
  survey: string | null;
  state: FeedState;
  reason: string;
  process: {
    script: string | null;
    alive: boolean;
    pid: number | null;
    child: string | null;
    childState: string | null;
  } | null;
  lastAlertAt: string | null;
  upstreamLatestAt: string | null;
  count24h: number;
  failed24h: number;
  hourlyCounts: number[];
  dbNewBacklog: number | null;
  dbError: string | null;
}

export interface BridgeOpsSnapshot {
  generatedAt: string | null;
  overall: FeedState;
  feeds: BridgeFeed[];
  /** The monitor stopped writing (generated_at older than 3 × interval). */
  stale: boolean;
  /** Why there is no data (missing file, schema bump, ...); null when fine. */
  error: string | null;
  /** Newest diagnosis report per feed id (from events.jsonl). */
  diagnoses: Record<string, BridgeDiagnosis>;
  /** The project's ops dashboard (diagnosis paths are relative to it). */
  dashboardUrl: string | null;
}

export interface BridgeDiagnosis {
  /** Report path relative to the dashboard URL. */
  path: string;
  /** When the triggering transition happened (UTC ISO). */
  t: string;
  /** The state the feed turned into. */
  state: string;
}

/** Latest snapshot per project (Directory name). */
const snapshots = new Map<string, BridgeOpsSnapshot>();
/** The open project's Directory name; its yard is the one shown. */
let currentProject: string | null = null;
/** Top-left tile and width (tiles) of the yard's band. */
let anchor = { col: 1, row: 16, cols: 12 };

/** Set by App whenever the open project changes. */
export function setAlertsProject(name: string | null): void {
  currentProject = name;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toState = (v: unknown): FeedState =>
  (FEED_STATES as readonly unknown[]).includes(v) ? (v as FeedState) : 'unknown';

function normalizeFeed(raw: Record<string, unknown>): BridgeFeed {
  const proc =
    typeof raw.process === 'object' && raw.process !== null
      ? (raw.process as Record<string, unknown>)
      : null;
  const hourly = Array.isArray(raw.hourly_counts) ? raw.hourly_counts : [];
  return {
    id: str(raw.id) ?? '?',
    label: str(raw.label) ?? str(raw.id) ?? '?',
    survey: str(raw.survey),
    state: toState(raw.state),
    reason: str(raw.reason) ?? '',
    process: proc && {
      script: str(proc.script),
      alive: proc.alive === true,
      pid: num(proc.pid),
      child: str(proc.child),
      childState: str(proc.child_state),
    },
    lastAlertAt: str(raw.last_alert_at),
    upstreamLatestAt: str(raw.upstream_latest_at),
    count24h: num(raw.count_24h) ?? 0,
    failed24h: num(raw.failed_24h) ?? 0,
    hourlyCounts: hourly.map((n) => num(n) ?? 0),
    dbNewBacklog: num(raw.db_new_backlog),
    dbError: str(raw.db_error),
  };
}

/** Take a `bridgeOpsStatus` broadcast. Tolerates any shape: a field it can't
 *  read falls back rather than throwing in the message handler. */
export function setBridgeOps(msg: {
  project?: unknown;
  anchor?: unknown;
  dashboardUrl?: unknown;
  status?: unknown;
  stale?: unknown;
  error?: unknown;
  diagnoses?: unknown;
}): void {
  const project = str(msg.project);
  if (!project) return;
  const a = msg.anchor as Record<string, unknown> | null | undefined;
  const col = num(a?.col);
  const row = num(a?.row);
  const cols = num(a?.cols);
  if (col !== null && row !== null && cols !== null && cols > 0) anchor = { col, row, cols };
  const status =
    typeof msg.status === 'object' && msg.status !== null
      ? (msg.status as Record<string, unknown>)
      : null;
  const feeds = Array.isArray(status?.feeds)
    ? status.feeds
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map(normalizeFeed)
    : [];
  snapshots.set(project, {
    generatedAt: str(status?.generated_at),
    overall: toState(status?.overall),
    feeds,
    stale: msg.stale === true,
    error: str(msg.error),
    diagnoses: normalizeDiagnoses(msg.diagnoses),
    dashboardUrl: str(msg.dashboardUrl),
  });
}

function normalizeDiagnoses(raw: unknown): Record<string, BridgeDiagnosis> {
  const out: Record<string, BridgeDiagnosis> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [feed, d] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof d !== 'object' || d === null) continue;
    const r = d as Record<string, unknown>;
    const path = str(r.path);
    if (path) out[feed] = { path, t: str(r.t) ?? '', state: str(r.state) ?? '' };
  }
  return out;
}

/** The project-displays band (world px) and the open project's Directory
 *  name; `top` is where a display below the alert yard starts (the band's
 *  top when the open project has no yard). Other displays share the band. */
export function projectBand(): { x: number; w: number; top: number; project: string | null } {
  const y = anchor.row * TILE_SIZE;
  return {
    x: anchor.col * TILE_SIZE,
    w: anchor.cols * TILE_SIZE,
    top: getBridgeOps() ? y + YARD_H + BAND_GAP : y,
    project: currentProject,
  };
}

/** The open project's alert snapshot; null when it has no alert feed. */
export function getBridgeOps(): BridgeOpsSnapshot | null {
  return currentProject !== null ? (snapshots.get(currentProject) ?? null) : null;
}

// ── Geometry (world px) ─────────────────────────────────────

const MAX_SLOT_W = 3 * TILE_SIZE; // one receiver per 3 tiles when there is room
const UNIT_W = 22;
const ANTENNA_H = 12;
const UNIT_H = 32; // antenna + cabinet
const TITLE_BASELINE = 10; // below the yard's top
const UNITS_TOP = 17; // feed-horn LED pokes 5 px above this
const DEFAULT_FEED_COUNT = 5;
const YARD_H = 64;
/** Space between the yard and the next display in the band. */
const BAND_GAP = 8;
const TITLE_FONT_PX = 9;
const LABEL_FONT_PX = 7;
const MIN_LABEL_FONT_PX = 5;
const ICON_SIZE = 7;

interface Yard {
  /** The band the anchor names. */
  band: Rect;
  slotW: number;
  /** World x of the first slot. */
  slotsLeft: number;
  /** World y of the receivers' bottom edge (top of the pad). */
  baseY: number;
  feedCount: number;
}

/** The yard fills the anchor's band, receivers centred in it. */
function activeYard(snap: BridgeOpsSnapshot): Yard {
  const band = {
    x: anchor.col * TILE_SIZE,
    y: anchor.row * TILE_SIZE,
    w: anchor.cols * TILE_SIZE,
    h: YARD_H,
  };
  const feedCount = snap.feeds.length || DEFAULT_FEED_COUNT;
  const slotW = Math.min(MAX_SLOT_W, Math.floor(band.w / feedCount));
  return {
    band,
    slotW,
    slotsLeft: band.x + (band.w - feedCount * slotW) / 2,
    baseY: band.y + UNITS_TOP + UNIT_H,
    feedCount,
  };
}

const unitWorldX = (yard: Yard, i: number) =>
  yard.slotsLeft + i * yard.slotW + (yard.slotW - UNIT_W) / 2;
const titleY = (yard: Yard) => yard.band.y + TITLE_BASELINE;

export type FeedHitRect = {
  /** A feed id, or 'summary' for the title line. */
  target: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** World-pixel click targets: each receiver (with its label) and the title. */
export function bridgeFeedHitRects(): FeedHitRect[] {
  const snap = getBridgeOps();
  if (!snap) return [];
  const yard = activeYard(snap);
  const rects: FeedHitRect[] = snap.feeds.map((f, i) => ({
    target: f.id,
    x: yard.slotsLeft + i * yard.slotW + 2,
    y: yard.baseY - UNIT_H - 5,
    w: yard.slotW - 4,
    h: UNIT_H + 5 + 7 + LABEL_FONT_PX + 1,
  }));
  rects.push({
    target: 'summary',
    x: yard.slotsLeft,
    y: titleY(yard) - TITLE_FONT_PX - 1,
    w: yard.feedCount * yard.slotW,
    h: TITLE_FONT_PX + 3,
  });
  return rects;
}

// ── Pixel icons (7×7, one per state) ────────────────────────

const ICONS: Record<FeedState, string[]> = {
  ok: ['.......', '......X', '.....XX', 'X...XX.', 'XX.XX..', '.XXX...', '..X....'],
  quiet: ['..X.X..', '.......', 'X.....X', '.......', 'X.....X', '.......', '..X.X..'],
  unknown: ['.XXXXX.', 'XX...XX', '....XX.', '...XX..', '...XX..', '.......', '...XX..'],
  stalled: ['...X...', '..XXX..', '..XXX..', '.XXXXX.', '.XXXXX.', 'XXXXXXX', 'XXXXXXX'],
  down: ['XX...XX', '.XX.XX.', '..XXX..', '...X...', '..XXX..', '.XX.XX.', 'XX...XX'],
};

function drawIcon(
  ctx: CanvasRenderingContext2D,
  state: FeedState,
  x: number,
  y: number,
  zoom: number,
  color: string,
): void {
  ctx.fillStyle = color;
  const rows = ICONS[state];
  for (let r = 0; r < ICON_SIZE; r++) {
    for (let c = 0; c < ICON_SIZE; c++) {
      if (rows[r][c] === 'X') ctx.fillRect(x + c * zoom, y + r * zoom, zoom, zoom);
    }
  }
}

/** Down blinks at 2 Hz so it catches the eye. */
const blinkOn = (now: number) => now % 1000 < 500;

function drawShadowedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  zoom: number,
  color: string,
): void {
  ctx.fillStyle = BRIDGE_YARD_COLORS.textShadow;
  ctx.fillText(text, x + zoom, y + zoom);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawReceiver(
  ctx: CanvasRenderingContext2D,
  feed: BridgeFeed,
  x: number,
  y: number,
  zoom: number,
  now: number,
  stale: boolean,
): void {
  const px = (n: number) => n * zoom;
  const C = BRIDGE_YARD_COLORS;

  // Dish: a shallow bowl on a mast, feed horn on top
  ctx.fillStyle = C.dish;
  ctx.fillRect(x + px(5), y, px(12), px(1));
  ctx.fillRect(x + px(4), y + px(1), px(14), px(1));
  ctx.fillStyle = C.dishShade;
  ctx.fillRect(x + px(5), y + px(2), px(12), px(1));
  ctx.fillRect(x + px(7), y + px(3), px(8), px(1));
  ctx.fillStyle = C.mast;
  ctx.fillRect(x + px(10), y + px(4), px(2), px(ANTENNA_H - 4));
  ctx.fillRect(x + px(10), y - px(3), px(2), px(3));
  // Horn LED: blinks while the feed actually received something in 24 h
  const receiving = !stale && feed.count24h > 0 && (now / 900) % 1 < 0.5;
  ctx.fillStyle = receiving ? BRIDGE_FEED_STATE_COLORS.ok : C.feedLedOff;
  ctx.fillRect(x + px(10), y - px(5), px(2), px(2));

  // Cabinet with the status screen
  const cy = y + px(ANTENNA_H);
  ctx.fillStyle = C.cabinet;
  ctx.fillRect(x, cy, px(UNIT_W), px(UNIT_H - ANTENNA_H));
  ctx.fillStyle = C.cabinetTop;
  ctx.fillRect(x, cy, px(UNIT_W), px(2));

  const state: FeedState = stale ? 'unknown' : feed.state;
  const color = stale ? BRIDGE_FEED_STALE_COLOR : BRIDGE_FEED_STATE_COLORS[feed.state];
  const sx = x + px(3);
  const sy = cy + px(4);
  const sw = UNIT_W - 6;
  const sh = 11;
  // Down inverts the whole screen on the blink — the one state that must not
  // be missed; every other state is a framed icon on a dark screen.
  const inverted = !stale && feed.state === 'down' && blinkOn(now);
  ctx.fillStyle = inverted ? color : C.screen;
  ctx.fillRect(sx, sy, px(sw), px(sh));
  if (!inverted) {
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, px(sw), px(1));
    ctx.fillRect(sx, sy + px(sh - 1), px(sw), px(1));
    ctx.fillRect(sx, sy, px(1), px(sh));
    ctx.fillRect(sx + px(sw - 1), sy, px(1), px(sh));
  }
  drawIcon(
    ctx,
    state,
    sx + px((sw - ICON_SIZE) / 2),
    sy + px((sh - ICON_SIZE) / 2),
    zoom,
    inverted ? C.screen : color,
  );
}

interface Drawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** Push the yard (pad, receivers, labels, title) into the frame's z-sorted list. */
export function collectBridgeFeedDrawables(
  drawables: Drawable[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const snap = getBridgeOps();
  if (!snap) return;
  const yard = activeYard(snap);
  const now = performance.now();
  const sx = (wx: number) => offsetX + wx * zoom;
  const sy = (wy: number) => offsetY + wy * zoom;

  drawables.push({
    zY: yard.baseY,
    draw: (ctx) => {
      const C = BRIDGE_YARD_COLORS;
      // Concrete pad under the receivers
      const padX = sx(yard.slotsLeft);
      const padW = yard.feedCount * yard.slotW * zoom;
      ctx.fillStyle = C.padTop;
      ctx.fillRect(padX, sy(yard.baseY - 2), padW, 2 * zoom);
      ctx.fillStyle = C.pad;
      ctx.fillRect(padX, sy(yard.baseY), padW, 4 * zoom);
      ctx.fillStyle = C.padEdge;
      ctx.fillRect(padX, sy(yard.baseY + 4), padW, zoom);

      snap.feeds.forEach((feed, i) => {
        drawReceiver(
          ctx,
          feed,
          sx(unitWorldX(yard, i)),
          sy(yard.baseY - UNIT_H),
          zoom,
          now,
          snap.stale,
        );
      });

      // One label per receiver under the pad, shrunk to fit its slot
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      snap.feeds.forEach((feed, i) => {
        let px = LABEL_FONT_PX;
        ctx.font = `${Math.round(px * zoom)}px 'FS Pixel Sans'`;
        while (
          px > MIN_LABEL_FONT_PX &&
          ctx.measureText(feed.label).width > (yard.slotW - 2) * zoom
        ) {
          px -= 1;
          ctx.font = `${Math.round(px * zoom)}px 'FS Pixel Sans'`;
        }
        const cx = sx(unitWorldX(yard, i) + UNIT_W / 2);
        drawShadowedText(ctx, feed.label, cx, sy(yard.baseY + 7), zoom, C.text);
      });

      // Title: icon + "ALERT FEEDS" + the overall state (or why there is none)
      const overallState: FeedState = snap.stale || snap.error ? 'unknown' : snap.overall;
      const overallColor =
        snap.stale || snap.error
          ? BRIDGE_FEED_STATE_COLORS.unknown
          : BRIDGE_FEED_STATE_COLORS[snap.overall];
      const stateText = snap.error
        ? 'NO DATA'
        : snap.stale
          ? '감시 중단'
          : snap.overall.toUpperCase();
      const head = 'ALERT FEEDS  ';
      ctx.font = `bold ${Math.round(TITLE_FONT_PX * zoom)}px 'FS Pixel Sans'`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const headW = ctx.measureText(head).width;
      const stateW = ctx.measureText(stateText).width;
      const iconW = (ICON_SIZE + 4) * zoom;
      const total = iconW + headW + stateW;
      const left = sx(yard.slotsLeft) + (yard.feedCount * yard.slotW * zoom - total) / 2;
      const baseline = sy(titleY(yard));
      const iconVisible = !(snap.overall === 'down' && !snap.stale && !snap.error) || blinkOn(now);
      if (iconVisible) {
        drawIcon(ctx, overallState, left, baseline - (ICON_SIZE + 2) * zoom, zoom, overallColor);
      }
      drawShadowedText(ctx, head, left + iconW, baseline, zoom, C.text);
      drawShadowedText(ctx, stateText, left + iconW + headW, baseline, zoom, overallColor);
    },
  });
}
