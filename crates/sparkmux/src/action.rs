use sparkmux_core::{decide_attach, AttachAction};

use crate::app::{App, InputKind, KillTarget, Modal, Panel};
use crate::event::Action;

pub fn dispatch(app: &mut App, action: Action) {
    match action {
        Action::Quit => app.should_quit = true,
        Action::MoveNext => move_list(app, 1),
        Action::MovePrev => move_list(app, -1),
        Action::MoveParent => move_parent(app),
        Action::MoveChild => move_child(app),
        Action::PanelNext | Action::PanelPrev => toggle_panel(app),
        Action::First => move_end(app, true),
        Action::Last => move_end(app, false),
        Action::Attach => attach(app),
        Action::New => start_new(app),
        Action::Rename => start_rename(app),
        Action::Kill => start_kill(app),
        Action::Refresh => app.reload_snapshot_sync(),
        Action::ToggleHelp => toggle_help(app),
        Action::ToggleExpand => toggle_expand(app),
        Action::ConfirmYes => confirm_kill(app),
        Action::ConfirmNo => app.modal = Modal::None,
        Action::InputChar(c) => {
            if let Modal::Input { buffer, .. } = &mut app.modal {
                if buffer.len() < 200 {
                    buffer.push(c);
                }
            }
        }
        Action::InputBackspace => {
            if let Modal::Input { buffer, .. } = &mut app.modal {
                buffer.pop();
            }
        }
        Action::InputSubmit => submit_input(app),
        Action::InputCancel => app.modal = Modal::None,
    }
}

fn toggle_help(app: &mut App) {
    app.modal = match app.modal {
        Modal::Help => Modal::None,
        _ => Modal::Help,
    };
}

fn toggle_panel(app: &mut App) {
    app.panel = match app.panel {
        Panel::Sessions => Panel::Windows,
        Panel::Windows => Panel::Sessions,
    };
}

fn move_list(app: &mut App, delta: i32) {
    match app.panel {
        Panel::Sessions => {
            let n = app.snapshot.sessions.len();
            if n == 0 {
                return;
            }
            let idx = app.session_index().unwrap_or(0);
            let next = (idx as i32 + delta).clamp(0, n as i32 - 1) as usize;
            app.select_session(next);
        }
        Panel::Windows => {
            let items = app.middle_items();
            if items.is_empty() {
                return;
            }
            let idx = app.middle_index().unwrap_or(0);
            let next = (idx as i32 + delta).clamp(0, items.len() as i32 - 1) as usize;
            app.select_middle(next);
        }
    }
}

fn move_end(app: &mut App, first: bool) {
    match app.panel {
        Panel::Sessions => {
            if app.snapshot.sessions.is_empty() {
                return;
            }
            let idx = if first {
                0
            } else {
                app.snapshot.sessions.len() - 1
            };
            app.select_session(idx);
        }
        Panel::Windows => {
            let items = app.middle_items();
            if items.is_empty() {
                return;
            }
            let idx = if first { 0 } else { items.len() - 1 };
            app.select_middle(idx);
        }
    }
}

fn move_child(app: &mut App) {
    match app.panel {
        Panel::Sessions => app.panel = Panel::Windows,
        Panel::Windows => {
            let Some(idx) = app.middle_index() else {
                return;
            };
            let expand = match app.middle_items().get(idx).copied() {
                Some(crate::app::MiddleItem::Window(window, expanded)) => {
                    Some((window.id.clone(), !window.panes.is_empty(), expanded))
                }
                _ => None,
            };
            let Some((id, has_panes, expanded)) = expand else {
                return;
            };
            if !expanded {
                app.expanded.insert(id);
            }
            if has_panes {
                if let Some(new_idx) = app.middle_index() {
                    let next = (new_idx + 1).min(app.middle_items().len().saturating_sub(1));
                    app.select_middle(next);
                }
            }
        }
    }
}

fn move_parent(app: &mut App) {
    match app.panel {
        Panel::Sessions => {}
        Panel::Windows => {
            let Some(idx) = app.middle_index() else {
                app.panel = Panel::Sessions;
                return;
            };
            let decision = match app.middle_items().get(idx).copied() {
                Some(crate::app::MiddleItem::Pane(window, _)) => {
                    ParentMove::ToWindow(window.id.clone())
                }
                Some(crate::app::MiddleItem::Window(window, true)) => {
                    ParentMove::Collapse(window.id.clone())
                }
                _ => ParentMove::ToSessions,
            };
            match decision {
                ParentMove::ToWindow(wid) => {
                    if let Some(c) = app.cursor.as_mut() {
                        c.window_id = Some(wid);
                        c.pane_id = None;
                    }
                    app.update_preview_target();
                }
                ParentMove::Collapse(id) => {
                    app.expanded.remove(&id);
                }
                ParentMove::ToSessions => app.panel = Panel::Sessions,
            }
        }
    }
}

enum ParentMove {
    ToWindow(String),
    Collapse(String),
    ToSessions,
}

fn toggle_expand(app: &mut App) {
    if app.panel != Panel::Windows {
        return;
    }
    let Some(idx) = app.middle_index() else {
        return;
    };
    let act = match app.middle_items().get(idx).copied() {
        Some(crate::app::MiddleItem::Window(window, expanded)) => {
            Some((window.id.clone(), expanded, false))
        }
        Some(crate::app::MiddleItem::Pane(window, _)) => Some((window.id.clone(), true, true)),
        None => None,
    };
    let Some((id, collapse, from_pane)) = act else {
        return;
    };
    if collapse {
        app.expanded.remove(&id);
    } else {
        app.expanded.insert(id.clone());
    }
    if from_pane {
        if let Some(c) = app.cursor.as_mut() {
            c.window_id = Some(id);
            c.pane_id = None;
        }
        app.update_preview_target();
    }
}

fn attach(app: &mut App) {
    let Some(cursor) = app.cursor.clone() else {
        app.toast("no session");
        return;
    };
    let Some(client) = app.client.clone() else {
        app.toast("tmux binary not found");
        return;
    };
    match decide_attach(app.inside, &cursor) {
        AttachAction::Switch {
            session,
            window,
            pane,
        } => {
            if let Err(e) = client.switch_client(&session) {
                app.toast(e.to_string());
                return;
            }
            if let Some(w) = window {
                if let Err(e) = client.select_window(&w) {
                    app.toast(e.to_string());
                    return;
                }
            }
            if let Some(p) = pane {
                if let Err(e) = client.select_pane(&p) {
                    app.toast(e.to_string());
                    return;
                }
            }
            app.should_quit = true;
        }
        AttachAction::Attach {
            session,
            window,
            pane,
        } => {
            if let Some(w) = window {
                if let Err(e) = client.select_window(&w) {
                    app.toast(e.to_string());
                    return;
                }
            }
            if let Some(p) = pane {
                if let Err(e) = client.select_pane(&p) {
                    app.toast(e.to_string());
                    return;
                }
            }
            app.pending_exec = Some(session);
        }
    }
}

fn start_new(app: &mut App) {
    if !app.ensure_writable() {
        return;
    }
    match app.panel {
        Panel::Sessions => {
            app.modal = Modal::Input {
                kind: InputKind::NewSession,
                buffer: String::new(),
            };
        }
        Panel::Windows => {
            if app.cursor.is_none() {
                app.toast("no session");
                return;
            }
            app.modal = Modal::Input {
                kind: InputKind::NewWindow,
                buffer: String::new(),
            };
        }
    }
}

fn start_rename(app: &mut App) {
    if !app.ensure_writable() {
        return;
    }
    let Some(cursor) = app.cursor.clone() else {
        app.toast("no session");
        return;
    };
    match app.panel {
        Panel::Sessions => {
            let name = app
                .current_session()
                .map(|s| s.name.clone())
                .unwrap_or_default();
            app.modal = Modal::Input {
                kind: InputKind::RenameSession,
                buffer: name,
            };
        }
        Panel::Windows => {
            let Some(wid) = cursor.window_id else {
                app.toast("no window");
                return;
            };
            let name = app
                .current_session()
                .and_then(|s| s.windows.iter().find(|w| w.id == wid))
                .map(|w| w.name.clone())
                .unwrap_or_default();
            app.modal = Modal::Input {
                kind: InputKind::RenameWindow,
                buffer: name,
            };
        }
    }
}

fn start_kill(app: &mut App) {
    if !app.ensure_writable() {
        return;
    }
    let Some(cursor) = app.cursor.clone() else {
        app.toast("no session");
        return;
    };
    match app.panel {
        Panel::Sessions => {
            let name = app
                .current_session()
                .map(|s| s.name.clone())
                .unwrap_or_else(|| cursor.session_id.clone());
            app.modal = Modal::ConfirmKill {
                target: KillTarget::Session(cursor.session_id),
                name,
            };
        }
        Panel::Windows => {
            if let Some(pid) = cursor.pane_id.filter(|_| {
                matches!(
                    app.middle_items().get(app.middle_index().unwrap_or(0)),
                    Some(crate::app::MiddleItem::Pane(_, _))
                )
            }) {
                let name = app.resolve_pane_name(&pid).unwrap_or_else(|| pid.clone());
                app.modal = Modal::ConfirmKill {
                    target: KillTarget::Pane(pid),
                    name,
                };
            } else if let Some(wid) = cursor.window_id {
                let name = app
                    .current_session()
                    .and_then(|s| s.windows.iter().find(|w| w.id == wid))
                    .map(|w| w.name.clone())
                    .unwrap_or_else(|| wid.clone());
                app.modal = Modal::ConfirmKill {
                    target: KillTarget::Window(wid),
                    name,
                };
            } else {
                app.toast("no window");
            }
        }
    }
}

fn confirm_kill(app: &mut App) {
    let Modal::ConfirmKill { target, .. } = app.modal.clone() else {
        return;
    };
    app.modal = Modal::None;
    let Some(client) = app.client.clone() else {
        app.toast("tmux binary not found");
        return;
    };
    let result = match target {
        KillTarget::Session(id) => client.kill_session(&id),
        KillTarget::Window(id) => client.kill_window(&id),
        KillTarget::Pane(id) => client.kill_pane(&id),
    };
    if let Err(e) = result {
        app.toast(e.to_string());
    }
    app.reload_snapshot_sync();
}

fn submit_input(app: &mut App) {
    let Modal::Input { kind, buffer } = app.modal.clone() else {
        return;
    };
    let name = buffer.trim().to_string();
    if name.is_empty() {
        app.toast("name required");
        return;
    }
    app.modal = Modal::None;
    let Some(client) = app.client.clone() else {
        app.toast("tmux binary not found");
        return;
    };
    let result = match kind {
        InputKind::NewSession => client.new_session(&name),
        InputKind::NewWindow => {
            let Some(cursor) = app.cursor.as_ref() else {
                app.toast("no session");
                return;
            };
            client.new_window(&cursor.session_id, &name)
        }
        InputKind::RenameSession => {
            let Some(cursor) = app.cursor.as_ref() else {
                app.toast("no session");
                return;
            };
            client.rename_session(&cursor.session_id, &name)
        }
        InputKind::RenameWindow => {
            let Some(wid) = app.cursor.as_ref().and_then(|c| c.window_id.clone()) else {
                app.toast("no window");
                return;
            };
            client.rename_window(&wid, &name)
        }
    };
    if let Err(e) = result {
        app.toast(e.to_string());
    }
    app.reload_snapshot_sync();
}
