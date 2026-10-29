import type { Terminal } from '@xterm/xterm';

import { TERMINAL_COPY_FALLBACK_MS, TERMINAL_COPY_FALLBACK_TOP_PX } from '../constants.js';
import { writeClipboardText } from './clipboard.js';
import { clipboardKeyAction, decodeOsc52 } from './clipboardKeys.js';
import { terminalCopyText } from './flowCopy.js';

const OSC_CLIPBOARD = 52;

/**
 * Wire the clipboard on a terminal pane (the rules are the pure functions in
 * clipboardKeys.ts):
 *
 * - every copy of a selection is verbatim: Cmd+C and the browser's Copy are
 *   xterm's own copy handler, Ctrl+C / Ctrl+Shift+C (Windows, Linux) go
 *   through writeClipboardText;
 * - Alt+C (Option+C on a Mac) with a selection is "Copy as text": the
 *   selection with Claude Code's soft wraps re-flowed (terminalCopyText);
 * - Ctrl+V / Ctrl+Shift+V paste on Windows and Linux;
 * - OSC 52 writes from the running program reach this browser's clipboard.
 *
 * Returns a dispose function that removes everything it added.
 */
export function attachClipboardInput(
  term: Terminal,
  opts: {
    /** Only the pane on screen may write the clipboard from OSC 52. */
    isActive: () => boolean;
    /** Where to offer a click-to-copy pill when the browser refuses an OSC 52 write. */
    host?: HTMLElement;
  },
): () => void {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  term.attachCustomKeyEventHandler((ev) => {
    const action = clipboardKeyAction(ev, isMac, term.hasSelection());
    if (action === 'terminal') return true;
    if (ev.type === 'keydown' && (action === 'copy' || action === 'copyText')) {
      // Prevented: Ctrl+Shift+C would open DevTools, Option+C would type ç.
      // Written synchronously from the key press, which is the user gesture
      // the plain-http fallback needs; the selection goes once it landed.
      ev.preventDefault();
      if (term.hasSelection()) {
        const startCol = (term.getSelectionPosition()?.start.x ?? 1) - 1;
        const mode = action === 'copy' ? 'verbatim' : 'text';
        const text = terminalCopyText(term.getSelection(), mode, term.cols, startCol);
        void writeClipboardText(text).then((ok) => {
          if (ok) term.clearSelection();
        });
      }
    }
    // 'paste': returning false keeps xterm from sending ^V and cancelling the
    // key, so the browser raises its paste event and xterm pastes it (with
    // bracketed-paste markers when the app asks for them).
    return false;
  });

  // Plain-http origins fall back to a copy event, which works only while the
  // triggering key press still counts as a user gesture (writeClipboardText).
  // Safari refuses both paths here: an OSC 52 write arrives over the socket,
  // long after any user gesture. Then a one-click pill offers the copy, since
  // its click IS a gesture (Claude Code's own drag-select copies this way).
  let fallbackPill: { remove: () => void } | null = null;
  const osc = term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
    const text = opts.isActive() ? decodeOsc52(data) : null;
    if (text !== null) {
      void writeClipboardText(text).then((ok) => {
        if (ok || !opts.host) return;
        fallbackPill?.remove();
        fallbackPill = showCopyFallbackPill(opts.host, text);
      });
    }
    return true;
  });

  return () => {
    term.attachCustomKeyEventHandler(() => true);
    osc.dispose();
    fallbackPill?.remove();
  };
}

/** A "Copy" pill over the pane top that writes `text` on click, then goes away. */
function showCopyFallbackPill(host: HTMLElement, text: string): { remove: () => void } {
  const pill = document.createElement('div');
  pill.className = 'terminal-copy-pill';
  pill.style.left = '50%';
  pill.style.top = `${String(TERMINAL_COPY_FALLBACK_TOP_PX)}px`;
  const button = document.createElement('button');
  button.textContent = 'Copy selection';
  pill.appendChild(button);
  const remove = () => {
    clearTimeout(timer);
    pill.remove();
  };
  button.addEventListener('click', () => {
    void writeClipboardText(text).then(remove);
  });
  const timer = setTimeout(remove, TERMINAL_COPY_FALLBACK_MS);
  host.appendChild(pill);
  return { remove };
}
