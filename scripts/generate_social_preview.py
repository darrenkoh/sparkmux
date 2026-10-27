#!/usr/bin/env python3
"""
Generate GitHub Social Preview image (1280x640) for sparkmux.
Renders high-DPI HTML/CSS with 3D perspective cards, glows, and system fonts via Chrome headless.
"""

import base64
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"

def to_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def main():
    icon_path = ICONS / "icon.png"
    shot_path = DOCS / "screenshot.png"
    hud_path = DOCS / "stats-hud.png"

    if not icon_path.exists() or not shot_path.exists() or not hud_path.exists():
        print("Error: Missing required asset files", file=sys.stderr)
        sys.exit(1)

    icon_b64 = to_b64(icon_path)
    shot_b64 = to_b64(shot_path)
    hud_b64 = to_b64(hud_path)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * {{
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }}
  body {{
    width: 1280px;
    height: 640px;
    background: #080b12;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", system-ui, sans-serif;
    color: #f8fafc;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
  }}

  /* Background Grid */
  .grid-bg {{
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(to right, rgba(56, 189, 248, 0.05) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(56, 189, 248, 0.05) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(ellipse 95% 85% at 50% 50%, black 45%, transparent 100%);
    pointer-events: none;
  }}

  /* Radial Ambient Glows */
  .glow-cyan {{
    position: absolute;
    width: 650px;
    height: 650px;
    top: -180px;
    right: 60px;
    background: radial-gradient(circle, rgba(14, 165, 233, 0.25) 0%, rgba(56, 189, 248, 0.06) 50%, transparent 75%);
    filter: blur(60px);
    pointer-events: none;
  }}

  .glow-purple {{
    position: absolute;
    width: 700px;
    height: 700px;
    bottom: -220px;
    left: 180px;
    background: radial-gradient(circle, rgba(139, 92, 246, 0.20) 0%, rgba(99, 102, 241, 0.05) 50%, transparent 75%);
    filter: blur(70px);
    pointer-events: none;
  }}

  .glow-top-left {{
    position: absolute;
    width: 400px;
    height: 400px;
    top: -120px;
    left: -80px;
    background: radial-gradient(circle, rgba(56, 189, 248, 0.12) 0%, transparent 70%);
    filter: blur(50px);
    pointer-events: none;
  }}

  /* Outer Frame Border */
  .frame-border {{
    position: absolute;
    inset: 0;
    border: 1px solid rgba(255, 255, 255, 0.09);
    pointer-events: none;
    z-index: 99;
  }}

  /* Main Container */
  .container {{
    position: relative;
    z-index: 10;
    width: 100%;
    height: 100%;
    padding: 44px 54px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }}

  /* Left Column */
  .left-col {{
    width: 535px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 18px;
  }}

  .header-meta {{
    display: flex;
    align-items: center;
    gap: 12px;
  }}

  .logo-box {{
    width: 54px;
    height: 54px;
    border-radius: 13px;
    padding: 3px;
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.5) 0%, rgba(139, 92, 246, 0.3) 100%);
    box-shadow: 0 0 25px rgba(56, 189, 248, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
  }}

  .logo-img {{
    width: 100%;
    height: 100%;
    border-radius: 10px;
    display: block;
    object-fit: cover;
  }}

  .repo-tag {{
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 12px;
    border-radius: 9999px;
    background: rgba(56, 189, 248, 0.08);
    border: 1px solid rgba(56, 189, 248, 0.28);
    font-size: 11.5px;
    font-weight: 600;
    color: #38bdf8;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }}

  .repo-tag .pulse-dot {{
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #00f0ff;
    box-shadow: 0 0 8px #00f0ff;
  }}

  .github-pill {{
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 11px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-size: 11.5px;
    font-weight: 500;
    color: #94a3b8;
  }}

  .title-section {{
    display: flex;
    flex-direction: column;
    gap: 8px;
  }}

  .brand-title {{
    font-size: 50px;
    font-weight: 850;
    letter-spacing: -0.035em;
    line-height: 1.0;
    color: #ffffff;
    display: flex;
    align-items: center;
    gap: 8px;
  }}

  .brand-title .bolt {{
    color: #38bdf8;
    filter: drop-shadow(0 0 14px rgba(56, 189, 248, 0.9));
  }}

  .tagline-main {{
    font-size: 21px;
    font-weight: 600;
    line-height: 1.32;
    letter-spacing: -0.015em;
    color: #cbd5e1;
  }}

  .tagline-gradient {{
    background: linear-gradient(90deg, #38bdf8 0%, #818cf8 50%, #c084fc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    font-weight: 700;
  }}

  /* Feature Grid */
  .feature-list {{
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 4px;
  }}

  .feature-row {{
    display: flex;
    align-items: center;
    gap: 11px;
    font-size: 14px;
    color: #94a3b8;
    font-weight: 450;
    line-height: 1.3;
  }}

  .f-icon {{
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    flex-shrink: 0;
  }}

  .feature-row strong {{
    color: #f1f5f9;
    font-weight: 600;
  }}

  /* Tech Stack Badges */
  .badge-row {{
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 6px;
    flex-wrap: wrap;
  }}

  .tech-chip {{
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09);
    font-size: 11.5px;
    font-weight: 550;
    color: #94a3b8;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }}

  .tech-chip.featured {{
    background: rgba(56, 189, 248, 0.1);
    border-color: rgba(56, 189, 248, 0.3);
    color: #7dd3fc;
  }}

  .tech-chip.featured-purple {{
    background: rgba(139, 92, 246, 0.12);
    border-color: rgba(139, 92, 246, 0.32);
    color: #c4b5fd;
  }}

  /* Right Column: 3D Showcase */
  .right-col {{
    position: relative;
    width: 630px;
    height: 520px;
    perspective: 1200px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }}

  /* Primary Terminal Window */
  .terminal-card {{
    position: absolute;
    width: 585px;
    height: 385px;
    top: 48px;
    right: 0px;
    border-radius: 12px;
    background: #0d121f;
    border: 1px solid rgba(56, 189, 248, 0.32);
    box-shadow: 
      0 35px 80px -15px rgba(0, 0, 0, 0.95),
      0 0 50px rgba(14, 165, 233, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.22);
    transform: rotateY(-11deg) rotateX(6deg) rotateZ(1.2deg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }}

  .card-topbar {{
    height: 32px;
    background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 9px;
  }}

  .dots {{
    display: flex;
    gap: 6px;
  }}

  .dot-r {{ width: 10px; height: 10px; border-radius: 50%; background: #ff5f56; }}
  .dot-y {{ width: 10px; height: 10px; border-radius: 50%; background: #ffbd2e; }}
  .dot-g {{ width: 10px; height: 10px; border-radius: 50%; background: #27c93f; }}

  .card-title {{
    margin-left: 6px;
    font-size: 11px;
    font-weight: 550;
    color: #94a3b8;
    font-family: ui-monospace, Menlo, monospace;
    display: flex;
    align-items: center;
    gap: 7px;
  }}

  .card-title .active-socket {{
    color: #38bdf8;
    font-weight: 700;
  }}

  .card-viewport {{
    flex: 1;
    overflow: hidden;
    position: relative;
    background: #000;
  }}

  .viewport-img {{
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top left;
    display: block;
  }}

  /* Overlapping HUD Floating Card */
  .hud-card {{
    position: absolute;
    width: 320px;
    height: 195px;
    bottom: 22px;
    left: -15px;
    border-radius: 11px;
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid rgba(168, 85, 247, 0.45);
    box-shadow: 
      0 25px 50px rgba(0, 0, 0, 0.88),
      0 0 40px rgba(168, 85, 247, 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
    transform: rotateY(-8deg) rotateX(4deg) translateZ(60px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }}

  .hud-topbar {{
    height: 27px;
    background: rgba(30, 41, 59, 0.85);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    font-size: 10px;
    font-weight: 700;
    color: #d8b4fe;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }}

  .live-badge {{
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    color: #4ade80;
    background: rgba(34, 197, 94, 0.18);
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid rgba(74, 222, 128, 0.35);
    font-weight: 700;
  }}

  .live-badge .blink {{
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 6px #4ade80;
  }}

  .hud-viewport {{
    flex: 1;
    overflow: hidden;
    position: relative;
    background: #020617;
  }}

  .hud-img {{
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 30%;
    display: block;
  }}

  /* Top Right Floating Telemetry Pill */
  .telemetry-tag {{
    position: absolute;
    top: 26px;
    right: 25px;
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(56, 189, 248, 0.4);
    border-radius: 9999px;
    padding: 6px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    color: #e2e8f0;
    box-shadow: 0 12px 30px rgba(0,0,0,0.6), 0 0 20px rgba(56, 189, 248, 0.25);
    transform: rotateY(-11deg) rotateX(6deg) translateZ(85px);
  }}

  .telemetry-tag .token-stat {{
    color: #38bdf8;
    font-weight: 700;
  }}

  .telemetry-tag .subagent-stat {{
    color: #a855f7;
    font-weight: 600;
  }}

  .telemetry-tag .status-ok {{
    color: #4ade80;
    font-weight: 600;
  }}

</style>
</head>
<body>
  <div class="grid-bg"></div>
  <div class="glow-cyan"></div>
  <div class="glow-purple"></div>
  <div class="glow-top-left"></div>
  <div class="frame-border"></div>

  <div class="container">
    <!-- Left Column: Branding & Features -->
    <div class="left-col">
      <div class="header-meta">
        <div class="logo-box">
          <img class="logo-img" src="data:image/png;base64,{icon_b64}" alt="Sparkmux" />
        </div>
        <div class="repo-tag">
          <span class="pulse-dot"></span>
          AI Agent Multiplexer
        </div>
        <div class="github-pill">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          darrenkoh/sparkmux
        </div>
      </div>

      <div class="title-section">
        <h1 class="brand-title">
          <span class="bolt">⚡</span>sparkmux
        </h1>
        <div class="tagline-main">
          The Terminal Multiplexer<br/>
          <span class="tagline-gradient">Built for the AI Agent Era</span>
        </div>
      </div>

      <div class="feature-list">
        <div class="feature-row">
          <div class="f-icon">⚡</div>
          <div><strong>Private tmux Server</strong> &bull; Zero config <code>-L sparkmux</code>, native tiled xterm.js</div>
        </div>
        <div class="feature-row">
          <div class="f-icon">🧠</div>
          <div><strong>AI Agent Telemetry</strong> &bull; Real-time tokens, thinking follower &amp; tool diffs</div>
        </div>
        <div class="feature-row">
          <div class="f-icon">🌐</div>
          <div><strong>3D Area Map &amp; HUD</strong> &bull; Interactive WebGL terrain &amp; neural synaptogenesis</div>
        </div>
        <div class="feature-row">
          <div class="f-icon">⬡</div>
          <div><strong>Multi-Repo Gits</strong> &bull; Visual Chronicle transit timeline &amp; change graph</div>
        </div>
      </div>

      <div class="badge-row">
        <span class="tech-chip featured">🦀 Rust</span>
        <span class="tech-chip featured">⚡ Tauri 2</span>
        <span class="tech-chip">tmux 3.2+</span>
        <span class="tech-chip featured-purple">Claude Code</span>
        <span class="tech-chip featured-purple">Grok</span>
        <span class="tech-chip featured-purple">Antigravity</span>
        <span class="tech-chip">macOS &bull; Linux</span>
      </div>
    </div>

    <!-- Right Column: 3D Angled Window Mockup -->
    <div class="right-col">
      <!-- Main Tiled Pane Window -->
      <div class="terminal-card">
        <div class="card-topbar">
          <div class="dots">
            <span class="dot-r"></span>
            <span class="dot-y"></span>
            <span class="dot-g"></span>
          </div>
          <div class="card-title">
            <span class="active-socket">sparkmux</span>
            <span>&bull;</span>
            <span>session: #0 [tiled 3-pane]</span>
            <span>&bull;</span>
            <span>Claude Code &bull; Grok &bull; AGY</span>
          </div>
        </div>
        <div class="card-viewport">
          <img class="viewport-img" src="data:image/png;base64,{shot_b64}" alt="Sparkmux Terminal View" />
        </div>
      </div>

      <!-- Overlapping 3D Topography HUD Window -->
      <div class="hud-card">
        <div class="hud-topbar">
          <span>3D Area Map &bull; Stats HUD</span>
          <span class="live-badge"><span class="blink"></span>LIVE</span>
        </div>
        <div class="hud-viewport">
          <img class="hud-img" src="data:image/png;base64,{hud_b64}" alt="Sparkmux 3D Stats HUD" />
        </div>
      </div>

      <!-- Live Floating Telemetry Pill -->
      <div class="telemetry-tag">
        <span class="token-stat">⚡ 142k tok</span>
        <span>&bull;</span>
        <span class="subagent-stat">4 subagents</span>
        <span>&bull;</span>
        <span class="status-ok">● synced</span>
      </div>
    </div>
  </div>
</body>
</html>
"""

    temp_html = Path("/tmp/sparkmux_social_preview.html")
    temp_html.write_text(html)

    out_file = DOCS / "social-preview.png"
    assets_dir = ROOT / ".github" / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    out_assets = assets_dir / "social-preview.png"

    chrome_bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if not os.path.exists(chrome_bin):
        chrome_bin = "google-chrome"

    cmd = [
        chrome_bin,
        "--headless",
        "--disable-gpu",
        "--window-size=1280,640",
        f"--screenshot={out_file}",
        f"file://{temp_html}"
    ]

    print(f"Rendering social preview to {out_file}...")
    subprocess.run(cmd, check=True)
    subprocess.run(["cp", str(out_file), str(out_assets)], check=True)

    print(f"Done! Social preview generated:")
    print(f"  - {out_file}")
    print(f"  - {out_assets}")

if __name__ == "__main__":
    main()
