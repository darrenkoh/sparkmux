use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::app::Modal;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Quit,
    MoveNext,
    MovePrev,
    MoveParent,
    MoveChild,
    PanelNext,
    PanelPrev,
    First,
    Last,
    Attach,
    New,
    Rename,
    Kill,
    Refresh,
    ToggleHelp,
    ToggleExpand,
    ConfirmYes,
    ConfirmNo,
    InputChar(char),
    InputBackspace,
    InputSubmit,
    InputCancel,
}

pub fn map_key(key: KeyEvent, modal: &Modal) -> Option<Action> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')) {
        return Some(Action::Quit);
    }

    match modal {
        Modal::Input { .. } => match key.code {
            KeyCode::Esc => Some(Action::InputCancel),
            KeyCode::Enter => Some(Action::InputSubmit),
            KeyCode::Backspace => Some(Action::InputBackspace),
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                Some(Action::InputChar(c))
            }
            _ => None,
        },
        Modal::ConfirmKill { .. } => match key.code {
            KeyCode::Char('y' | 'Y') => Some(Action::ConfirmYes),
            KeyCode::Char('n' | 'N') | KeyCode::Esc => Some(Action::ConfirmNo),
            _ => None,
        },
        Modal::Help => match key.code {
            KeyCode::Char('?') | KeyCode::Esc => Some(Action::ToggleHelp),
            KeyCode::Char('q') => Some(Action::Quit),
            _ => None,
        },
        Modal::None => match key.code {
            KeyCode::Char('q') | KeyCode::Esc => Some(Action::Quit),
            KeyCode::Char('j') | KeyCode::Down => Some(Action::MoveNext),
            KeyCode::Char('k') | KeyCode::Up => Some(Action::MovePrev),
            KeyCode::Char('h') | KeyCode::Left => Some(Action::MoveParent),
            KeyCode::Char('l') | KeyCode::Right => Some(Action::MoveChild),
            KeyCode::Tab => Some(Action::PanelNext),
            KeyCode::BackTab => Some(Action::PanelPrev),
            KeyCode::Char('g') => Some(Action::First),
            KeyCode::Char('G') => Some(Action::Last),
            KeyCode::Enter => Some(Action::Attach),
            KeyCode::Char('n') => Some(Action::New),
            KeyCode::Char('r') => Some(Action::Rename),
            KeyCode::Char('d') => Some(Action::Kill),
            KeyCode::Char('R') => Some(Action::Refresh),
            KeyCode::Char('?') => Some(Action::ToggleHelp),
            KeyCode::Char(' ') => Some(Action::ToggleExpand),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{InputKind, Modal};

    fn press(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn map_key_navigation_and_quit() {
        assert_eq!(
            map_key(press(KeyCode::Char('j')), &Modal::None),
            Some(Action::MoveNext)
        );
        assert_eq!(
            map_key(press(KeyCode::Enter), &Modal::None),
            Some(Action::Attach)
        );
        assert_eq!(
            map_key(press(KeyCode::Char('q')), &Modal::None),
            Some(Action::Quit)
        );
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(map_key(ctrl_c, &Modal::None), Some(Action::Quit));
    }

    #[test]
    fn map_key_input_modal_overrides() {
        let modal = Modal::Input {
            kind: InputKind::NewSession,
            buffer: String::new(),
        };
        assert_eq!(
            map_key(press(KeyCode::Char('q')), &modal),
            Some(Action::InputChar('q'))
        );
        assert_eq!(
            map_key(press(KeyCode::Enter), &modal),
            Some(Action::InputSubmit)
        );
        assert_eq!(
            map_key(press(KeyCode::Esc), &modal),
            Some(Action::InputCancel)
        );
    }

    #[test]
    fn map_key_confirm_modal() {
        let modal = Modal::ConfirmKill {
            target: crate::app::KillTarget::Session("$0".into()),
            name: "work".into(),
        };
        assert_eq!(
            map_key(press(KeyCode::Char('y')), &modal),
            Some(Action::ConfirmYes)
        );
        assert_eq!(
            map_key(press(KeyCode::Esc), &modal),
            Some(Action::ConfirmNo)
        );
    }
}
