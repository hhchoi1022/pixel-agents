import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ResumableSession } from '../../../core/src/messages.js';
import { DRAWER_EDIT_LONG_PRESS_MAX_MOVE_PX, DRAWER_EDIT_LONG_PRESS_MS } from '../constants.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { useResumableSessions } from '../hooks/useResumableSessions.js';
import { isBrowserRuntime } from '../runtime.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface LaunchDrawerProps {
  isOpen: boolean;
  directories: Directory[];
  /** Launch into the tapped Directory -- or, from the resume list, resume a
   *  session that ran there. The surface owns the send, because what else a
   *  launch does differs per surface (mobile also slides to the new terminal). */
  onSelect: (directory: Directory, resumeSessionId?: string) => void;
  /** Open the Directory modal empty (the pinned `+ Directory` row). */
  onAddDirectory: () => void;
  /** Open the Directory modal pre-filled with this entry (user-defined rows). */
  onEditDirectory: (directory: Directory) => void;
  className?: string;
}

/**
 * The launch button's drawer: one row per Directory an agent can be launched
 * into, with `+ Directory` pinned above them behind a separator. Opened by a
 * plain press of the launch button (and by hover on desktop), and rendered
 * above the button by the shared Dropdown. Every launch goes through a row
 * here — the button itself never launches.
 *
 * Rows arrive already ordered (host rows first, then user rows, each group
 * alphabetical) and already deduped: the union is built host-side, so every
 * office shows the same list in the same order.
 *
 * Only user-defined rows are editable — host-contributed rows (VS Code's
 * workspace folders, standalone's start directory) are the host's to define,
 * so they carry a badge and no edit affordance. The badge is aria-hidden so a
 * row's accessible name stays the bare Directory name. The pencil is part of
 * the row: revealed by hovering it where hover exists, and replaced by a
 * long-press on the row where it doesn't (both `hover:`-gated styling and the
 * `pointer-coarse:` hide follow the device, not the viewport).
 *
 * Standalone also pins `Resume session` there, which swaps the rows for the
 * sessions the host can resume (closed ones, newest first); picking one
 * relaunches it in its Directory. VS Code has no server-side terminal to
 * resume into, so it never shows the row.
 */
export function LaunchDrawer({
  isOpen,
  directories,
  onSelect,
  onAddDirectory,
  onEditDirectory,
  className = '',
}: LaunchDrawerProps) {
  const [showResume, setShowResume] = useState(false);
  // Every opening starts on the Directory rows.
  useEffect(() => {
    if (!isOpen) setShowResume(false);
  }, [isOpen]);

  if (showResume) {
    return (
      <Dropdown isOpen={isOpen} fitViewport className={`min-w-128 ${className}`}>
        <ResumeList
          directories={directories}
          onBack={() => setShowResume(false)}
          onSelect={onSelect}
        />
      </Dropdown>
    );
  }

  return (
    // Open even with no Directories: `+ Directory` is always worth showing, and
    // an office with an empty list is exactly where it's needed most.
    // fitViewport: a long list must never push `+ Directory` above the top of
    // the screen, so the drawer is capped at the room above the button and
    // only the rows scroll.
    <Dropdown isOpen={isOpen} fitViewport className={`min-w-128 ${className}`}>
      <div data-testid="launch-drawer" className="flex flex-col min-h-0">
        {/* DropdownItem hard-resets to border-none, so the separator lives on
            this wrapper. Pinned: it never scrolls away with the rows. */}
        <div className="shrink-0 border-b-2 border-border">
          <DropdownItem onClick={onAddDirectory} className="text-base text-accent-bright">
            + Directory
          </DropdownItem>
          {isBrowserRuntime && (
            <DropdownItem onClick={() => setShowResume(true)} className="text-base">
              ↻ Resume session
            </DropdownItem>
          )}
        </div>
        <div className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain pixel-scrollbar">
          {directories.map((directory) => (
            <DirectoryRow
              key={directory.path}
              directory={directory}
              onSelect={onSelect}
              onEditDirectory={onEditDirectory}
            />
          ))}
        </div>
      </div>
    </Dropdown>
  );
}

interface ResumeListProps {
  directories: Directory[];
  onBack: () => void;
  onSelect: (directory: Directory, resumeSessionId?: string) => void;
}

/** The resume view: `← Back` pinned, then one row per resumable session --
 *  its name (or Directory), how long ago it last ran, and its last prompt. */
function ResumeList({ directories, onBack, onSelect }: ResumeListProps) {
  const sessions = useResumableSessions(true);
  // A session resumes in its Directory; one whose Directory left the list
  // since the reply was built has nowhere to go.
  const rows = (sessions ?? []).flatMap((session) => {
    const directory = directories.find((d) => d.path === session.directoryPath);
    return directory ? [{ session, directory }] : [];
  });

  return (
    <div data-testid="resume-list" className="flex flex-col min-h-0 w-320 max-w-[90vw]">
      <div className="shrink-0 border-b-2 border-border">
        <DropdownItem onClick={onBack} className="text-base text-accent-bright">
          ← Back
        </DropdownItem>
      </div>
      <div className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain pixel-scrollbar">
        {sessions === null && <p className="py-2 px-12 text-sm text-text-muted">Loading…</p>}
        {sessions !== null && rows.length === 0 && (
          <p className="py-2 px-12 text-sm text-text-muted">No sessions to resume</p>
        )}
        {rows.map(({ session, directory }) => (
          <ResumeRow
            key={session.sessionId}
            session={session}
            onSelect={() => onSelect(directory, session.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

function ResumeRow({ session, onSelect }: { session: ResumableSession; onSelect: () => void }) {
  return (
    <DropdownItem onClick={onSelect} className="text-base">
      <span className="flex items-center justify-between gap-10">
        <span className="overflow-hidden text-ellipsis" title={session.sessionId}>
          {session.title ?? session.directoryName}
        </span>
        <span className="shrink-0 text-2xs text-text-muted">{timeAgo(session.lastActiveMs)}</span>
      </span>
      {session.lastPrompt && (
        <span className="block overflow-hidden text-ellipsis text-xs text-text-muted">
          {session.lastPrompt}
        </span>
      )}
    </DropdownItem>
  );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `3m ago`, `5h ago`, `2d ago` -- enough to tell a session from yesterday's. */
function timeAgo(ms: number): string {
  const elapsed = Date.now() - ms;
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

interface DirectoryRowProps {
  directory: Directory;
  onSelect: (directory: Directory) => void;
  onEditDirectory: (directory: Directory) => void;
}

function DirectoryRow({ directory, onSelect, onEditDirectory }: DirectoryRowProps) {
  const editable = directory.source === 'user';
  const longPressTimer = useRef<number | undefined>(undefined);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  /** Set when a long-press opened the edit modal, so the click the browser
   *  fires on finger-up doesn't ALSO launch an agent behind it. */
  const longPressFired = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimer.current !== undefined) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = undefined;
    }
    pressOrigin.current = null;
  };

  useEffect(() => cancelLongPress, []);

  // The long-press is touch-only: a mouse has hover, so it gets the pencil.
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable || e.pointerType !== 'touch') return;
    longPressFired.current = false;
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = undefined;
      longPressFired.current = true;
      onEditDirectory(directory);
    }, DRAWER_EDIT_LONG_PRESS_MS);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pressOrigin.current === null) return;
    const moved = Math.hypot(e.clientX - pressOrigin.current.x, e.clientY - pressOrigin.current.y);
    if (moved > DRAWER_EDIT_LONG_PRESS_MAX_MOVE_PX) cancelLongPress();
  };

  return (
    // The row is one hover surface: its own background covers the pencil strip
    // too, so the pencil reads as part of the item rather than a neighbor.
    // select-none + no touch callout keep a long-press from starting iOS text
    // selection; the context menu is Android's long-press, already spoken for.
    <div
      data-testid="directory-row"
      className="group flex items-center hover:bg-btn-bg select-none [-webkit-touch-callout:none]"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => {
        if (editable) e.preventDefault();
      }}
    >
      <DropdownItem
        onClick={() => {
          if (longPressFired.current) {
            longPressFired.current = false;
            return;
          }
          onSelect(directory);
        }}
        className="flex-1 min-w-0 text-base"
      >
        <span className="flex items-center justify-between gap-10">
          <span className="overflow-hidden text-ellipsis" title={directory.path}>
            {directory.name}
          </span>
          {directory.source === 'host' && (
            <span
              aria-hidden="true"
              className="shrink-0 text-2xs text-text-muted border-2 border-border pl-4 pr-2 leading-none"
            >
              host
            </span>
          )}
        </span>
      </DropdownItem>
      {editable && (
        // Hidden until the row is hovered (hover: only exists on devices that
        // have it) or the button is keyboard-focused; gone entirely on coarse
        // pointers, where the row's long-press is the edit affordance.
        <button
          onClick={() => onEditDirectory(directory)}
          aria-label={`Edit ${directory.name}`}
          title="Edit directory"
          className="shrink-0 self-stretch flex items-center px-8 bg-transparent border-none rounded-none cursor-pointer text-sm leading-none text-text-muted hover:text-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden"
        >
          <span className="material-symbols-sharp text-[12px]" aria-hidden="true">
            edit
          </span>
        </button>
      )}
    </div>
  );
}
