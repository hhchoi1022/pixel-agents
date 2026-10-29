import { useEffect, useState } from 'react';

import { SERVER_RACK_PANEL_COLORS } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { clickableRackRects, fmtUserBytes, getServerGroups } from '../office/engine/serverRoom.js';
import { overlayProjection } from '../office/projection.js';

/**
 * DOM overlay for the server-room racks: every online machine's CPU and RAM
 * cabinets are click targets, and the open one expands into a per-user usage
 * panel for that machine (sorted by usage, top consumers first). Lives in the DOM like ToolOverlay so it can
 * out-paint the canvas and keep text crisp.
 */

interface ServerRackOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 46,
  background: SERVER_RACK_PANEL_COLORS.bg,
  color: SERVER_RACK_PANEL_COLORS.text,
  border: `3px solid ${SERVER_RACK_PANEL_COLORS.border}`,
  boxShadow: 'var(--pixel-shadow)',
  padding: '10px 14px',
  fontSize: '22px',
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
  pointerEvents: 'auto',
  cursor: 'default',
};

export function ServerRackOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: ServerRackOverlayProps) {
  const [open, setOpen] = useState<{ group: number; kind: 'cpu' | 'ram' } | null>(null);
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
  if (!el) return null;
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const groups = getServerGroups();
  const racks = clickableRackRects();
  if (racks.length === 0) return null;

  const isOpen = (r: { group: number; kind: string }) =>
    open !== null && open.group === r.group && open.kind === r.kind;
  const openRack = racks.find(isOpen);
  const openGroup = openRack ? groups[openRack.group] : undefined;
  const users = openGroup?.stats?.users;
  const rows =
    openRack?.kind === 'cpu'
      ? (users?.cpu ?? []).map((u) => ({ name: u.name, value: `${u.pct.toFixed(1)}%` }))
      : openRack?.kind === 'ram'
        ? (users?.ram ?? []).map((u) => ({ name: u.name, value: fmtUserBytes(u.bytes) }))
        : [];

  return (
    <>
      {racks.map((r) => {
        const left = project.toScreenX(r.x);
        const top = project.toScreenY(r.y);
        const w = project.toScreenX(r.x + r.w) - left;
        const h = project.toScreenY(r.y + r.h) - top;
        return (
          <div
            key={`${r.group}:${r.kind}`}
            title={`${groups[r.group]?.name ?? ''} ${r.kind.toUpperCase()} 사용량 상위 유저 보기`}
            onClick={() =>
              setOpen((cur) => (cur && isOpen(r) ? null : { group: r.group, kind: r.kind }))
            }
            style={{
              position: 'absolute',
              left,
              top,
              width: w,
              height: h,
              cursor: 'pointer',
              zIndex: 45,
              outline: isOpen(r) ? '2px solid var(--pixel-accent)' : 'none',
            }}
          />
        );
      })}

      {openRack && (
        <div
          style={{
            ...panelStyle,
            left: project.toScreenX(openRack.x + openRack.w + 6),
            top: project.toScreenY(openRack.y - 8),
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontWeight: 'bold',
              marginBottom: 4,
            }}
          >
            <span style={{ color: SERVER_RACK_PANEL_COLORS.heading }}>
              {openGroup?.name} · {openRack.kind === 'cpu' ? 'TOP CPU USERS' : 'TOP RAM USERS'}
            </span>
            <span
              onClick={() => setOpen(null)}
              style={{
                marginLeft: 'auto',
                cursor: 'pointer',
                color: SERVER_RACK_PANEL_COLORS.muted,
              }}
            >
              ✕
            </span>
          </div>
          {rows.length === 0 && (
            <div style={{ color: SERVER_RACK_PANEL_COLORS.muted }}>collecting…</div>
          )}
          {rows.map((row, i) => (
            <div key={row.name} style={{ display: 'flex', gap: 16, minWidth: 260 }}>
              <span
                style={{ color: SERVER_RACK_PANEL_COLORS.muted, width: 24, textAlign: 'right' }}
              >
                {i + 1}
              </span>
              <span>{row.name}</span>
              <span style={{ marginLeft: 'auto', color: SERVER_RACK_PANEL_COLORS.value }}>
                {row.value}
              </span>
            </div>
          ))}
          {openRack.kind === 'cpu' && rows.length > 0 && (
            <div style={{ color: SERVER_RACK_PANEL_COLORS.muted, marginTop: 6, fontSize: '15px' }}>
              100% = 1 core
            </div>
          )}
        </div>
      )}
    </>
  );
}
