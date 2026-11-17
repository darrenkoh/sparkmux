use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SplitDir {
    LeftRight,
    TopBottom,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LayoutNode {
    Pane {
        w: u16,
        h: u16,
        x: u16,
        y: u16,
        pane_id: u32,
    },
    Split {
        w: u16,
        h: u16,
        x: u16,
        y: u16,
        dir: SplitDir,
        children: Vec<LayoutNode>,
    },
}

pub fn parse_window_layout(s: &str) -> Result<LayoutNode> {
    let trimmed = s.trim();
    if trimmed.starts_with('{') {
        return parse_json_window_layout(trimmed);
    }
    let body = trimmed
        .split_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let mut p = Parser {
        bytes: body.as_bytes(),
        i: 0,
    };
    let node = p.parse_node()?;
    Ok(node)
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum JsonLayoutRoot {
    Envelope {
        #[serde(rename = "L")]
        layout: JsonLayoutCell,
    },
    Cell(JsonLayoutCell),
}

#[derive(Clone, serde::Deserialize)]
struct JsonLayoutCell {
    t: String,
    w: i64,
    h: i64,
    x: i64,
    y: i64,
    #[serde(default)]
    c: Vec<JsonLayoutCell>,
    #[serde(default)]
    i: Option<u32>,
    #[serde(rename = "I", default)]
    pane_id: Option<String>,
    #[serde(default)]
    z: Option<i64>,
}

fn parse_json_window_layout(s: &str) -> Result<LayoutNode> {
    let root: JsonLayoutRoot =
        serde_json::from_str(s).map_err(|e| Error::Parse(format!("layout json: {e}")))?;
    let cell = match root {
        JsonLayoutRoot::Envelope { layout } => layout,
        JsonLayoutRoot::Cell(cell) => cell,
    };
    json_to_node(&cell)
}

fn cell_has_tiled(cell: &JsonLayoutCell) -> bool {
    match cell.t.as_str() {
        "p" => cell.z.is_none(),
        _ => cell.c.iter().any(cell_has_tiled),
    }
}

fn json_to_node(cell: &JsonLayoutCell) -> Result<LayoutNode> {
    if cell.w < 0 || cell.h < 0 {
        return Err(Error::Parse(format!(
            "layout: negative size {}x{}",
            cell.w, cell.h
        )));
    }
    let w = cell.w.min(u16::MAX as i64) as u16;
    let h = cell.h.min(u16::MAX as i64) as u16;
    let x = cell.x.clamp(0, u16::MAX as i64) as u16;
    let y = cell.y.clamp(0, u16::MAX as i64) as u16;

    match cell.t.as_str() {
        "p" => {
            // In tmux 3.8 V2 JSON, "i" is the window-local index while "I" is the global "%id".
            let pane_id = if let Some(raw) = cell.pane_id.as_deref() {
                let digits = raw.strip_prefix('%').unwrap_or(raw);
                digits
                    .parse::<u32>()
                    .map_err(|_| Error::Parse(format!("layout: bad pane id {raw:?}")))?
            } else if let Some(idx) = cell.i {
                idx
            } else {
                return Err(Error::Parse("layout: missing pane id".into()));
            };
            Ok(LayoutNode::Pane {
                w,
                h,
                x,
                y,
                pane_id,
            })
        }
        "h" | "v" => {
            let dir = if cell.t == "h" {
                SplitDir::LeftRight
            } else {
                SplitDir::TopBottom
            };
            let has_tiled = cell.c.iter().any(cell_has_tiled);
            let selected = cell
                .c
                .iter()
                .filter(|child| !has_tiled || cell_has_tiled(child));
            let mut children = Vec::new();
            for child in selected {
                children.push(json_to_node(child)?);
            }
            if children.is_empty() {
                return Err(Error::Parse("layout: split has no children".into()));
            }
            if children.len() == 1 {
                return Ok(children.into_iter().next().expect("single child"));
            }
            Ok(LayoutNode::Split {
                w,
                h,
                x,
                y,
                dir,
                children,
            })
        }
        other => Err(Error::Parse(format!("layout: unknown cell type {other:?}"))),
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.i).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.i += 1;
        Some(b)
    }

    fn eat(&mut self, expected: u8) -> Result<()> {
        match self.bump() {
            Some(b) if b == expected => Ok(()),
            other => Err(Error::Parse(format!(
                "layout: expected {} got {:?}",
                expected as char, other
            ))),
        }
    }

    fn parse_num<T: std::str::FromStr>(&mut self) -> Result<T> {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        if start == self.i {
            return Err(Error::Parse("layout: expected number".into()));
        }
        let s = std::str::from_utf8(&self.bytes[start..self.i])
            .map_err(|_| Error::Parse("layout: utf8".into()))?;
        s.parse()
            .map_err(|_| Error::Parse(format!("layout: bad number {s}")))
    }

    fn parse_node(&mut self) -> Result<LayoutNode> {
        let w = self.parse_num::<u16>()?;
        self.eat(b'x')?;
        let h = self.parse_num::<u16>()?;
        self.eat(b',')?;
        let x = self.parse_num::<u16>()?;
        self.eat(b',')?;
        let y = self.parse_num::<u16>()?;
        match self.peek() {
            Some(b'{') => {
                self.bump();
                let children = self.parse_children(b'}')?;
                Ok(LayoutNode::Split {
                    w,
                    h,
                    x,
                    y,
                    dir: SplitDir::LeftRight,
                    children,
                })
            }
            Some(b'[') => {
                self.bump();
                let children = self.parse_children(b']')?;
                Ok(LayoutNode::Split {
                    w,
                    h,
                    x,
                    y,
                    dir: SplitDir::TopBottom,
                    children,
                })
            }
            Some(b',') => {
                self.bump();
                let pane_id = self.parse_num::<u32>()?;
                Ok(LayoutNode::Pane {
                    w,
                    h,
                    x,
                    y,
                    pane_id,
                })
            }
            other => Err(Error::Parse(format!(
                "layout: expected pane or split, got {other:?}"
            ))),
        }
    }

    fn parse_children(&mut self, close: u8) -> Result<Vec<LayoutNode>> {
        let mut children = Vec::new();
        loop {
            children.push(self.parse_node()?);
            match self.peek() {
                Some(b) if b == close => {
                    self.bump();
                    return Ok(children);
                }
                Some(b',') => {
                    self.bump();
                }
                other => {
                    return Err(Error::Parse(format!(
                        "layout: expected comma or closer, got {other:?}"
                    )));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_pane() {
        let n = parse_window_layout("b260,80x24,0,0,3").unwrap();
        assert_eq!(
            n,
            LayoutNode::Pane {
                w: 80,
                h: 24,
                x: 0,
                y: 0,
                pane_id: 3
            }
        );
    }

    #[test]
    fn side_by_side() {
        let n = parse_window_layout("020a,80x24,0,0{40x24,0,0,1,39x24,41,0,2}").unwrap();
        match n {
            LayoutNode::Split {
                dir: SplitDir::LeftRight,
                children,
                w,
                h,
                ..
            } => {
                assert_eq!((w, h), (80, 24));
                assert_eq!(children.len(), 2);
                assert_eq!(
                    children[0],
                    LayoutNode::Pane {
                        w: 40,
                        h: 24,
                        x: 0,
                        y: 0,
                        pane_id: 1
                    }
                );
                assert_eq!(
                    children[1],
                    LayoutNode::Pane {
                        w: 39,
                        h: 24,
                        x: 41,
                        y: 0,
                        pane_id: 2
                    }
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn stacked() {
        let n = parse_window_layout("abcd,80x24,0,0[80x12,0,0,0,80x11,0,13,1]").unwrap();
        match n {
            LayoutNode::Split {
                dir: SplitDir::TopBottom,
                children,
                ..
            } => {
                assert_eq!(children.len(), 2);
                assert_eq!(
                    children[0],
                    LayoutNode::Pane {
                        w: 80,
                        h: 12,
                        x: 0,
                        y: 0,
                        pane_id: 0
                    }
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn nested() {
        let n =
            parse_window_layout("ffff,80x24,0,0{40x24,0,0[40x12,0,0,0,40x11,0,13,1],39x24,41,0,2}")
                .unwrap();
        match n {
            LayoutNode::Split {
                dir: SplitDir::LeftRight,
                children,
                ..
            } => {
                assert_eq!(children.len(), 2);
                match &children[0] {
                    LayoutNode::Split {
                        dir: SplitDir::TopBottom,
                        children: inner,
                        ..
                    } => {
                        assert_eq!(inner.len(), 2);
                        assert!(matches!(inner[0], LayoutNode::Pane { pane_id: 0, .. }));
                        assert!(matches!(inner[1], LayoutNode::Pane { pane_id: 1, .. }));
                    }
                    other => panic!("{other:?}"),
                }
                assert!(matches!(children[1], LayoutNode::Pane { pane_id: 2, .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn v2_single_pane_uses_capital_i_pane_id() {
        let n = parse_window_layout(
            r#"{"V":2,"L":{"t":"p","w":144,"h":53,"x":0,"y":0,"a":true,"i":0,"I":"%7"}}"#,
        )
        .unwrap();
        assert_eq!(
            n,
            LayoutNode::Pane {
                w: 144,
                h: 53,
                x: 0,
                y: 0,
                pane_id: 7,
            }
        );
    }

    #[test]
    fn v2_side_by_side_and_stacked_splits() {
        let v1 =
            parse_window_layout("ffff,80x24,0,0{40x24,0,0[40x12,0,0,0,40x11,0,13,1],39x24,41,0,2}")
                .unwrap();
        let v2 = parse_window_layout(
            r#"{"V":2,"L":{"t":"h","w":80,"h":24,"x":0,"y":0,"c":[{"t":"v","w":40,"h":24,"x":0,"y":0,"c":[{"t":"p","w":40,"h":12,"x":0,"y":0,"a":true,"i":0,"I":"%0"},{"t":"p","w":40,"h":11,"x":0,"y":13,"i":1,"I":"%1"}]},{"t":"p","w":39,"h":24,"x":41,"y":0,"i":2,"I":"%2"}]}}"#,
        )
        .unwrap();
        assert_eq!(v2, v1);
    }

    #[test]
    fn v2_floating_pane_is_ignored_when_tiled_pane_exists() {
        let n = parse_window_layout(
            r#"{"V":2,"L":{"t":"h","w":80,"h":24,"x":0,"y":0,"c":[{"t":"p","w":80,"h":24,"x":0,"y":0,"a":true,"i":0,"I":"%4"},{"t":"p","w":40,"h":12,"x":10,"y":5,"z":0,"i":1,"I":"%5"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            n,
            LayoutNode::Pane {
                w: 80,
                h: 24,
                x: 0,
                y: 0,
                pane_id: 4,
            }
        );
    }
}
