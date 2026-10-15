import { useEffect, useRef, useState } from "react";
import { tabAnalytics, type TabAnalyticsResponse } from "../api";
import TerrainViewport from "./TerrainViewport";

export interface DockedStatsPanelProps {
  sessionName: string;
  tabId: string;
  tabName: string;
  command: string;
  cwd: string;
  title: string;
  pid: number;
  paused?: boolean;
  onExpand: () => void;
  onClose: () => void;
}

export default function DockedStatsPanel({
  sessionName,
  tabId,
  tabName,
  command,
  cwd,
  title,
  pid,
  paused = false,
  onExpand,
  onClose,
}: DockedStatsPanelProps) {
  const [data, setData] = useState<TabAnalyticsResponse | null>(null);
  const [bound, setBound] = useState({ sessionName, tabId });
  const fetchGen = useRef(0);
  // Keep the last real transcript so a missed CLI read does not reset the pan.
  const transcriptKey = useRef("");
  if (bound.sessionName !== sessionName || bound.tabId !== tabId) {
    fetchGen.current += 1;
    transcriptKey.current = "";
    setBound({ sessionName, tabId });
    setData(null);
  }
  const path = data?.transcript_path ?? "";
  if (path) transcriptKey.current = path;

  const fetchData = () => {
    const gen = fetchGen.current;
    const session = sessionName;
    const tab = tabId;
    tabAnalytics(session, tab, command, cwd, title, pid)
      .then((res) => {
        if (gen !== fetchGen.current) return;
        if (res.session_name !== session || res.tab_id !== tab) return;
        setData(res);
      })
      .catch((err) => console.error("tabAnalytics docked error:", err));
  };

  useEffect(() => {
    if (paused) return;
    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => clearInterval(interval);
  }, [sessionName, tabId, command, cwd, title, pid, paused]);

  if (paused) {
    return <div className="docked-stats-panel" aria-label="Docked area map" />;
  }

  // Active agent session only. Tab Cumulative stays on the fullscreen counters.
  const mapStats = data?.stats;
  const mapKey = `${sessionName}\0${tabId}\0${transcriptKey.current}`;

  return (
    <div className="docked-stats-panel" aria-label="Docked area map">
      <TerrainViewport
        timeline={mapStats?.timeline ?? []}
        activeModel={mapStats?.active_model}
        sessionName={sessionName}
        tabName={tabName}
        stats={mapStats}
        mapKey={mapKey}
        docked={true}
        onExpand={onExpand}
        onClose={onClose}
      />
    </div>
  );
}
