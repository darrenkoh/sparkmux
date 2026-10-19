const PATH_KEYS = ["file_path", "target_file", "path", "absolutepath", "targetfile"];

/** First recorded file path on a tool row, or nothing when the body has none. */
export function toolRowPath(body: string): string | null {
  for (const line of body.split("\n")) {
    const split = line.indexOf(":");
    if (split <= 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    if (!PATH_KEYS.includes(key)) continue;
    const value = line.slice(split + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** The editor request is the recorded path. It never includes a pane write. */
export function editorOpenRequest(path: string, cwd: string): { path: string; paneWrite: false } {
  const trimmed = path.trim();
  if (trimmed.startsWith("/")) {
    return { path: trimmed, paneWrite: false };
  }
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return { path: `${base}/${trimmed}`, paneWrite: false };
}
