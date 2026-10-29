import { useEffect, useState } from 'react';

import { WEB_PAGE_COLORS, WEB_PAGES_UNMATCHED_LABEL } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import {
  activePageCount,
  statusBoardGeometry,
  webPagesByCard,
} from '../office/engine/statusBoard.js';
import type { WebPage, WebPagesSnapshot } from '../office/engine/webPages.js';
import { getWebPages, pageMismatch } from '../office/engine/webPages.js';
import { overlayProjection } from '../office/projection.js';

/**
 * The status board's "WEB" chips (one per pipeline card, drawn on the canvas)
 * open a panel of the web pages that stage's agents host (from the project's
 * ports.md): port, purpose, links (new tab), recorded status, and whether the
 * port actually answers. Rows no card claims go under the board's "기타" chip.
 * Follows pan/zoom every frame like the rack and feed overlays.
 */

interface WebPagesOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

const PANEL_WIDTH_PX = 440;

function LiveTag({ page }: { page: WebPage }) {
  return (
    <span style={{ color: page.live ? WEB_PAGE_COLORS.live : WEB_PAGE_COLORS.dead }}>
      {page.live ? '● 응답 있음' : '○ 응답 없음'}
    </span>
  );
}

function PageCard({ page }: { page: WebPage }) {
  const mismatch = pageMismatch(page);
  return (
    <div className="py-6 border-t border-border">
      <div className="flex items-center gap-10">
        <span style={{ color: WEB_PAGE_COLORS.heading, fontWeight: 'bold' }}>:{page.port}</span>
        <LiveTag page={page} />
        <span className="ml-auto" style={{ color: WEB_PAGE_COLORS.muted }}>
          {page.statusText || '—'}
        </span>
      </div>
      {page.purpose && <div className="whitespace-normal break-words">{page.purpose}</div>}
      {page.links.map((link) => (
        <div key={link.href + (link.template ?? '')} className="whitespace-normal break-all">
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            style={{ color: WEB_PAGE_COLORS.heading }}
          >
            {link.href} ↗
          </a>
          {link.template && (
            <div className="text-2xs" style={{ color: WEB_PAGE_COLORS.muted }}>
              템플릿: {link.template}
            </div>
          )}
        </div>
      ))}
      {page.agents.length > 0 && (
        <div className="text-2xs" style={{ color: WEB_PAGE_COLORS.muted }}>
          담당: {page.agents.join(', ')}
        </div>
      )}
      {mismatch && <div style={{ color: WEB_PAGE_COLORS.warn }}>⚠ {mismatch}</div>}
    </div>
  );
}

function PagesPanel({
  title,
  pages,
  snap,
  onClose,
}: {
  title: string;
  pages: WebPage[];
  snap: WebPagesSnapshot;
  onClose: () => void;
}) {
  const [showStopped, setShowStopped] = useState(false);
  const active = pages.filter((p) => p.state !== 'stopped');
  const stopped = pages.filter((p) => p.state === 'stopped');
  return (
    <>
      <div className="flex items-center gap-10 mb-4">
        <span style={{ color: WEB_PAGE_COLORS.heading, fontWeight: 'bold' }}>
          웹페이지 — {title}
        </span>
        <span
          onClick={onClose}
          className="ml-auto cursor-pointer"
          style={{ color: WEB_PAGE_COLORS.muted }}
        >
          ✕
        </span>
      </div>
      {active.length === 0 && (
        <div style={{ color: WEB_PAGE_COLORS.muted }}>실행 중인 페이지 없음</div>
      )}
      {active.map((p) => (
        <PageCard key={`${p.port}-${p.started}`} page={p} />
      ))}
      {stopped.length > 0 && (
        <div className="pt-6 border-t border-border">
          <span
            className="cursor-pointer"
            style={{ color: WEB_PAGE_COLORS.muted }}
            onClick={() => setShowStopped((v) => !v)}
          >
            {showStopped ? '▾' : '▸'} 종료됨 {stopped.length}개
          </span>
          {showStopped && stopped.map((p) => <PageCard key={`${p.port}-${p.started}`} page={p} />)}
        </div>
      )}
      <div
        className="mt-6 text-2xs whitespace-normal break-all"
        style={{ color: WEB_PAGE_COLORS.muted }}
      >
        {snap.error ? <div style={{ color: WEB_PAGE_COLORS.warn }}>{snap.error}</div> : null}
        출처 {snap.source ?? '—'}
      </div>
    </>
  );
}

export function WebPagesOverlay({ officeState, containerRef, zoom, panRef }: WebPagesOverlayProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  const snap = getWebPages();
  const geom = statusBoardGeometry(officeState.tileMap);
  if (!el || !snap || !geom) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  // The chips themselves are drawn on the canvas (statusBoard.ts); these are
  // their click targets — one per card with pages, plus the unclaimed chip.
  const groups = webPagesByCard();
  const chips = [
    ...geom.cards.map((c) => ({ key: c.key as string, rect: c.web })),
    { key: WEB_PAGES_UNMATCHED_LABEL, rect: geom.otherWeb },
  ]
    .filter((c) => groups.has(c.key))
    .map((c) => {
      const left = project.toScreenX(c.rect.x);
      const top = project.toScreenY(c.rect.y);
      return {
        ...c,
        pages: groups.get(c.key) ?? [],
        left,
        top,
        width: project.toScreenX(c.rect.x + c.rect.w) - left,
        height: project.toScreenY(c.rect.y + c.rect.h) - top,
      };
    });
  const openChip = chips.find((c) => c.key === open);

  // Panel under its chip, or above it when the chip sits in the lower half;
  // pulled left to stay inside the office.
  let panelStyle: React.CSSProperties = {};
  if (openChip) {
    const below = openChip.top < el.clientHeight / 2;
    const top = openChip.top + openChip.height + 4;
    panelStyle = {
      left: Math.max(0, Math.min(openChip.left, el.clientWidth - PANEL_WIDTH_PX - 8)),
      ...(below
        ? { top, maxHeight: el.clientHeight - top - 8 }
        : {
            bottom: el.clientHeight - openChip.top + 4,
            maxHeight: openChip.top - 12,
          }),
    };
  }

  return (
    <>
      {chips.map((c) => (
        <div
          key={c.key}
          onClick={() => setOpen((cur) => (cur === c.key ? null : c.key))}
          title={`${c.key} 웹페이지 ${activePageCount(c.pages)}개`}
          className="absolute cursor-pointer"
          style={{
            left: c.left,
            top: c.top,
            width: c.width,
            height: c.height,
            zIndex: 47,
            outline: open === c.key ? '2px solid var(--pixel-accent)' : 'none',
          }}
        />
      ))}

      {openChip && (
        <div
          className="absolute pixel-panel px-12 py-8 text-sm leading-tight cursor-default overflow-y-auto"
          style={{ ...panelStyle, width: PANEL_WIDTH_PX, zIndex: 46, color: WEB_PAGE_COLORS.text }}
        >
          <PagesPanel
            title={openChip.key}
            pages={openChip.pages}
            snap={snap}
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </>
  );
}
