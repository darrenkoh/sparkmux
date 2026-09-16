use ansi_to_tui::IntoText;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;
use sparkmux_core::strip_ansi;

use crate::app::{App, InputKind, KillTarget, MiddleItem, Modal, Panel};

pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let banner = app.version_banner.is_some();
    let footer_h = if matches!(app.modal, Modal::Input { .. } | Modal::ConfirmKill { .. })
        || app.toast_msg.is_some()
    {
        3
    } else {
        2
    };

    let mut constraints = Vec::new();
    if banner {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Min(3));
    constraints.push(Constraint::Length(footer_h));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);

    let mut idx = 0;
    if banner {
        let text = app.version_banner.as_deref().unwrap_or("");
        frame.render_widget(
            Paragraph::new(text).style(Style::default().fg(Color::Yellow).bg(Color::DarkGray)),
            chunks[idx],
        );
        idx += 1;
    }
    let main = chunks[idx];
    let footer = chunks[idx + 1];

    let (sessions_a, windows_a, preview_a) = split_main(main);
    draw_sessions(frame, app, sessions_a);
    draw_windows(frame, app, windows_a);
    draw_preview(frame, app, preview_a);
    draw_footer(frame, app, footer);

    if matches!(app.modal, Modal::Help) {
        draw_help(frame, main);
    }
}

fn split_main(area: Rect) -> (Rect, Rect, Rect) {
    if area.width >= 100 {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(28),
                Constraint::Percentage(32),
                Constraint::Percentage(40),
            ])
            .split(area);
        (cols[0], cols[1], cols[2])
    } else {
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
            .split(area);
        let top = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
            .split(rows[0]);
        (top[0], top[1], rows[1])
    }
}

fn focused_style(focused: bool) -> Style {
    if focused {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::Gray)
    }
}

fn draw_sessions(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.panel == Panel::Sessions;
    let block = Block::default()
        .title(" Sessions ")
        .borders(Borders::ALL)
        .border_style(focused_style(focused));

    if app.snapshot.sessions.is_empty() {
        let msg = match &app.server_error {
            Some(err) => format!("no tmux server\n\nstart tmux or check -L/-S\n\n{err}"),
            None => "no tmux server\n\nstart tmux or check -L/-S".into(),
        };
        frame.render_widget(
            Paragraph::new(msg)
                .block(block)
                .style(Style::default().fg(Color::DarkGray))
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }

    let items: Vec<ListItem> = app
        .snapshot
        .sessions
        .iter()
        .map(|s| {
            let att = if s.attached { "(att)" } else { "     " };
            let att_style = if s.attached {
                Style::default().fg(Color::Green)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            ListItem::new(Line::from(vec![
                Span::raw(format!(" {:<16} ", trunc(&s.name, 16))),
                Span::styled(att, att_style),
                Span::raw(format!(" {:>2}w", s.windows.len())),
            ]))
        })
        .collect();

    let mut state = ListState::default();
    state.select(app.session_index());
    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_windows(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.panel == Panel::Windows;
    let title = match app.current_session() {
        Some(s) => format!(" Windows / Panes  {} ", s.name),
        None => " Windows / Panes ".into(),
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(focused_style(focused));

    let items_src = app.middle_items();
    if items_src.is_empty() {
        frame.render_widget(Paragraph::new("(no windows)").block(block), area);
        return;
    }

    let items: Vec<ListItem> = items_src
        .iter()
        .map(|item| match item {
            MiddleItem::Window(w, expanded) => {
                let mark = if *expanded { "▾" } else { "▸" };
                let active = if w.active { " *" } else { "" };
                ListItem::new(format!(
                    "{mark} {}: {}  {}p{active}",
                    w.index,
                    trunc(&w.name, 20),
                    w.panes.len()
                ))
            }
            MiddleItem::Pane(_, p) => {
                let active = if p.active { " *" } else { "" };
                ListItem::new(format!("    {} {}{active}", p.id, trunc(&p.command, 18)))
            }
        })
        .collect();

    let mut state = ListState::default();
    state.select(app.middle_index());
    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_preview(frame: &mut Frame, app: &App, area: Rect) {
    let pane = app.resolve_preview_pane().unwrap_or("-");
    let title = format!(" Preview  {pane} ");
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Gray));

    let inner_h = area.height.saturating_sub(2) as usize;
    let body = if app.preview.text.is_empty() {
        "(no preview)"
    } else {
        app.preview.text.as_str()
    };

    let paragraph = match body.into_text() {
        Ok(text) => {
            let lines = text.lines.len().saturating_sub(inner_h.max(1));
            Paragraph::new(text).block(block).scroll((lines as u16, 0))
        }
        Err(_) => {
            let plain = strip_ansi(body);
            let lines = plain.lines().count().saturating_sub(inner_h.max(1));
            Paragraph::new(plain).block(block).scroll((lines as u16, 0))
        }
    };
    frame.render_widget(paragraph, area);
}

fn draw_footer(frame: &mut Frame, app: &App, area: Rect) {
    let n = app.snapshot.sessions.len();
    let left = format!(" sparkmux  {n} sessions");
    let keys =
        " j/k move  Tab panel  n new  r rename  d kill  Enter attach  R refresh  ? help  q quit ";

    match &app.modal {
        Modal::Input { kind, buffer } => {
            let prompt = match kind {
                InputKind::NewSession => "new session",
                InputKind::NewWindow => "new window",
                InputKind::RenameSession => "rename session",
                InputKind::RenameWindow => "rename window",
            };
            let line = format!(" {prompt}: {buffer}");
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(line, Style::default().fg(Color::Yellow)),
                    Span::styled("█", Style::default().fg(Color::Yellow)),
                ]))
                .block(Block::default().borders(Borders::TOP)),
                area,
            );
        }
        Modal::ConfirmKill { target, name } => {
            let kind = match target {
                KillTarget::Session(_) => "session",
                KillTarget::Window(_) => "window",
                KillTarget::Pane(_) => "pane",
            };
            let line = format!(" kill {kind} '{name}'? [y/n]");
            frame.render_widget(
                Paragraph::new(line)
                    .style(Style::default().fg(Color::Red))
                    .block(Block::default().borders(Borders::TOP)),
                area,
            );
        }
        _ => {
            let mut lines = vec![Line::from(vec![
                Span::styled(left, Style::default().fg(Color::Cyan)),
                Span::raw(" │ "),
                Span::raw(keys),
            ])];
            if let Some(msg) = &app.toast_msg {
                lines.push(Line::from(Span::styled(
                    format!(" {msg}"),
                    Style::default().fg(Color::Red),
                )));
            } else if let Some(err) = &app.server_error {
                lines.push(Line::from(Span::styled(
                    format!(" {err}"),
                    Style::default().fg(Color::DarkGray),
                )));
            }
            frame.render_widget(Paragraph::new(lines), area);
        }
    }
}

fn draw_help(frame: &mut Frame, area: Rect) {
    let help = "\
sparkmux keys

  j/k  ↓/↑     next / prev
  h/l  ←/→     collapse / expand, change panel
  Tab            cycle panels
  g / G          first / last
  Enter          attach (outside) or switch (inside)
  n              new session / window
  r              rename session / window
  d              kill session / window / pane (y/n)
  Space          expand / collapse window
  R              refresh
  ?              close help
  q / Esc        quit

Inside tmux: Enter runs switch-client then quits.
Outside tmux: Enter execs tmux attach-session.
Clipboard yank is v1, not in this build.
";
    let popup = centered(area, 62, 22);
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(help).wrap(Wrap { trim: false }).block(
            Block::default()
                .title(" Help ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan)),
        ),
        popup,
    );
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    }
}

fn trunc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}
