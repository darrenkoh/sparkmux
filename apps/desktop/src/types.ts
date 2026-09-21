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
}

export interface Window {
  id: string;
  index: number;
  name: string;
  active: boolean;
  layout: string;
  bell: boolean;
  activity: boolean;
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

export interface TmuxStatus {
  bin: string | null;
  version: string | null;
  supported: boolean;
  socket_name: string;
  socket_path: string | null;
  default_session: string;
  last_session: string | null;
  app_version: string;
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
