/** Wire types for `agent_office`. Field names match the Rust snapshot. */

export interface OfficeStep {
  id: string;
  /** "user" | "assistant" | "thinking" | "tool" | "tool_result" */
  kind: string;
  label: string;
  text: string;
}

export interface OfficeAgent {
  session: string;
  window_id: string;
  window_name: string;
  pane_id: string;
  /** "grok" | "claude" | "antigravity" */
  cli: string;
  model: string;
  /** "needs_user" | "failed" | "succeeded" | "running" | "idle" */
  state: string;
  /** Empty when the agent is not mid-turn. */
  activity: string;
  tool: string;
  tool_arg: string;
  detail: string;
  ask: string;
  last_activity_ms: number;
  last_entry_id: string;
  recent: OfficeStep[];
  project: string;
}

export interface FreeDesk {
  session: string;
  pane_id: string;
  window_name: string;
}

export interface OfficeSnapshot {
  agents: OfficeAgent[];
  /** Non-agent, non-ssh panes. */
  free_desks: FreeDesk[];
  now_ms: number;
}

export type Pose =
  | "type_fast"
  | "type_slow"
  | "terminal"
  | "lean_back"
  | "raise_hand"
  | "slump"
  | "read_standing"
  | "browse"
  | "meeting"
  | "whiteboard"
  | "sofa"
  | "coffee";

export type Zone = "desk" | "bookshelf" | "window" | "meeting" | "whiteboard" | "coffee" | "sofa";

export type OfficeMarker = "ask" | "error" | "zzz" | "thought" | null;

export interface PoseResult {
  pose: Pose;
  zone: Zone;
  marker: OfficeMarker;
}

export type FeedTone = "ask" | "error" | "ok" | "work" | "idle";

export interface FeedLine {
  id: string;
  at: number;
  key: string;
  name: string;
  tone: FeedTone;
  text: string;
}

export type TimeOfDay = "now" | "day" | "evening" | "night";
