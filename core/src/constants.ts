/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Office displays ──────────────────────────────────────────

// Off = the server skips the display's pollers and the webview neither draws
// it nor mounts its click overlay; the code stays in place.

/** Server racks (systemStats) on the FLOOR_1 zone. */
export const SERVER_RACKS_ENABLED = true;
/** The open project's alert-feed antenna yard (bridgeOps; BRIDGE today),
 *  placed by ~/.pixel-agents/project-displays.json. */
export const PROJECT_ALERTS_ENABLED = true;
/** The open project's web page kiosk (webPages: its permanent row in
 *  ~/.pixel-agents/ports.md + the port scan), in the same band. */
export const PROJECT_WEB_PAGES_ENABLED = true;
/** Status board (pipelineStatus) and the web-page chips (webPages) on the
 *  FLOOR_2 zone. */
export const STATUS_BOARD_ENABLED = false;

// ── Terminal (standalone embedded terminal) ──────────────────
// The raw PTY byte stream deliberately lives OUTSIDE the AsyncAPI contract --
// it is a data plane (unstructured, high-frequency), not a control plane.
// Only the terminal's control-plane facts (availability, session open/close)
// are AsyncAPI ServerMessages. See docs/design/standalone-terminal.md.

/** Path prefix for the per-agent terminal WebSocket: `/terminal/:agentId`. The
 *  handshake carries the server token as `?token=`, exactly like `/ws` (see
 *  server/src/wsAuth.ts); the frame shapes are in terminalFrames.ts. */
export const TERMINAL_WS_PREFIX = '/terminal';

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';
