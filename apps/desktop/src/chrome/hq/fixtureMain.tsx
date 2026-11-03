/**
 * Screenshot fixture for Agent HQ. Not the office sim, and not imported by the app.
 * Open /hq-fixture.html on the Vite dev server.
 */
import React from "react";
import ReactDOM from "react-dom/client";

import type { OfficeSnapshot } from "../office/officeTypes.ts";
import AgentHq from "./AgentHq.tsx";

const fixture: OfficeSnapshot = {
  now_ms: 1_700_000_000_000,
  free_desks: [{ session: "sparkmux", pane_id: "%9", window_name: "shell" }],
  agents: [
    {
      session: "sparkmux",
      window_id: "@1",
      window_name: "api",
      pane_id: "%1",
      cli: "claude",
      model: "Claude",
      state: "running",
      activity: "coding",
      tool: "Edit",
      tool_arg: "src/api.ts",
      detail: "Editing the client",
      ask: "",
      last_activity_ms: 1_700_000_000_000,
      last_entry_id: "a1",
      recent: [],
      project: "sparkmux",
    },
    {
      session: "sparkmux",
      window_id: "@2",
      window_name: "review",
      pane_id: "%2",
      cli: "claude",
      model: "Claude",
      state: "needs_user",
      activity: "",
      tool: "",
      tool_arg: "",
      detail: "Apply the patch? [y/n]",
      ask: "Apply the patch? [y/n]",
      last_activity_ms: 1_700_000_000_000,
      last_entry_id: "a2",
      recent: [],
      project: "sparkmux",
    },
    {
      session: "sparkmux",
      window_id: "@3",
      window_name: "build",
      pane_id: "%3",
      cli: "grok",
      model: "Grok",
      state: "failed",
      activity: "terminal",
      tool: "Bash",
      tool_arg: "cargo test",
      detail: "the build failed",
      ask: "",
      last_activity_ms: 1_700_000_000_000,
      last_entry_id: "a3",
      recent: [],
      project: "sparkmux",
    },
    {
      session: "notes",
      window_id: "@4",
      window_name: "digest",
      pane_id: "%4",
      cli: "grok",
      model: "Grok",
      state: "idle",
      activity: "",
      tool: "",
      tool_arg: "",
      detail: "",
      ask: "",
      last_activity_ms: 1_699_000_000_000,
      last_entry_id: "a4",
      recent: [],
      project: "notes",
    },
    {
      session: "notes",
      window_id: "@5",
      window_name: "scan",
      pane_id: "%5",
      cli: "antigravity",
      model: "Antigravity",
      state: "succeeded",
      activity: "reading",
      tool: "Read",
      tool_arg: "README.md",
      detail: "Read the notes",
      ask: "",
      last_activity_ms: 1_699_900_000_000,
      last_entry_id: "a5",
      recent: [],
      project: "notes",
    },
  ],
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AgentHq
      snap={{ sessions: [] }}
      variant="overlay"
      fixture={fixture}
      onSelectAgent={() => {}}
    />
  </React.StrictMode>,
);
