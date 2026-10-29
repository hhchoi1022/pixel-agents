import { WEB_KIOSK_COLORS } from '../../constants.js';
import { projectBand } from './bridgeFeeds.js';
import type { WebPage } from './webPages.js';
import { projectWebPage } from './webPages.js';

/**
 * The open project's web page as a kiosk in the project-displays band: a
 * screen on two legs showing the page's address, purpose and whether its
 * server is running (the port scan's PID). One per project — its first
 * permanent row in ~/.pixel-agents/ports.md — below the alert yard when the
 * project has one. Drawn in world space in the z-sorted pass;
 * ProjectWebKioskOverlay puts the link over it.
 */

const KIOSK_W = 8 * 16;
const TITLE_H = 12;
const SCREEN_H = 52;
const CHROME_H = 9;
const LEG_H = 6;
const BEZEL = 3;
const TITLE_FONT_PX = 9;
const URL_FONT_PX = 6;
const BODY_FONT_PX = 7;

interface Kiosk {
  page: WebPage;
  project: string;
  /** World px: the screen's outer box (bezel included). */
  x: number;
  y: number;
  w: number;
  h: number;
}

function activeKiosk(): Kiosk | null {
  const band = projectBand();
  const page = projectWebPage(band.project);
  if (!page || band.project === null) return null;
  const w = Math.min(KIOSK_W, band.w);
  return {
    page,
    project: band.project,
    x: band.x + (band.w - w) / 2,
    y: band.top + TITLE_H,
    w,
    h: SCREEN_H,
  };
}

/** The link the kiosk opens, and its world-pixel click target (title,
 *  screen and legs). */
export function projectWebKioskTarget(): {
  href: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
} | null {
  const k = activeKiosk();
  if (!k) return null;
  return {
    href: k.page.links[0].href,
    title: `${k.page.links[0].href} — 새 탭에서 열기`,
    x: k.x,
    y: k.y - TITLE_H,
    w: k.w,
    h: TITLE_H + k.h + LEG_H,
  };
}

/** `text` cut to `maxW` device px with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function shadowed(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  zoom: number,
  color: string,
): void {
  ctx.fillStyle = WEB_KIOSK_COLORS.textShadow;
  ctx.fillText(text, x + zoom, y + zoom);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** The status line: running with its PID, held by someone else, or down. */
function statusOf(page: WebPage): { text: string; color: string } {
  const C = WEB_KIOSK_COLORS;
  if (!page.live) return { text: '○ 꺼짐', color: C.dead };
  const pid = page.pid ? ` · pid ${page.pid}` : '';
  if (page.foreignHolder) return { text: `● 다른 프로세스${pid}`, color: C.warn };
  return { text: `● 실행 중${pid}`, color: C.live };
}

interface Drawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

export function collectProjectWebKioskDrawables(
  drawables: Drawable[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const k = activeKiosk();
  if (!k) return;
  const sx = (wx: number) => offsetX + wx * zoom;
  const sy = (wy: number) => offsetY + wy * zoom;
  const px = (n: number) => n * zoom;

  drawables.push({
    zY: k.y + k.h + LEG_H,
    draw: (ctx) => {
      const C = WEB_KIOSK_COLORS;
      const x = sx(k.x);
      const y = sy(k.y);
      const w = px(k.w);

      // Legs, then the bezel
      ctx.fillStyle = C.leg;
      ctx.fillRect(x + px(12), y + px(k.h), px(3), px(LEG_H));
      ctx.fillRect(x + w - px(15), y + px(k.h), px(3), px(LEG_H));
      ctx.fillStyle = C.bezel;
      ctx.fillRect(x, y, w, px(k.h));
      ctx.fillStyle = C.bezelTop;
      ctx.fillRect(x, y, w, px(2));
      ctx.fillStyle = C.bezelEdge;
      ctx.fillRect(x, y + px(k.h - 1), w, px(1));

      // Browser chrome: three dots and the address
      const ix = x + px(BEZEL);
      const iw = w - px(2 * BEZEL);
      const cy = y + px(BEZEL);
      ctx.fillStyle = C.chrome;
      ctx.fillRect(ix, cy, iw, px(CHROME_H));
      ctx.fillStyle = C.dot;
      for (let i = 0; i < 3; i++) ctx.fillRect(ix + px(3 + i * 4), cy + px(3), px(2), px(2));
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(URL_FONT_PX * zoom)}px 'FS Pixel Sans'`;
      const url = k.page.links[0].href.replace(/^https?:\/\//, '');
      ctx.fillStyle = C.url;
      ctx.fillText(fit(ctx, url, iw - px(18)), ix + px(16), cy + px(CHROME_H / 2 + 0.5));

      // Page body: purpose, then the server's state
      const by = cy + px(CHROME_H);
      const bh = px(k.h - 2 * BEZEL - CHROME_H);
      ctx.fillStyle = C.screen;
      ctx.fillRect(ix, by, iw, bh);
      ctx.textBaseline = 'top';
      ctx.font = `${Math.round(BODY_FONT_PX * zoom)}px 'FS Pixel Sans'`;
      ctx.fillStyle = C.text;
      ctx.fillText(
        fit(ctx, k.page.purpose || `:${k.page.port}`, iw - px(8)),
        ix + px(4),
        by + px(5),
      );
      ctx.fillStyle = C.muted;
      ctx.fillText(`:${k.page.port}`, ix + px(4), by + px(16));
      const status = statusOf(k.page);
      ctx.fillStyle = status.color;
      ctx.fillText(fit(ctx, status.text, iw - px(8)), ix + px(4), by + px(28));

      // Title over the screen
      ctx.font = `bold ${Math.round(TITLE_FONT_PX * zoom)}px 'FS Pixel Sans'`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      shadowed(ctx, `WEB  ${k.project}  ↗`, x + w / 2, y - px(2), zoom, C.text);
    },
  });
}
