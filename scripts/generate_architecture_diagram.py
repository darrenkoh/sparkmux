#!/usr/bin/env python3
"""
Generate an elegant, high-DPI sci-fi architecture diagram (PNG) for sparkmux.
Renders responsive glassmorphism cards, glowing neon buses, technical telemetry callouts,
and crisp typography via Chrome headless.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUTPUT_IMAGE = DOCS / "architecture.png"

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    width: 1720px;
    height: 980px;
    background: #060911;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif;
    color: #e2e8f0;
    overflow: hidden;
    position: relative;
    padding: 44px 52px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  /* Grid & Ambience */
  .grid-bg {
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(to right, rgba(56, 189, 248, 0.04) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(56, 189, 248, 0.04) 1px, transparent 1px);
    background-size: 32px 32px;
    mask-image: radial-gradient(ellipse 90% 80% at 50% 50%, black 50%, transparent 100%);
    pointer-events: none;
  }
  .glow-cyan {
    position: absolute;
    width: 650px;
    height: 650px;
    top: -160px;
    left: -100px;
    background: radial-gradient(circle, rgba(14, 165, 233, 0.16) 0%, transparent 70%);
    filter: blur(80px);
    pointer-events: none;
  }
  .glow-purple {
    position: absolute;
    width: 700px;
    height: 700px;
    top: 100px;
    left: 550px;
    background: radial-gradient(circle, rgba(168, 85, 247, 0.13) 0%, transparent 70%);
    filter: blur(90px);
    pointer-events: none;
  }
  .glow-emerald {
    position: absolute;
    width: 650px;
    height: 650px;
    bottom: -150px;
    right: -80px;
    background: radial-gradient(circle, rgba(52, 211, 153, 0.14) 0%, transparent 70%);
    filter: blur(80px);
    pointer-events: none;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: relative;
    z-index: 10;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 18px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .brand-glyph {
    font-size: 28px;
    color: #38bdf8;
    filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.6));
  }
  .brand-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.18em;
    color: #f8fafc;
    text-transform: uppercase;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  .brand-sub {
    font-size: 13px;
    color: #94a3b8;
    letter-spacing: 0.04em;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-cluster {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .badge {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 6px 12px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .badge-cyan {
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.35);
    color: #38bdf8;
  }
  .badge-emerald {
    background: rgba(52, 211, 153, 0.1);
    border: 1px solid rgba(52, 211, 153, 0.35);
    color: #34d399;
  }
  .badge-purple {
    background: rgba(192, 132, 252, 0.1);
    border: 1px solid rgba(192, 132, 252, 0.35);
    color: #c084fc;
  }
  .badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 8px currentColor;
  }

  /* Main Columns Layout */
  .diagram-container {
    display: grid;
    grid-template-columns: 460px 48px 540px 48px 460px;
    align-items: center;
    position: relative;
    z-index: 10;
    margin: 24px 0;
    height: 740px;
  }

  /* Pillar Cards */
  .pillar {
    height: 100%;
    background: rgba(15, 23, 42, 0.65);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    padding: 24px;
    position: relative;
    box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.5);
  }
  .pillar-cyan {
    border-color: rgba(56, 189, 248, 0.3);
    box-shadow: 0 0 30px -10px rgba(56, 189, 248, 0.15), inset 0 1px 0 rgba(56, 189, 248, 0.3);
  }
  .pillar-purple {
    border-color: rgba(192, 132, 252, 0.35);
    box-shadow: 0 0 35px -10px rgba(168, 85, 247, 0.18), inset 0 1px 0 rgba(192, 132, 252, 0.3);
  }
  .pillar-emerald {
    border-color: rgba(52, 211, 153, 0.3);
    box-shadow: 0 0 30px -10px rgba(52, 211, 153, 0.15), inset 0 1px 0 rgba(52, 211, 153, 0.3);
  }

  .pillar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .pillar-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pillar-title-cyan { color: #38bdf8; }
  .pillar-title-purple { color: #c084fc; }
  .pillar-title-emerald { color: #34d399; }
  
  .pillar-tag {
    font-size: 10.5px;
    font-family: ui-monospace, monospace;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
    color: #94a3b8;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  /* Node Items Inside Pillar */
  .node-stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    justify-content: space-between;
  }
  .node-card {
    background: rgba(30, 41, 59, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    padding: 13px 15px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: all 0.2s ease;
  }
  .node-card:hover {
    background: rgba(30, 41, 59, 0.8);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .node-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .node-name {
    font-size: 13.5px;
    font-weight: 600;
    color: #f1f5f9;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .node-name-icon {
    font-size: 14px;
  }
  .node-badge {
    font-size: 10px;
    font-family: ui-monospace, monospace;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .nb-cyan { background: rgba(56, 189, 248, 0.12); color: #38bdf8; }
  .nb-purple { background: rgba(192, 132, 252, 0.15); color: #c084fc; }
  .nb-emerald { background: rgba(52, 211, 153, 0.12); color: #34d399; }
  .nb-amber { background: rgba(251, 191, 36, 0.12); color: #fbbf24; }
  .nb-pink { background: rgba(244, 114, 182, 0.12); color: #f472b6; }

  .node-desc {
    font-size: 11.5px;
    color: #94a3b8;
    line-height: 1.4;
  }

  /* Inner Subgroup */
  .subgroup {
    background: rgba(15, 23, 42, 0.5);
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .subgroup-label {
    font-size: 10.5px;
    font-family: ui-monospace, monospace;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #cbd5e1;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Connectors (Middle Bus) */
  .bus-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    position: relative;
  }
  .bus-line {
    width: 2px;
    height: 80%;
    background: linear-gradient(180deg, transparent, rgba(56, 189, 248, 0.4) 20%, rgba(192, 132, 252, 0.4) 80%, transparent);
    position: absolute;
  }
  .bus-chip {
    background: #0b1120;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    padding: 6px 8px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    color: #38bdf8;
    z-index: 5;
    text-align: center;
    line-height: 1.2;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    letter-spacing: 0.04em;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .bus-chip-right {
    color: #34d399;
  }
  .bus-arrow {
    font-size: 11px;
    opacity: 0.7;
  }

  /* Host Agent Stores Box */
  .store-container {
    background: rgba(15, 23, 42, 0.7);
    border: 1px dashed rgba(244, 114, 182, 0.35);
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .store-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .store-title {
    font-size: 11px;
    font-weight: 700;
    color: #f472b6;
    font-family: ui-monospace, monospace;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .store-items {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
  }
  .store-pill {
    background: rgba(244, 114, 182, 0.08);
    border: 1px solid rgba(244, 114, 182, 0.2);
    border-radius: 6px;
    padding: 6px 8px;
    text-align: center;
  }
  .store-dir {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    color: #fbcfe8;
  }
  .store-cli {
    font-size: 9.5px;
    color: #94a3b8;
  }

  /* Footer Invariants */
  .footer {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    position: relative;
    z-index: 10;
    padding-top: 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .invariant-card {
    background: rgba(15, 23, 42, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 10px;
    padding: 10px 14px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .inv-icon {
    font-size: 15px;
    margin-top: 1px;
  }
  .inv-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .inv-title {
    font-size: 11.5px;
    font-weight: 700;
    color: #f1f5f9;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
  }
  .inv-desc {
    font-size: 10.5px;
    color: #94a3b8;
    line-height: 1.35;
  }

</style>
</head>
<body>
  <div class="grid-bg"></div>
  <div class="glow-cyan"></div>
  <div class="glow-purple"></div>
  <div class="glow-emerald"></div>

  <!-- Header -->
  <div class="header">
    <div class="brand">
      <div class="brand-glyph">⚡</div>
      <div>
        <div class="brand-title">SPARKMUX ARCHITECTURE</div>
        <div class="brand-sub">Autonomous AI Agent Multiplexer & Telemetry Engine</div>
      </div>
    </div>
    <div class="status-cluster">
      <div class="badge badge-cyan"><span class="badge-dot"></span>CONTROL MODE PIPES</div>
      <div class="badge badge-purple"><span class="badge-dot"></span>100% READ-ONLY INGEST</div>
      <div class="badge badge-emerald"><span class="badge-dot"></span>PRIVATE SOCKET (-L sparkmux)</div>
    </div>
  </div>

  <!-- 3 Pillar Layout -->
  <div class="diagram-container">
    
    <!-- PILLAR 1: Presentation Layer -->
    <div class="pillar pillar-cyan">
      <div class="pillar-header">
        <div class="pillar-title pillar-title-cyan">
          <span>01</span>
          <span>Presentation Layer</span>
        </div>
        <div class="pillar-tag">CLIENT RUNTIME</div>
      </div>

      <div class="node-stack">
        <!-- Desktop App -->
        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">🪟</span> Tiled Terminals</span>
            <span class="node-badge nb-cyan">xterm.js Canvas</span>
          </div>
          <div class="node-desc">True tiled native terminals matching tmux <code>window_layout</code>. %output demux.</div>
        </div>

        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">📑</span> Sidebar & Agent Board</span>
            <span class="node-badge nb-cyan">Attention</span>
          </div>
          <div class="node-desc">Session tree, unread badges, and <code>needs_user</code> pending question extraction.</div>
        </div>

        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">📋</span> Output Logs Follower</span>
            <span class="node-badge nb-cyan">Turn Studio</span>
          </div>
          <div class="node-desc">Prompt preview cards, collapsible reasoning/tool trees, editor path jumps.</div>
        </div>

        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">🌐</span> 3D Area Map & HUD</span>
            <span class="node-badge nb-cyan">WebGL2</span>
          </div>
          <div class="node-desc">4-channel terrain (Rect / Globe), 3D neural cortex, token spectrum, TTFT.</div>
        </div>

        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">⬡</span> Gits & Chronicle</span>
            <span class="node-badge nb-cyan">Graph Studio</span>
          </div>
          <div class="node-desc">5 Canvas layouts, diff search (<code>⚡ DIFF</code> / <code>📄 FULL</code>), mutation timeline deck.</div>
        </div>

        <!-- Mobile Client -->
        <div class="node-card" style="border-color: rgba(56, 189, 248, 0.25); background: rgba(14, 165, 233, 0.08);">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">📱</span> Mobile Remote Client</span>
            <span class="node-badge nb-cyan">iPhone / iPad PWA</span>
          </div>
          <div class="node-desc">Axum <code>/ws</code> stream, touch KeyBar, Phone sheet & Duo hinge adaptive split postures.</div>
        </div>
      </div>
    </div>

    <!-- BUS 1: Presentation <-> Core -->
    <div class="bus-column">
      <div class="bus-line"></div>
      <div class="bus-chip">
        <span class="bus-arrow">◀▶</span>
        <span>TAURI IPC</span>
        <span style="font-size: 8.5px; opacity: 0.65;">Commands</span>
        <span class="bus-arrow">◀▶</span>
        <span>AXUM /ws</span>
        <span style="font-size: 8.5px; opacity: 0.65;">JSON-RPC</span>
      </div>
    </div>

    <!-- PILLAR 2: Rust Engine & Core -->
    <div class="pillar pillar-purple">
      <div class="pillar-header">
        <div class="pillar-title pillar-title-purple">
          <span>02</span>
          <span>Rust Backend & Core</span>
        </div>
        <div class="pillar-tag">src-tauri & core</div>
      </div>

      <div class="node-stack">
        <!-- Backend IPC & Servers -->
        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">⚡</span> Tauri IPC & Axum Hub</span>
            <span class="node-badge nb-purple">Event Hub</span>
          </div>
          <div class="node-desc">Event broadcast router, remote pairing cookie validator, multi-window state sync.</div>
        </div>

        <!-- AI Follower -->
        <div class="node-card" style="border-color: rgba(192, 132, 252, 0.3);">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">🔍</span> Read-Only AI Follower</span>
            <span class="node-badge nb-purple">ingest.rs</span>
          </div>
          <div class="node-desc">Incremental transcript tail for Grok, Claude, and Antigravity. SSH jail isolated cache.</div>
        </div>

        <!-- Attention & Git Engine -->
        <div class="subgroup">
          <div class="subgroup-label"><span>⚙️</span> Real-Time Analytics Engines</div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div style="background: rgba(30, 41, 59, 0.6); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
              <div style="font-size: 11.5px; font-weight: 600; color: #f1f5f9; margin-bottom: 2px;">🔔 Attention Engine</div>
              <div style="font-size: 10px; color: #94a3b8;">Agent state classifier & quota countdown meters.</div>
            </div>
            <div style="background: rgba(30, 41, 59, 0.6); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
              <div style="font-size: 11.5px; font-weight: 600; color: #f1f5f9; margin-bottom: 2px;">🌿 Git Change Graph</div>
              <div style="font-size: 10px; color: #94a3b8;">Multi-repo diff engine & Chronicle transit timeline.</div>
            </div>
          </div>
        </div>

        <!-- Core Multiplexer Engine -->
        <div class="subgroup" style="border-color: rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.03);">
          <div class="subgroup-label" style="color: #fbbf24;"><span>📐</span> sparkmux-core (Pure Tmux Engine)</div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.5); padding: 6px 10px; border-radius: 6px;">
              <span style="font-size: 11px; color: #f8fafc; font-weight: 600;">Control Client (tmux -C)</span>
              <span class="node-badge nb-amber">Stdio Protocol</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.5); padding: 6px 10px; border-radius: 6px;">
              <span style="font-size: 11px; color: #f8fafc; font-weight: 600;">Layout Parser</span>
              <span style="font-size: 10px; color: #cbd5e1; font-family: monospace;">window_layout ➔ tile tree</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.5); padding: 6px 10px; border-radius: 6px;">
              <span style="font-size: 11px; color: #f8fafc; font-weight: 600;">ScreenClient & Seed</span>
              <span style="font-size: 10px; color: #cbd5e1; font-family: monospace;">capture-pane scrollback bootstrap</span>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- BUS 2: Core <-> Tmux Host -->
    <div class="bus-column">
      <div class="bus-line"></div>
      <div class="bus-chip bus-chip-right">
        <span class="bus-arrow">◀▶</span>
        <span>%output</span>
        <span style="font-size: 8.5px; opacity: 0.65;">send-keys -H</span>
        <span class="bus-arrow">◀▶</span>
        <span>CONTROL PIPES</span>
        <span style="font-size: 8.5px; opacity: 0.65;">Stdio Demux</span>
      </div>
    </div>

    <!-- PILLAR 3: Host Runtime & Isolated Server -->
    <div class="pillar pillar-emerald">
      <div class="pillar-header">
        <div class="pillar-title pillar-title-emerald">
          <span>03</span>
          <span>Host System & Daemon</span>
        </div>
        <div class="pillar-tag">RUNTIME LAYER</div>
      </div>

      <div class="node-stack">
        <!-- Private tmux Daemon -->
        <div class="node-card" style="border-color: rgba(52, 211, 153, 0.35); background: rgba(16, 185, 129, 0.06);">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">🔒</span> Private tmux Server</span>
            <span class="node-badge nb-emerald">-L sparkmux</span>
          </div>
          <div class="node-desc">Dedicated server socket. GUI quit detaches only; server, shells, and agent processes persist.</div>
        </div>

        <!-- Native PTY Panes -->
        <div class="node-card">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">💻</span> Native PTY Shells</span>
            <span class="node-badge nb-emerald">zsh · bash · fish</span>
          </div>
          <div class="node-desc">Standard OS shells with full ANSI/VT100 fidelity, path pasting, and scrollback search.</div>
        </div>

        <!-- Autonomous AI Agents -->
        <div class="node-card" style="border-color: rgba(56, 189, 248, 0.3);">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">🤖</span> Autonomous Coding Agents</span>
            <span class="node-badge nb-cyan">Active CLIs</span>
          </div>
          <div class="node-desc">Running in foreground panes: Grok Build, Claude Code, and Google Antigravity CLI.</div>
        </div>

        <!-- Strict Read-Only Stores Box -->
        <div class="store-container">
          <div class="store-header">
            <span class="store-title"><span>📂</span> External Agent Transcripts</span>
            <span class="node-badge nb-pink">100% READ-ONLY TAIL</span>
          </div>
          <div style="font-size: 10.5px; color: #cbd5e1; line-height: 1.3; margin-bottom: 2px;">
            Sparkmux strictly watches host session files—never modifying CLI directories or external agent stores.
          </div>
          <div class="store-items">
            <div class="store-pill">
              <div class="store-dir">~/.grok</div>
              <div class="store-cli">Grok Build</div>
            </div>
            <div class="store-pill">
              <div class="store-dir">~/.claude</div>
              <div class="store-cli">Claude Code</div>
            </div>
            <div class="store-pill">
              <div class="store-dir">~/.gemini</div>
              <div class="store-cli">Antigravity CLI</div>
            </div>
          </div>
        </div>

        <!-- External CLI Attach -->
        <div class="node-card" style="background: rgba(15, 23, 42, 0.4); border-style: dashed;">
          <div class="node-title-row">
            <span class="node-name"><span class="node-name-icon">⚡</span> External Terminal Attach</span>
            <span class="node-badge nb-amber">CLI Utility</span>
          </div>
          <div class="node-desc">Follow focused panes from any terminal: <code>tmux -L sparkmux attach</code>.</div>
        </div>

      </div>
    </div>

  </div>

  <!-- Footer Invariants -->
  <div class="footer">
    <div class="invariant-card">
      <div class="inv-icon">🔒</div>
      <div class="inv-body">
        <div class="inv-title">ISOLATED SERVER (-L sparkmux)</div>
        <div class="inv-desc">Sparkmux never touches or lists your default <code>$TMUX</code> server. Full isolation.</div>
      </div>
    </div>
    <div class="invariant-card">
      <div class="inv-icon">⚡</div>
      <div class="inv-body">
        <div class="inv-title">PURE CONTROL-MODE I/O</div>
        <div class="inv-desc">Zero terminal screen polling (<code>capture-pane</code> is bootstrap seed only). Pure <code>%output</code> demux.</div>
      </div>
    </div>
    <div class="invariant-card">
      <div class="inv-icon">🔍</div>
      <div class="inv-body">
        <div class="inv-title">READ-ONLY AGENT FOLLOWER</div>
        <div class="inv-desc">Watches external CLI transcripts with zero filesystem mutation. SSH panes are strictly jailed.</div>
      </div>
    </div>
    <div class="invariant-card">
      <div class="inv-icon">📱</div>
      <div class="inv-body">
        <div class="inv-title">UNIFIED MOBILE RUNTIME</div>
        <div class="inv-desc">Single React 19 codebase served to iPhone & iPad with tactile KeyBar and posture splits.</div>
      </div>
    </div>
  </div>

</body>
</html>
"""

def main():
    chrome_path = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not chrome_path.exists():
        print("Error: Google Chrome not found at default macOS path", file=sys.stderr)
        sys.exit(1)

    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(HTML_TEMPLATE)
        temp_html = f.name

    try:
        cmd = [
            str(chrome_path),
            "--headless=new",
            "--disable-gpu",
            "--force-device-scale-factor=2",
            "--window-size=1720,980",
            f"--screenshot={OUTPUT_IMAGE}",
            f"file://{temp_html}",
        ]
        print(f"Rendering high-DPI architecture diagram to {OUTPUT_IMAGE}...")
        subprocess.run(cmd, check=True)
        print("Successfully generated docs/architecture.png!")
    finally:
        Path(temp_html).unlink(missing_ok=True)

if __name__ == "__main__":
    main()
