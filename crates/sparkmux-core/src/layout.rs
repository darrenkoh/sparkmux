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
    let body = s.split_once(',').map(|(_, rest)| rest).unwrap_or(s);
    let mut p = Parser {
        bytes: body.as_bytes(),
        i: 0,
    };
    let node = p.parse_node()?;
    Ok(node)
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

    fn parse_u16(&mut self) -> Result<u16> {
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
        let w = self.parse_u16()?;
        self.eat(b'x')?;
        let h = self.parse_u16()?;
        self.eat(b',')?;
        let x = self.parse_u16()?;
        self.eat(b',')?;
        let y = self.parse_u16()?;
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
                let pane_id = self.parse_u16()? as u32;
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
}
