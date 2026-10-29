import { useEffect, useState } from 'react';

import {
  BRIDGE_DIAGNOSIS_WRITING_MS,
  BRIDGE_FEED_STALE_COLOR,
  BRIDGE_FEED_STATE_COLORS,
  BRIDGE_PANEL_COLORS,
} from '../constants.js';
import type {
  BridgeDiagnosis,
  BridgeFeed,
  BridgeOpsSnapshot,
  FeedState,
} from '../office/engine/bridgeFeeds.js';
import {
  bridgeFeedHitRects,
  FEED_STATE_GLYPH,
  getBridgeOps,
} from '../office/engine/bridgeFeeds.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { fmtKst } from '../office/engine/statusBoard.js';
import { overlayProjection } from '../office/projection.js';

/**
 * DOM overlay for the open project's antenna yard: each receiver is a click target
 * that opens its feed's panel (reason, last / upstream-latest times in KST,
 * 24 h hourly bars, process state), and the title opens a one-line-per-feed
 * summary. Follows pan/zoom every frame like ServerRackOverlay.
 */

interface BridgeFeedOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

const PANEL_WIDTH_PX = 360;
const SUMMARY_WIDTH_PX = 560;
const PANEL_GAP_PX = 8;
const BAR_AREA_HEIGHT_PX = 36;

/** Whether an ISO time is within `windowMs` of now (false when unparseable).
 *  Like fmtKst, wall-clock-relative by design: the overlay re-renders every
 *  frame, so the answer tracks the clock. */
function isRecent(iso: string, windowMs: number): boolean {
  const ageMs = Date.now() - Date.parse(iso);
  return Number.isFinite(ageMs) && ageMs < windowMs;
}

function stateColor(state: FeedState, stale: boolean): string {
  return stale ? BRIDGE_FEED_STALE_COLOR : BRIDGE_FEED_STATE_COLORS[state];
}

function StateTag({ state, stale }: { state: FeedState; stale: boolean }) {
  return (
    <span style={{ color: stateColor(state, stale), fontWeight: 'bold' }}>
      {FEED_STATE_GLYPH[state]} {state.toUpperCase()}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-12">
      <span
        className="shrink-0 whitespace-nowrap"
        style={{ color: BRIDGE_PANEL_COLORS.muted, width: 120 }}
      >
        {label}
      </span>
      <span className="min-w-0 break-words whitespace-normal">{children}</span>
    </div>
  );
}

function HourlyBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <div>
      <div className="flex items-end gap-1" style={{ height: BAR_AREA_HEIGHT_PX }}>
        {counts.map((n, i) => (
          <div
            key={i}
            title={`${counts.length - i}시간 전 구간: ${n}건`}
            className="flex-1"
            style={{
              height: n > 0 ? Math.max(2, (BAR_AREA_HEIGHT_PX * n) / max) : 2,
              background: n > 0 ? BRIDGE_PANEL_COLORS.bar : BRIDGE_PANEL_COLORS.barEmpty,
            }}
          />
        ))}
      </div>
      <div className="flex justify-between text-2xs" style={{ color: BRIDGE_PANEL_COLORS.muted }}>
        <span>-24h</span>
        <span>max {max}/h</span>
        <span>now</span>
      </div>
    </div>
  );
}

function processText(feed: BridgeFeed): string {
  const p = feed.process;
  if (!p) return '—';
  const main = `${p.script ?? '?'} ${p.alive ? `실행 중 (pid ${p.pid ?? '?'})` : '중단됨'}`;
  return p.child ? `${main} · ${p.child}: ${p.childState ?? '?'}` : main;
}

function Footer({ snap }: { snap: BridgeOpsSnapshot }) {
  return (
    <div className="mt-6 text-2xs" style={{ color: BRIDGE_PANEL_COLORS.muted }}>
      {snap.stale && !snap.error && (
        <div style={{ color: BRIDGE_FEED_STATE_COLORS.unknown }}>
          감시 중단: 상태가 30분 넘게 갱신되지 않음 (감시 프로세스 확인 필요)
        </div>
      )}
      {snap.error && <div style={{ color: BRIDGE_FEED_STATE_COLORS.unknown }}>{snap.error}</div>}
      <div>갱신 {fmtKst(snap.generatedAt)}</div>
      {snap.dashboardUrl && (
        <a
          href={snap.dashboardUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: BRIDGE_PANEL_COLORS.heading }}
        >
          상세 대시보드 ↗
        </a>
      )}
    </div>
  );
}

/** Link to the feed's newest diagnosis report. The diagnosing agent keeps
 *  appending to it for a while after the transition, so a young report is
 *  flagged as possibly still being written. */
function DiagnosisRow({
  diagnosis,
  dashboardUrl,
}: {
  diagnosis: BridgeDiagnosis;
  dashboardUrl: string;
}) {
  const maybeWriting = isRecent(diagnosis.t, BRIDGE_DIAGNOSIS_WRITING_MS);
  return (
    <Row label="진단">
      <a
        href={dashboardUrl + diagnosis.path}
        target="_blank"
        rel="noreferrer"
        style={{ color: BRIDGE_PANEL_COLORS.heading }}
      >
        보고서 ↗
      </a>{' '}
      <span style={{ color: BRIDGE_PANEL_COLORS.muted }}>
        ({diagnosis.state || '?'} · {fmtKst(diagnosis.t || null)})
      </span>
      {maybeWriting && (
        <div className="text-2xs" style={{ color: BRIDGE_FEED_STATE_COLORS.unknown }}>
          작성 중일 수 있음
        </div>
      )}
    </Row>
  );
}

function FeedPanel({ feed, snap }: { feed: BridgeFeed; snap: BridgeOpsSnapshot }) {
  return (
    <>
      <Row label="사유">{feed.reason || '—'}</Row>
      <Row label="마지막 수신">{fmtKst(feed.lastAlertAt)}</Row>
      <Row label="상류 최신">{fmtKst(feed.upstreamLatestAt)}</Row>
      <Row label="24시간">
        {feed.count24h}건{feed.failed24h > 0 ? ` (실패 ${feed.failed24h})` : ''}
      </Row>
      {feed.hourlyCounts.length > 0 && <HourlyBars counts={feed.hourlyCounts} />}
      <Row label="프로세스">{processText(feed)}</Row>
      <Row label="DB">
        {feed.dbError ?? (feed.dbNewBacklog !== null ? `미처리 ${feed.dbNewBacklog}건` : '—')}
      </Row>
      {snap.diagnoses[feed.id] && snap.dashboardUrl && (
        <DiagnosisRow diagnosis={snap.diagnoses[feed.id]} dashboardUrl={snap.dashboardUrl} />
      )}
      <Footer snap={snap} />
    </>
  );
}

function SummaryPanel({ snap }: { snap: BridgeOpsSnapshot }) {
  return (
    <>
      {snap.feeds.map((f) => (
        <div key={f.id} className="flex gap-12">
          <span className="shrink-0" style={{ width: 130 }}>
            <StateTag state={f.state} stale={snap.stale} />
          </span>
          <span className="shrink-0" style={{ width: 120 }}>
            {f.label}
          </span>
          <span
            className="min-w-0 overflow-hidden text-ellipsis"
            style={{ color: BRIDGE_PANEL_COLORS.muted }}
            title={f.reason}
          >
            {f.reason}
          </span>
        </div>
      ))}
      <Footer snap={snap} />
    </>
  );
}

export function BridgeFeedOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: BridgeFeedOverlayProps) {
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
  const snap = getBridgeOps();
  if (!el || !snap) return null;
  const layout = officeState.getLayout();
  const project = overlayProjection(
    layout,
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );
  const rects = bridgeFeedHitRects();
  const openRect = rects.find((r) => r.target === open);
  const openFeed = snap.feeds.find((f) => f.id === open);

  // Beside the clicked target; flipped to its left when the right side would
  // run off the office.
  const panelWidth = open === 'summary' ? SUMMARY_WIDTH_PX : PANEL_WIDTH_PX;
  let panelLeft = 0;
  // Vertical: hang down from a target in the upper half, grow up from one in
  // the lower half, so the panel stays on screen.
  let panelVertical: React.CSSProperties = {};
  if (openRect) {
    panelLeft = project.toScreenX(openRect.x + openRect.w) + PANEL_GAP_PX;
    if (panelLeft + panelWidth > el.clientWidth) {
      panelLeft = Math.max(0, project.toScreenX(openRect.x) - PANEL_GAP_PX - panelWidth);
    }
    const targetTop = project.toScreenY(openRect.y);
    const targetBottom = project.toScreenY(openRect.y + openRect.h);
    panelVertical =
      targetTop < el.clientHeight / 2
        ? { top: Math.max(0, targetTop), maxHeight: el.clientHeight - Math.max(0, targetTop) }
        : {
            bottom: Math.max(0, el.clientHeight - targetBottom),
            maxHeight: Math.min(el.clientHeight, targetBottom),
          };
  }

  const title = open === 'summary' ? 'ALERT FEEDS' : openFeed ? openFeed.label : '';
  const titleState: FeedState | null =
    open === 'summary' ? (snap.error ? null : snap.overall) : (openFeed?.state ?? null);

  return (
    <>
      {rects.map((r) => {
        const left = project.toScreenX(r.x);
        const top = project.toScreenY(r.y);
        return (
          <div
            key={r.target}
            title={r.target === 'summary' ? 'Alert feed 전체 상태' : `${r.target} 상세`}
            onClick={() => setOpen((cur) => (cur === r.target ? null : r.target))}
            className="absolute cursor-pointer"
            style={{
              left,
              top,
              width: project.toScreenX(r.x + r.w) - left,
              height: project.toScreenY(r.y + r.h) - top,
              zIndex: 45,
              outline: open === r.target ? '2px solid var(--pixel-accent)' : 'none',
            }}
          />
        );
      })}

      {openRect && (open === 'summary' || openFeed) && (
        <div
          className="absolute pixel-panel px-12 py-8 text-sm leading-tight cursor-default"
          style={{
            left: panelLeft,
            ...panelVertical,
            overflowY: 'auto',
            width: panelWidth,
            zIndex: 46,
            color: BRIDGE_PANEL_COLORS.text,
          }}
        >
          <div className="flex items-center gap-10 mb-4">
            <span style={{ color: BRIDGE_PANEL_COLORS.heading, fontWeight: 'bold' }}>{title}</span>
            {titleState && <StateTag state={titleState} stale={snap.stale} />}
            <span
              onClick={() => setOpen(null)}
              className="ml-auto cursor-pointer"
              style={{ color: BRIDGE_PANEL_COLORS.muted }}
            >
              ✕
            </span>
          </div>
          {open === 'summary' ? (
            <SummaryPanel snap={snap} />
          ) : (
            openFeed && <FeedPanel feed={openFeed} snap={snap} />
          )}
        </div>
      )}
    </>
  );
}
