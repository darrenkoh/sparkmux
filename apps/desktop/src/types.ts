export type SplitDir = "LeftRight" | "TopBottom";

export type LayoutNode =
  | { Pane: { w: number; h: number; x: number; y: number; pane_id: number } }
  | {
      Split: {
        w: number;
        h: number;
        x: number;
        y: number;
        dir: SplitDir;
        children: LayoutNode[];
      };
    };

export interface Pane {
  id: string;
  index: number;
  command: string;
  path: string;
  pid: number;
  active: boolean;
  width: number;
  height: number;
  title: string;
  alternate: boolean;
  /** Program asked for mouse reports (button, drag, or hover). */
  mouse: boolean;
  /** DECSET 1002. Drags are reported. */
  mouse_drag: boolean;
  /** DECSET 1003. Hovers are reported. Grok Build sets this. */
  mouse_any: boolean;
  /** Reports use SGR encoding. */
  mouse_sgr: boolean;
}

export interface Window {
  id: string;
  index: number;
  name: string;
  active: boolean;
  layout: string;
  bell: boolean;
  activity: boolean;
  activity_epoch: number;
  unread: boolean;
  /** One-line ask. The sidebar and tabs show it only on an unread hidden window. */
  pending_ask: string;
  /** Quiet finished mark. Never drawn on the visible window. */
  finished: boolean;
  /**
   * Classifier label. Stays set while the window is visible, when unread and
   * the pending question are cleared.
   */
  attention_label: "needs_user" | "failed" | "succeeded" | "running" | null;
  panes: Pane[];
}

export interface Session {
  id: string;
  name: string;
  attached: boolean;
  created_epoch: number;
  activity_epoch: number;
  path: string;
  windows: Window[];
}

export interface Snapshot {
  sessions: Session[];
}

export interface AppTelemetry {
  memory_bytes: number;
  cpu_percent: number | null;
}

export type UsageDirection = "used" | "remaining";

export interface UsageBar {
  group: string | null;
  label: string;
  percent: number;
  direction: UsageDirection;
  resets_at_ms: number | null;
}

export interface UsageCostModel {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Dollars Claude recorded, plus token totals the UI prices when Claude did not. */
export interface UsageCostPart {
  known_usd: number;
  estimated: boolean;
  models: UsageCostModel[];
}

export interface UsageCost {
  session: UsageCostPart;
  today: UsageCostPart;
}

export interface LlmUsage {
  cli: string | null;
  bars: UsageBar[];
  fetched_at_ms: number | null;
  plan: string | null;
  credits_usd: number | null;
  /** Present only for a Claude pane running on Bedrock. */
  cost?: UsageCost | null;
}

export interface TmuxStatus {
  bin: string | null;
  version: string | null;
  supported: boolean;
  socket_name: string;
  socket_path: string | null;
  default_session: string;
  last_session: string | null;
  app_version: string;
  is_headless?: boolean;
  error: string | null;
  hint: string | null;
}

export type GuiError = "missing-tmux" | "too-old" | "server-stopped" | "control-dead" | null;

export type Selection =
  | { kind: "session"; id: string; name: string }
  | { kind: "window"; id: string; name: string; sessionName: string }
  | { kind: "pane"; id: string; sessionName: string; windowId: string };

export interface LayoutChangePayload {
  window_id: string;
  layout: LayoutNode;
}
