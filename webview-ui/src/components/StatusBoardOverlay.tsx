import { useEffect, useState } from 'react';

import {
  BRIDGE_PANEL_COLORS,
  EZPHOT_VIZ_URL,
  NGSF_QA_URL,
  PIPELINE_RECENT_DAYS,
  PIPELINE_STATE_COLORS,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type {
  BridgeLatest,
  CardKey,
  EzphotLatest,
  NgsfLatest,
  PipelineSnapshot,
  PipelineTone,
} from '../office/engine/statusBoard.js';
import {
  BRIDGE_STAGES,
  bridgeState,
  ezphotState,
  fmtKst,
  fmtZ,
  getPipelineStatus,
  ngsfState,
  statusBoardGeometry,
} from '../office/engine/statusBoard.js';
import { overlayProjection } from '../office/projection.js';

/**
 * DOM overlay for the status board's pipeline cards: each card is a click
 * target opening the full picture of that stage's newest result (state,
 * counts, classification, QA, KST times) with links to the agent's own
 * pages. Follows pan/zoom every frame like the rack and feed overlays; the
 * WEB chips on the cards are WebPagesOverlay's.
 */

interface StatusBoardOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

const PANEL_WIDTH_PX = 380;
const PANEL_GAP_PX = 8;

const TITLES: Record<CardKey, string> = {
  ezphot: 'ezphot — 최근 측광',
  'ngsf-7dt': 'NGSF-7DT — 최근 분류',
  bridge: 'BRIDGE — 최근 처리 대상',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-12">
      <span
        className="shrink-0 whitespace-nowrap"
        style={{ color: BRIDGE_PANEL_COLORS.muted, width: 90 }}
      >
        {label}
      </span>
      <span className="min-w-0 break-words whitespace-normal">{children}</span>
    </div>
  );
}

function Tone({ tone, children }: { tone: PipelineTone; children: React.ReactNode }) {
  return <span style={{ color: PIPELINE_STATE_COLORS[tone], fontWeight: 'bold' }}>{children}</span>;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: BRIDGE_PANEL_COLORS.heading }}>
      {children} ↗
    </a>
  );
}

function EzphotPanel({ r }: { r: EzphotLatest }) {
  const s = ezphotState(r);
  return (
    <>
      <Row label="대상">{r.objname}</Row>
      <Row label="실행">{r.tag}</Row>
      <Row label="상태">
        <Tone tone={s.tone}>{s.text}</Tone>
      </Row>
      <Row label="이미지">
        {r.nImages === null ? '—' : `${r.nSucceeded ?? '–'}/${r.nImages} 성공`}
        {r.seconds !== null ? ` · ${r.seconds}s` : ''}
      </Row>
      <Row label="갱신">{fmtKst(r.updatedAt)}</Row>
      <div className="flex gap-12 mt-4">
        {r.gallery && (
          <Link href={`${EZPHOT_VIZ_URL}${encodeURIComponent(r.objname)}/viz/`}>그림 갤러리</Link>
        )}
        <Link href={EZPHOT_VIZ_URL}>처리 현황</Link>
      </div>
    </>
  );
}

function NgsfPanel({ r }: { r: NgsfLatest }) {
  const s = ngsfState(r);
  return (
    <>
      <Row label="대상">{r.objname}</Row>
      <Row label="epoch">{r.stem}</Row>
      <Row label="상태">
        <Tone tone={s.tone}>{s.text}</Tone>
      </Row>
      <Row label="top-1">
        {r.type ?? '—'}
        {r.subtype && r.subtype !== r.type ? ` (${r.subtype})` : ''} {fmtZ(r.z)}
      </Row>
      <Row label="margin">
        {r.margin === null ? '—' : r.margin.toFixed(2)}
        {r.nextType ? ` (다음 ${r.nextType})` : ''}
        {r.secure !== null ? ` · ${r.secure ? 'secure' : 'not secure'}` : ''}
      </Row>
      <Row label="QA · 판정">
        {r.qa ?? '—'} · {r.verdict ?? '—'}
      </Row>
      <Row label="갱신">{fmtKst(r.updatedAt)}</Row>
      <div className="flex gap-12 mt-4">
        <Link href={`${NGSF_QA_URL}${encodeURIComponent(r.objname)}/`}>대상 리포트</Link>
        <Link href={NGSF_QA_URL}>분류 현황</Link>
      </div>
    </>
  );
}

function BridgePanel({ r }: { r: BridgeLatest }) {
  const s = bridgeState(r);
  return (
    <>
      <Row label="대상">{r.target}</Row>
      <Row label="상태">
        <Tone tone={s.tone}>{s.text}</Tone>
      </Row>
      <Row label="단계">
        {BRIDGE_STAGES.map(([key, , label]) => (
          <span
            key={key}
            className="mr-8"
            style={{
              color: r.stages[key] ? PIPELINE_STATE_COLORS.good : BRIDGE_PANEL_COLORS.muted,
            }}
          >
            {r.stages[key] ? '✓' : '·'} {label}
          </span>
        ))}
      </Row>
      {r.classification && (
        <Row label="분류">
          {r.classification.label}
          {r.classification.type !== r.classification.label
            ? ` (${r.classification.type})`
            : ''}{' '}
          {fmtZ(r.classification.redshift)}
          {r.classification.source ? ` · ${r.classification.source} 측광` : ''}
        </Row>
      )}
      <Row label={`최근 ${PIPELINE_RECENT_DAYS}일`}>{r.recentCount}건 처리</Row>
      <Row label="갱신">{fmtKst(r.updatedAt)}</Row>
      <div className="text-2xs mt-4" style={{ color: BRIDGE_PANEL_COLORS.muted }}>
        ~/result/bridge/results/{r.target}/
      </div>
    </>
  );
}

function PanelBody({ cardKey, snap }: { cardKey: CardKey; snap: PipelineSnapshot | null }) {
  const none = <div style={{ color: BRIDGE_PANEL_COLORS.muted }}>결과를 찾지 못했습니다</div>;
  if (!snap) return <div style={{ color: BRIDGE_PANEL_COLORS.muted }}>수신 대기 중</div>;
  if (cardKey === 'ezphot') return snap.ezphot ? <EzphotPanel r={snap.ezphot} /> : none;
  if (cardKey === 'ngsf-7dt') return snap.ngsf ? <NgsfPanel r={snap.ngsf} /> : none;
  return snap.bridge ? <BridgePanel r={snap.bridge} /> : none;
}

export function StatusBoardOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: StatusBoardOverlayProps) {
  const [open, setOpen] = useState<CardKey | null>(null);
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
  const geom = statusBoardGeometry(officeState.tileMap);
  if (!el || !geom) return null;
  const snap = getPipelineStatus();
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );
  const openCard = geom.cards.find((c) => c.key === open);

  // Beside the card, flipped to its left when the right side would run off
  // the office; hanging down from it (the board sits at the top).
  let panelStyle: React.CSSProperties = {};
  if (openCard) {
    const r = openCard.rect;
    let left = project.toScreenX(r.x + r.w) + PANEL_GAP_PX;
    if (left + PANEL_WIDTH_PX > el.clientWidth) {
      left = Math.max(0, project.toScreenX(r.x) - PANEL_GAP_PX - PANEL_WIDTH_PX);
    }
    const top = Math.max(0, project.toScreenY(r.y));
    panelStyle = { left, top, maxHeight: el.clientHeight - top };
  }

  return (
    <>
      {geom.cards.map(({ key, rect }) => {
        const left = project.toScreenX(rect.x);
        const top = project.toScreenY(rect.y);
        return (
          <div
            key={key}
            title={`${TITLES[key]} 상세`}
            onClick={() => setOpen((cur) => (cur === key ? null : key))}
            className="absolute cursor-pointer"
            style={{
              left,
              top,
              width: project.toScreenX(rect.x + rect.w) - left,
              height: project.toScreenY(rect.y + rect.h) - top,
              zIndex: 45,
              outline: open === key ? '2px solid var(--pixel-accent)' : 'none',
            }}
          />
        );
      })}

      {openCard && (
        <div
          className="absolute pixel-panel px-12 py-8 text-sm leading-tight cursor-default overflow-y-auto"
          style={{
            ...panelStyle,
            width: PANEL_WIDTH_PX,
            zIndex: 46,
            color: BRIDGE_PANEL_COLORS.text,
          }}
        >
          <div className="flex items-center gap-10 mb-4">
            <span style={{ color: BRIDGE_PANEL_COLORS.heading, fontWeight: 'bold' }}>
              {TITLES[openCard.key]}
            </span>
            <span
              onClick={() => setOpen(null)}
              className="ml-auto cursor-pointer"
              style={{ color: BRIDGE_PANEL_COLORS.muted }}
            >
              ✕
            </span>
          </div>
          <PanelBody cardKey={openCard.key} snap={snap} />
        </div>
      )}
    </>
  );
}
