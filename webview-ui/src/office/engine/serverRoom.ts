import { SERVER_RACK_COLORS } from '../../constants.js';
import { TILE_SIZE } from '../types.js';

/**
 * In-office server room: pixel-art racks with live gauges, drawn in world
 * space inside renderScene's z-sorted pass. Fed by the `systemStats`
 * broadcast (see server/src/systemStats.ts). The racks of one machine stand
 * side by side as a named group: this host first, at the server-room.json
 * anchor, then each remote host GROUP_ROW_STEP tiles below the last. A remote
 * whose stats file is missing or stale is drawn as an empty OFFLINE outline.
 */

export interface SystemStatsPayload {
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  ioReadBytesPerSec: number;
  ioWriteBytesPerSec: number;
  disks: { path: string; usedBytes: number; totalBytes: number }[];
  /** Top users by usage — cpu pct is top-style (100 = one full core). */
  users?: {
    cpu: { name: string; pct: number }[];
    ram: { name: string; bytes: number }[];
  };
}

interface Drawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

// Rack geometry in world pixels — each rack is ~2 tiles wide, ~3.5 tiles tall
const RACK_W = 28;
const RACK_H = 56;
const RACK_TILES_H = 3;
// A machine's group: header line + each rack's label/value lines above the
// cabinets, which stand flush. The next group starts this many tiles below.
const GROUP_ROW_STEP = 7;
const TEXT_LINE_H = 15;
/** Racks an offline group's outline is sized for (CPU, RAM, I/O + 2 disks). */
const DEFAULT_RACK_COUNT = 5;
const UNIT_COUNT = 6;
const UNIT_H = 6;
const UNIT_STEP = 7;
const GAUGE_SEGMENTS = 8;
// IO gauge saturates at this combined read+write rate
const IO_GAUGE_MAX_BYTES_PER_SEC = 200 * 1024 * 1024;

const COLORS = SERVER_RACK_COLORS;

/** One machine's rack group; stats null = an offline remote. */
export interface ServerGroup {
  name: string;
  stats: SystemStatsPayload | null;
}

let groups: ServerGroup[] = [];
let anchor = { col: 2, row: 4 };

/** World-pixel left/bottom of server group `g` (its racks' base line). */
function groupOrigin(g: number): { x: number; bottom: number } {
  return {
    x: anchor.col * TILE_SIZE,
    bottom: (anchor.row + g * GROUP_ROW_STEP + RACK_TILES_H) * TILE_SIZE,
  };
}

/** The `systemStats` broadcast: this host's stats, its name and the remotes. */
export function setSystemStats(msg: {
  stats: SystemStatsPayload;
  name?: string;
  remotes?: ServerGroup[];
  anchor?: { col: number; row: number };
}): void {
  groups = [{ name: msg.name ?? '', stats: msg.stats }, ...(msg.remotes ?? [])];
  const a = msg.anchor;
  if (a && Number.isFinite(a.col) && Number.isFinite(a.row)) anchor = a;
}

export function getServerGroups(): readonly ServerGroup[] {
  return groups;
}

/** World-pixel rects of the clickable racks — CPU (rack 0) and RAM (rack 1)
 *  of every online group; `group` indexes getServerGroups(). */
export function clickableRackRects(): {
  group: number;
  kind: 'cpu' | 'ram';
  x: number;
  y: number;
  w: number;
  h: number;
}[] {
  return groups.flatMap((g, group) => {
    if (!g.stats) return [];
    const o = groupOrigin(group);
    return (['cpu', 'ram'] as const).map((kind, i) => ({
      group,
      kind,
      x: o.x + i * RACK_W,
      y: o.bottom - RACK_H,
      w: RACK_W,
      h: RACK_H,
    }));
  });
}

export function fmtUserBytes(n: number): string {
  return fmtBytes(n);
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

interface RackSpec {
  label: string;
  pct: number;
  value: string;
}

function buildRacks(s: SystemStatsPayload): RackSpec[] {
  const racks: RackSpec[] = [];
  racks.push({ label: 'CPU', pct: s.cpuPercent, value: `${Math.round(s.cpuPercent)}%` });
  const ramPct = s.ramTotalBytes > 0 ? (100 * s.ramUsedBytes) / s.ramTotalBytes : 0;
  racks.push({ label: 'RAM', pct: ramPct, value: fmtBytes(s.ramUsedBytes) });
  const ioTotal = s.ioReadBytesPerSec + s.ioWriteBytesPerSec;
  racks.push({
    label: 'I/O',
    pct: Math.min(100, (100 * ioTotal) / IO_GAUGE_MAX_BYTES_PER_SEC),
    value: `${fmtBytes(ioTotal)}/s`,
  });
  for (const d of s.disks) {
    const pct = d.totalBytes > 0 ? (100 * d.usedBytes) / d.totalBytes : 0;
    const name = (d.path.split('/').pop() ?? d.path).toUpperCase();
    racks.push({ label: name, pct, value: `${Math.round(pct)}%` });
  }
  return racks;
}

function drawRack(
  ctx: CanvasRenderingContext2D,
  rack: RackSpec,
  x: number,
  y: number,
  zoom: number,
  now: number,
): void {
  const px = (n: number) => n * zoom;

  // Steel cabinet: frame, 3D top face, inner cavity, bottom plinth with vents
  ctx.fillStyle = COLORS.frame;
  ctx.fillRect(x, y, px(RACK_W), px(RACK_H));
  ctx.fillStyle = COLORS.frameTop;
  ctx.fillRect(x, y, px(RACK_W), px(3));
  ctx.fillStyle = COLORS.cavity;
  ctx.fillRect(x + px(2), y + px(4), px(RACK_W - 4), px(RACK_H - 9));
  ctx.fillStyle = COLORS.plinth;
  ctx.fillRect(x + px(2), y + px(RACK_H - 5), px(RACK_W - 4), px(3));
  ctx.fillStyle = COLORS.vent;
  for (let vx = 4; vx <= RACK_W - 6; vx += 3) {
    ctx.fillRect(x + px(vx), y + px(RACK_H - 4), px(1), px(1));
  }

  // 1U servers: power LED (steady), activity LED (blinks faster under load),
  // drive-bay slots
  const blinkMs = Math.max(150, 1800 - 16 * rack.pct);
  for (let i = 0; i < UNIT_COUNT; i++) {
    const sy = y + px(6 + i * UNIT_STEP);
    const ux = x + px(3);
    ctx.fillStyle = COLORS.unitFace;
    ctx.fillRect(ux, sy, px(16), px(UNIT_H));
    ctx.fillStyle = COLORS.unitEdge;
    ctx.fillRect(ux, sy, px(16), px(1));
    ctx.fillStyle = COLORS.ledPower;
    ctx.fillRect(ux + px(1), sy + px(2), px(2), px(2));
    const phase = (now / blinkMs + i * 0.37) % 1;
    ctx.fillStyle = rack.pct > 1 && phase < 0.5 ? COLORS.ledIo : COLORS.ledIdle;
    ctx.fillRect(ux + px(4), sy + px(2), px(2), px(2));
    ctx.fillStyle = COLORS.bay;
    for (let bx = 8; bx <= 14; bx += 2) {
      ctx.fillRect(ux + px(bx), sy + px(1), px(1), px(4));
    }
  }

  // Segmented LED meter, lit bottom-up: green → amber → red
  const gx = x + px(RACK_W - 7);
  const lit = Math.ceil((GAUGE_SEGMENTS * Math.min(100, Math.max(0, rack.pct))) / 100);
  for (let i = 0; i < GAUGE_SEGMENTS; i++) {
    const sy = y + px(RACK_H - 10 - i * 6);
    if (i < lit) {
      ctx.fillStyle = i >= 7 ? COLORS.gaugeHigh : i >= 5 ? COLORS.gaugeMid : COLORS.gaugeLow;
    } else {
      ctx.fillStyle = COLORS.segOff;
    }
    ctx.fillRect(gx, sy, px(4), px(5));
  }

  // Label + value above the cabinet — light text with a hard pixel shadow
  // (the racks stand on the void backdrop, not a lit floor)
  const cx = x + px(RACK_W / 2);
  drawText(ctx, rack.label, cx, y - px(2 + TEXT_LINE_H), zoom, COLORS.text);
  drawText(ctx, rack.value, cx, y - px(2), zoom, COLORS.text);
}

/** Centered pixel text, bottom-aligned at `y`, with a hard 1px shadow. */
function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  zoom: number,
  color: string,
): void {
  const fontSize = Math.max(12, Math.round(12 * zoom));
  ctx.font = `bold ${fontSize}px 'FS Pixel Sans'`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = COLORS.textShadow;
  ctx.fillText(text, cx + zoom, y + zoom);
  ctx.fillStyle = color;
  ctx.fillText(text, cx, y);
}

/** Header over a group of `count` racks whose base line is `bottom`. */
function drawGroupHeader(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  bottom: number,
  count: number,
  zoom: number,
  color: string,
): void {
  const top = bottom - zoom * (RACK_H + 2 + 2 * TEXT_LINE_H);
  drawText(ctx, name, x + (zoom * count * RACK_W) / 2, top, zoom, color);
}

/** Shared plinth under a group's racks, so they read as one machine. */
function drawGroupBase(
  ctx: CanvasRenderingContext2D,
  x: number,
  bottom: number,
  count: number,
  zoom: number,
): void {
  ctx.fillStyle = COLORS.groupBase;
  ctx.fillRect(x - zoom * 2, bottom - zoom, zoom * (count * RACK_W + 4), zoom * 3);
}

/** An offline group: its name and OFFLINE over a dashed outline of its racks. */
function drawEmptySlot(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  bottom: number,
  count: number,
  zoom: number,
): void {
  ctx.save();
  ctx.strokeStyle = COLORS.slotOutline;
  ctx.lineWidth = zoom;
  ctx.setLineDash([3 * zoom, 3 * zoom]);
  ctx.strokeRect(
    x + zoom / 2,
    bottom - zoom * RACK_H,
    zoom * (count * RACK_W - 1),
    zoom * (RACK_H - 1),
  );
  ctx.restore();
  const cx = x + (zoom * count * RACK_W) / 2;
  drawText(ctx, name, cx, bottom - zoom * (RACK_H + 2), zoom, COLORS.slotText);
  drawText(
    ctx,
    'OFFLINE',
    cx,
    bottom - zoom * (RACK_H / 2 - TEXT_LINE_H / 2),
    zoom,
    COLORS.slotText,
  );
}

/** Push one drawable per machine group into the frame's z-sorted list. */
export function collectServerRoomDrawables(
  drawables: Drawable[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const now = performance.now();
  groups.forEach(({ name, stats }, g) => {
    const o = groupOrigin(g);
    const x = offsetX + o.x * zoom;
    const bottom = offsetY + o.bottom * zoom;
    if (!stats) {
      drawables.push({
        zY: o.bottom,
        draw: (ctx) => drawEmptySlot(ctx, name, x, bottom, DEFAULT_RACK_COUNT, zoom),
      });
      return;
    }
    const racks = buildRacks(stats);
    drawables.push({
      zY: o.bottom,
      draw: (ctx) => {
        drawGroupBase(ctx, x, bottom, racks.length, zoom);
        racks.forEach((rack, i) =>
          drawRack(ctx, rack, x + i * RACK_W * zoom, bottom - RACK_H * zoom, zoom, now),
        );
        drawGroupHeader(ctx, name, x, bottom, racks.length, zoom, COLORS.text);
      },
    });
  });
}
