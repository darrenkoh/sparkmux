import { useEffect, useState } from "react";
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
  onExpand,
  onClose,
}: DockedStatsPanelProps) {
  const [data, setData] = useState<TabAnalyticsResponse | null>(null);

  const fetchData = () => {
    tabAnalytics(sessionName, tabId, command, cwd, title, pid)
      .then((res) => setData(res))
      .catch((err) => console.error("tabAnalytics docked error:", err));
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => clearInterval(interval);
  }, [sessionName, tabId, command, cwd, title, pid]);

  return (
    <div className="docked-stats-panel" aria-label="Docked area map">
      <TerrainViewport
        timeline={data?.stats?.timeline ?? []}
        activeModel={data?.stats?.active_model}
        sessionName={sessionName}
        tabName={tabName}
        stats={data?.stats}
        docked={true}
        onExpand={onExpand}
        onClose={onClose}
      />
    </div>
  );
}
