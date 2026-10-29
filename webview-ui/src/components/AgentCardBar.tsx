import type { MouseEvent as ReactMouseEvent } from 'react';
import { useMemo, useRef, useState } from 'react';

import { DESKTOP_CARD_ORDER_STORAGE_KEY, TERMINAL_SIDEBAR_WIDTH_PX } from '../constants.js';
import { withinTapSlop } from '../touch/touchPrimitives.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';
import { cardVariant, loadCardOrder, mergeOrder, reorderByPointer } from './cardBar.js';

interface AgentCardBarProps {
  /** Agents to show, top to bottom. */
  agentIds: number[];
  /** The agent whose terminal pane is showing (standalone). Its card gets the
   *  accent border. */
  activeAgentId?: number | null;
  /** The agent whose character is selected in the office. Its card gets the
   *  active background; `activeAgentId` wins when both name the same agent. */
  focusedAgentId?: number | null;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
}

/**
 * The column of agent cards along the office's right edge — one mug shot and
 * status dot per agent — shared by both desktop hosts.
 *
 * Transparent and borderless, drawn on top of the office space: the negative
 * margin exactly cancels the column's width, so it takes no layout room and
 * overlays the office's right edge as a flex sibling of the office region.
 * Pointer events pass through the empty parts so the office stays clickable
 * underneath; only the cards are interactive.
 *
 * In standalone, TerminalDrawer owns the bar and the cards double as the
 * terminal panel's tabs (the panel opens to the bar's right). In VS Code the
 * bar stands alone and lists every agent in the office, external sessions
 * included; a card click raises that agent's editor terminal via focusAgent.
 *
 * Drag a card up or down to reorder: a press that moves past the tap slop
 * lifts it, and the drop swallows the click so it doesn't also select. The
 * order is display-only (the terminal panes keep theirs) and persisted per
 * browser in localStorage, like the mobile bar's.
 */
export function AgentCardBar({
  agentIds,
  activeAgentId = null,
  focusedAgentId = null,
  getAppearance,
  statusFor,
  onSelect,
  onClose,
}: AgentCardBarProps) {
  const [savedOrder, setSavedOrder] = useState<number[]>(() =>
    loadCardOrder(DESKTOP_CARD_ORDER_STORAGE_KEY),
  );
  const displayIds = useMemo(() => mergeOrder(savedOrder, agentIds), [savedOrder, agentIds]);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  // The window listeners outlive the render that attached them.
  const displayIdsRef = useRef(displayIds);
  displayIdsRef.current = displayIds;

  const handleCardMouseDown = (id: number) => (e: ReactMouseEvent) => {
    // Left button only, and never from the card's × button.
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (withinTapSlop(ev.clientX - startX, ev.clientY - startY)) return;
        dragging = true;
        setDraggingId(id);
        document.body.style.userSelect = 'none';
      }
      const ids = displayIdsRef.current;
      const next = reorderByPointer(
        ids,
        id,
        (otherId) => {
          const rect = cardRefs.current.get(otherId)?.getBoundingClientRect();
          return rect ? rect.top + rect.height / 2 : null;
        },
        ev.clientY,
      );
      if (next.join(',') !== ids.join(',')) setSavedOrder(next);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!dragging) return;
      document.body.style.userSelect = '';
      setDraggingId(null);
      // The drop's click would select the card — swallow that one click.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      try {
        localStorage.setItem(DESKTOP_CARD_ORDER_STORAGE_KEY, JSON.stringify(displayIdsRef.current));
      } catch {
        // Storage full/blocked — the order still applies for this session.
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (agentIds.length === 0) return null;

  return (
    <div
      className="relative z-30 h-full shrink-0 flex flex-col items-center gap-4 pt-4 overflow-y-auto pointer-events-none"
      style={{ width: TERMINAL_SIDEBAR_WIDTH_PX, marginLeft: -TERMINAL_SIDEBAR_WIDTH_PX }}
    >
      {displayIds.map((agentId) => (
        <div
          key={agentId}
          ref={(el) => {
            if (el) cardRefs.current.set(agentId, el);
            else cardRefs.current.delete(agentId);
          }}
          onMouseDown={handleCardMouseDown(agentId)}
          className={`shrink-0 flex ${
            draggingId === agentId ? 'relative z-10 -translate-x-4 opacity-70 cursor-grabbing' : ''
          }`}
        >
          <AgentCard
            agentId={agentId}
            variant={cardVariant(agentId, { activeId: activeAgentId, focusedId: focusedAgentId })}
            appearance={getAppearance(agentId)}
            status={statusFor(agentId)}
            onSelect={onSelect}
            onClose={onClose}
          />
        </div>
      ))}
    </div>
  );
}
