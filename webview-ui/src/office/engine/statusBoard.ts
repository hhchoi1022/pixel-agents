import {
  PIPELINE_RECENT_DAYS,
  PIPELINE_STATE_COLORS,
  STATUS_BOARD_COLORS,
  STATUS_BOARD_FLOOR,
  WEB_PAGE_COLORS,
  WEB_PAGES_UNMATCHED_LABEL,
} from '../../constants.js';
import type { TileType as TileTypeVal } from '../types.js';
import { TILE_SIZE } from '../types.js';
import type { WebPage } from './webPages.js';
import { areaForPage, getWebPages, pageMismatch } from './webPages.js';

/**
 * The status board: the FLOOR_2 zone, opposite the server room. Its top holds
 * the BRIDGE alert-feed yard (bridgeFeeds.ts), its bottom one card per
 * pipeline stage — the newest ezphot run, NGSF-7DT fit and BRIDGE target from
 * the `pipelineStatus` broadcast (server/src/pipelineStatus.ts) — each with
 * the WEB chip for the pages that stage's agents host. Drawn in world space
 * in renderScene's z-sorted pass; StatusBoardOverlay and WebPagesOverlay put
 * the click targets and panels over it.
 */

// ── Pipeline snapshot ───────────────────────────────────────

export interface EzphotLatest {
  objname: string;
  tag: string;
  state: 'running' | 'done' | 'stopped' | 'unreadable';
  nImages: number | null;
  nSucceeded: number | null;
  seconds: number | null;
  updatedAt: string;
  gallery: boolean;
}

export interface NgsfLatest {
  objname: string;
  stem: string;
  state: 'running' | 'qa' | 'done' | 'pending';
  type: string | null;
  subtype: string | null;
  z: number | null;
  margin: number | null;
  nextType: string | null;
  secure: boolean | null;
  qa: string | null;
  verdict: string | null;
  updatedAt: string;
}

export interface BridgeLatest {
  target: string;
  updatedAt: string;
  stages: {
    visibility: boolean;
    photometry: boolean;
    lightcurve: boolean;
    classification: boolean;
  };
  classification: { label: string; type: string; redshift: number | null; source: string } | null;
  recentCount: number;
}

export interface PipelineSnapshot {
  ezphot: EzphotLatest | null;
  ngsf: NgsfLatest | null;
  bridge: BridgeLatest | null;
  checkedAt: string | null;
}

let pipeline: PipelineSnapshot | null = null;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Take a `pipelineStatus` broadcast. Each stage is kept only when it carries
 *  its key field; the server already normalizes the rest. */
export function setPipelineStatus(msg: Record<string, unknown>): void {
  const ez = obj(msg.ezphot);
  const ng = obj(msg.ngsf);
  const br = obj(msg.bridge);
  pipeline = {
    ezphot: ez && typeof ez.objname === 'string' ? (ez as unknown as EzphotLatest) : null,
    ngsf: ng && typeof ng.objname === 'string' ? (ng as unknown as NgsfLatest) : null,
    bridge:
      br && typeof br.target === 'string' && obj(br.stages)
        ? (br as unknown as BridgeLatest)
        : null,
    checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : null,
  };
}

export function getPipelineStatus(): PipelineSnapshot | null {
  return pipeline;
}

export type PipelineTone = keyof typeof PIPELINE_STATE_COLORS;

/** State of a card: Korean `text` for the panels, a short English `short`
 *  for the canvas (the pixel font has no Hangul; the fallback font's taller
 *  glyphs break the card's line grid), and the tone both are coloured by. */
export interface CardState {
  text: string;
  short: string;
  tone: PipelineTone;
}

export function ezphotState(r: EzphotLatest): CardState {
  const counts = r.nImages !== null ? ` ${r.nSucceeded ?? 0}/${r.nImages}` : '';
  switch (r.state) {
    case 'running':
      return {
        text: `실행 중${r.nImages !== null ? ` (${r.nImages}장)` : ''}`,
        short: `RUNNING${r.nImages !== null ? ` ${r.nImages} img` : ''}`,
        tone: 'busy',
      };
    case 'done':
      if (r.nImages !== null && r.nSucceeded !== null && r.nSucceeded < r.nImages) {
        return {
          text: `일부 실패${counts}`,
          short: `PARTIAL${counts}`,
          tone: r.nSucceeded === 0 ? 'bad' : 'warn',
        };
      }
      return { text: `완료${counts}`, short: `DONE${counts}`, tone: 'good' };
    case 'stopped':
      return { text: '중단', short: 'STOPPED', tone: 'warn' };
    default:
      return { text: '읽기 실패', short: 'UNREADABLE', tone: 'bad' };
  }
}

export function ngsfState(r: NgsfLatest): CardState {
  if (r.state === 'running') return { text: 'fit 중', short: 'FITTING', tone: 'busy' };
  if (r.state === 'qa') return { text: 'QA 중', short: 'QA RUNNING', tone: 'busy' };
  if (r.state === 'pending') return { text: '미완료', short: 'PENDING', tone: 'idle' };
  const v = r.verdict?.toLowerCase() ?? '';
  if (v.startsWith('accept')) return { text: 'accept', short: 'ACCEPT', tone: 'good' };
  if (v.startsWith('caveat')) return { text: 'caveats', short: 'CAVEATS', tone: 'warn' };
  if (v.startsWith('reject')) return { text: 'reject', short: 'REJECT', tone: 'bad' };
  if (r.qa === 'PASS') return { text: 'QA PASS', short: 'QA PASS', tone: 'good' };
  if (r.qa === 'WARN') return { text: 'QA WARN', short: 'QA WARN', tone: 'warn' };
  if (r.qa === 'FAIL') return { text: 'QA FAIL', short: 'QA FAIL', tone: 'bad' };
  return { text: 'QA 전', short: 'NO QA', tone: 'idle' };
}

export const BRIDGE_STAGES = [
  ['visibility', 'VIS', '가시성'],
  ['photometry', 'PHOT', '측광'],
  ['lightcurve', 'LC', '광도곡선'],
  ['classification', 'CL', '분류'],
] as const;

export function bridgeState(r: BridgeLatest): CardState {
  if (r.stages.classification) return { text: '분류 완료', short: 'CLASSIFIED', tone: 'good' };
  if (r.stages.photometry || r.stages.lightcurve) {
    return { text: '측광 완료', short: 'PHOTOMETRY', tone: 'busy' };
  }
  if (r.stages.visibility) return { text: '관측 대기', short: 'AWAITING OBS', tone: 'idle' };
  return { text: '산출물 없음', short: 'NO OUTPUT', tone: 'idle' };
}

/** [minutes, hours, days] since `iso`, or null when it doesn't parse. */
function age(iso: string | null): [number, number, number] | null {
  const ms = iso ? Date.now() - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.round(ms / 60_000));
  return [min, Math.round(min / 60), Math.round(min / 1440)];
}

export function fmtAgo(iso: string | null): string {
  const a = age(iso);
  if (!a) return '—';
  if (a[0] < 60) return `${a[0]}분 전`;
  return a[1] < 48 ? `${a[1]}시간 전` : `${a[2]}일 전`;
}

/** Canvas form: "5m ago" / "11h ago" / "6d ago". */
function fmtAgoShort(iso: string | null): string {
  const a = age(iso);
  if (!a) return '—';
  if (a[0] < 60) return `${a[0]}m ago`;
  return a[1] < 48 ? `${a[1]}h ago` : `${a[2]}d ago`;
}

const kstParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "10-24 10:21 KST (3시간 전)", or "—" for a missing time. */
export function fmtKst(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const p = Object.fromEntries(kstParts.formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute} KST (${fmtAgo(iso)})`;
}

export const fmtZ = (z: number | null) => (z === null ? '' : `z=${z.toFixed(3)}`);

// ── Geometry (world px) ─────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CARD_KEYS = ['ezphot', 'ngsf-7dt', 'bridge'] as const;
export type CardKey = (typeof CARD_KEYS)[number];
const CARD_TITLES: Record<CardKey, string> = {
  ezphot: 'EZPHOT',
  'ngsf-7dt': 'NGSF-7DT',
  bridge: 'BRIDGE',
};

export interface BoardGeometry {
  zone: Rect;
  /** Top band: the alert-feed yard. */
  yard: Rect;
  cards: { key: CardKey; rect: Rect; web: Rect }[];
  /** WEB chip for pages no card claims (top-right corner of the board). */
  otherWeb: Rect;
}

const YARD_H = 64;
const MARGIN = 4;
const CARD_GAP = 4;
const CHIP_W = 26;
const CHIP_H = 9;
const LINE_PITCH = 9.5;
const HEAD_FONT_PX = 8;
const BODY_FONT_PX = 7;
const CHIP_FONT_PX = 6;

let geomCache: { tiles: unknown; geom: BoardGeometry | null } | null = null;

/**
 * Board geometry from the FLOOR_2 zone's bounding box. Repainting or moving
 * that floor moves the board; no FLOOR_2 tiles = no board. Memoized on the
 * tile map identity (rebuilt on every layout change).
 */
export function statusBoardGeometry(tileMap: TileTypeVal[][]): BoardGeometry | null {
  if (geomCache && geomCache.tiles === tileMap) return geomCache.geom;
  let minC = Infinity;
  let maxC = -1;
  let minR = Infinity;
  let maxR = -1;
  for (let r = 0; r < tileMap.length; r++) {
    const row = tileMap[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== STATUS_BOARD_FLOOR) continue;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
  }
  let geom: BoardGeometry | null = null;
  if (maxC >= 0) {
    const zone = {
      x: minC * TILE_SIZE,
      y: minR * TILE_SIZE,
      w: (maxC - minC + 1) * TILE_SIZE,
      h: (maxR - minR + 1) * TILE_SIZE,
    };
    const cardY = zone.y + YARD_H + 3;
    const cardW = (zone.w - 2 * MARGIN - (CARD_KEYS.length - 1) * CARD_GAP) / CARD_KEYS.length;
    const cardH = zone.y + zone.h - 2 - cardY;
    geom = {
      zone,
      yard: { x: zone.x + MARGIN, y: zone.y, w: zone.w - 2 * MARGIN, h: YARD_H },
      cards: CARD_KEYS.map((key, i) => {
        const rect = { x: zone.x + MARGIN + i * (cardW + CARD_GAP), y: cardY, w: cardW, h: cardH };
        return {
          key,
          rect,
          web: { x: rect.x + rect.w - CHIP_W - 2, y: rect.y + 2, w: CHIP_W, h: CHIP_H },
        };
      }),
      otherWeb: {
        x: zone.x + zone.w - MARGIN - CHIP_W - 8,
        y: zone.y + 2,
        w: CHIP_W + 8,
        h: CHIP_H,
      },
    };
  }
  geomCache = { tiles: tileMap, geom };
  return geom;
}

// ── Web pages per card ──────────────────────────────────────

/** The project's web pages grouped by the card whose agents host them;
 *  pages no card claims go under WEB_PAGES_UNMATCHED_LABEL. */
export function webPagesByCard(): Map<string, WebPage[]> {
  const groups = new Map<string, WebPage[]>();
  for (const page of getWebPages()?.pages ?? []) {
    const key = areaForPage(page, CARD_KEYS) ?? WEB_PAGES_UNMATCHED_LABEL;
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  return groups;
}

/** Chip dot: amber when any page disagrees with the registry, green when
 *  something is up, grey when nothing is meant to be. */
export function webChipColor(pages: WebPage[]): string {
  if (pages.some((p) => pageMismatch(p))) return WEB_PAGE_COLORS.warn;
  if (pages.some((p) => p.live && p.state !== 'stopped')) return WEB_PAGE_COLORS.live;
  return WEB_PAGE_COLORS.muted;
}

export const activePageCount = (pages: WebPage[]) =>
  pages.filter((p) => p.state !== 'stopped').length;

// ── Drawing ─────────────────────────────────────────────────

interface Drawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

interface CardLines {
  tone: PipelineTone;
  name: string;
  detail: string;
  /** Drawn instead of `detail` when given: [label, done] pips. */
  pips?: Array<[string, boolean]>;
  foot: string;
}

function cardLines(key: CardKey, snap: PipelineSnapshot | null): CardLines {
  const none = { tone: 'idle' as const, name: '—', detail: 'NO DATA', foot: '' };
  if (!snap) return { ...none, detail: 'WAITING' };
  if (key === 'ezphot') {
    const r = snap.ezphot;
    if (!r) return none;
    const s = ezphotState(r);
    return {
      tone: s.tone,
      name: r.objname,
      detail: s.short,
      foot: fmtAgoShort(r.updatedAt) + (r.seconds !== null ? ` · ${r.seconds}s` : ''),
    };
  }
  if (key === 'ngsf-7dt') {
    const r = snap.ngsf;
    if (!r) return none;
    const s = ngsfState(r);
    const cls = [r.subtype || r.type, fmtZ(r.z)].filter(Boolean).join(' ');
    return {
      tone: s.tone,
      name: r.objname === r.stem.split('_epoch')[0] ? r.stem : `${r.objname}/${r.stem}`,
      detail: cls || s.short,
      foot: `${s.short} · ${fmtAgoShort(r.updatedAt)}`,
    };
  }
  const r = snap.bridge;
  if (!r) return none;
  const s = bridgeState(r);
  const cls = r.classification;
  return {
    tone: s.tone,
    name: r.target,
    detail: cls ? [cls.label, fmtZ(cls.redshift)].filter(Boolean).join(' ') : s.short,
    pips: cls ? undefined : BRIDGE_STAGES.map(([k, short]) => [short, r.stages[k]]),
    foot: `${fmtAgoShort(r.updatedAt)} · ${r.recentCount} in ${PIPELINE_RECENT_DAYS}d`,
  };
}

/** Text cut with an ellipsis to fit `maxW` device px (font already set). */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  label: string,
  dot: string,
  sx: (x: number) => number,
  sy: (y: number) => number,
  zoom: number,
): void {
  const C = STATUS_BOARD_COLORS;
  ctx.fillStyle = C.chipEdge;
  ctx.fillRect(sx(r.x), sy(r.y), r.w * zoom, r.h * zoom);
  ctx.fillStyle = C.chip;
  ctx.fillRect(sx(r.x + 1), sy(r.y + 1), (r.w - 2) * zoom, (r.h - 2) * zoom);
  ctx.fillStyle = dot;
  ctx.fillRect(sx(r.x + 2.5), sy(r.y + 3), 3 * zoom, 3 * zoom);
  ctx.fillStyle = C.header;
  ctx.font = `bold ${Math.round(CHIP_FONT_PX * zoom)}px 'FS Pixel Sans'`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fitText(ctx, label, (r.w - 8) * zoom), sx(r.x + 7), sy(r.y + r.h / 2 + 0.5));
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  key: CardKey,
  rect: Rect,
  web: Rect,
  lines: CardLines,
  pages: WebPage[],
  sx: (x: number) => number,
  sy: (y: number) => number,
  zoom: number,
): void {
  const C = STATUS_BOARD_COLORS;
  const tone = PIPELINE_STATE_COLORS[lines.tone];
  // Screen with a 1 px frame and a state bar down its left edge
  ctx.fillStyle = C.cardEdge;
  ctx.fillRect(sx(rect.x), sy(rect.y), rect.w * zoom, rect.h * zoom);
  ctx.fillStyle = C.card;
  ctx.fillRect(sx(rect.x + 1), sy(rect.y + 1), (rect.w - 2) * zoom, (rect.h - 2) * zoom);
  ctx.fillStyle = tone;
  ctx.fillRect(sx(rect.x + 1), sy(rect.y + 1), 2 * zoom, (rect.h - 2) * zoom);

  const left = rect.x + 6;
  const textW = (rect.w - 8) * zoom;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.font = `bold ${Math.round(HEAD_FONT_PX * zoom)}px 'FS Pixel Sans'`;
  ctx.fillStyle = C.header;
  ctx.fillText(fitText(ctx, CARD_TITLES[key], (web.x - left - 2) * zoom), sx(left), sy(rect.y + 3));
  ctx.fillStyle = tone;
  ctx.fillText(fitText(ctx, lines.name, textW), sx(left), sy(rect.y + 3 + LINE_PITCH));

  ctx.font = `${Math.round(BODY_FONT_PX * zoom)}px 'FS Pixel Sans'`;
  const detailY = sy(rect.y + 3 + 2 * LINE_PITCH);
  if (lines.pips) {
    let x = sx(left);
    for (const [label, done] of lines.pips) {
      ctx.fillStyle = done ? PIPELINE_STATE_COLORS.good : C.muted;
      ctx.fillText(label, x, detailY);
      x += ctx.measureText(`${label} `).width;
    }
  } else {
    ctx.fillStyle = C.text;
    ctx.fillText(fitText(ctx, lines.detail, textW), sx(left), detailY);
  }
  ctx.fillStyle = C.muted;
  ctx.fillText(fitText(ctx, lines.foot, textW), sx(left), sy(rect.y + 3 + 3 * LINE_PITCH));

  if (pages.length > 0) {
    drawChip(ctx, web, `WEB ${activePageCount(pages)}`, webChipColor(pages), sx, sy, zoom);
  }
}

/** Push the pipeline cards and WEB chips into the frame's z-sorted list (the
 *  yard above them is bridgeFeeds.ts). */
export function collectStatusBoardDrawables(
  drawables: Drawable[],
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const geom = statusBoardGeometry(tileMap);
  if (!geom) return;
  const snap = pipeline;
  const sx = (wx: number) => offsetX + wx * zoom;
  const sy = (wy: number) => offsetY + wy * zoom;
  // Dark board over the zone's floor, under the yard and the cards
  const z = geom.zone;
  drawables.push({
    zY: z.y,
    draw: (ctx) => {
      const C = STATUS_BOARD_COLORS;
      ctx.fillStyle = C.boardEdge;
      ctx.fillRect(sx(z.x + 1), sy(z.y + 1), (z.w - 2) * zoom, (z.h - 2) * zoom);
      ctx.fillStyle = C.board;
      ctx.fillRect(sx(z.x + 2), sy(z.y + 2), (z.w - 4) * zoom, (z.h - 4) * zoom);
    },
  });
  drawables.push({
    zY: geom.zone.y + geom.zone.h,
    draw: (ctx) => {
      const groups = webPagesByCard();
      for (const { key, rect, web } of geom.cards) {
        drawCard(ctx, key, rect, web, cardLines(key, snap), groups.get(key) ?? [], sx, sy, zoom);
      }
      const other = groups.get(WEB_PAGES_UNMATCHED_LABEL);
      if (other) {
        drawChip(
          ctx,
          geom.otherWeb,
          `WEB ${WEB_PAGES_UNMATCHED_LABEL} ${activePageCount(other)}`,
          webChipColor(other),
          sx,
          sy,
          zoom,
        );
      }
    },
  });
}
