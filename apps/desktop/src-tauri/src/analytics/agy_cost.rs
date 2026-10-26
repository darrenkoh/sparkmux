//! Antigravity session dollars live on the conversation protobuf, not in
//! `transcript.jsonl`. `CortexStepMetadata.model_cost` is fixed32 field 10
//! (`GetModelCost`). The status line's `cost.total_usd` is the sum of those
//! step costs, including subagent conversations, and already contains
//! `subagent_usd`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

static COPY_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) enum CostRead {
    /// The database was locked or unreadable. Try again on the next tick.
    Unreadable,
    /// Steps are present and none recorded `model_cost`. That is not $0.
    NoModelCost,
    /// At least one step recorded a cost. The total is the status-line dollar.
    Total(f64),
}

pub(crate) struct ConversationPaths {
    pub db: PathBuf,
    pub summaries: PathBuf,
    pub id: String,
}

/// `brain/<id>/.system_generated/logs/transcript.jsonl` → that conversation's db.
pub(crate) fn conversation_paths(transcript: &Path) -> Option<ConversationPaths> {
    let id_dir = transcript.parent()?.parent()?.parent()?;
    let brain = id_dir.parent()?;
    if brain.file_name()? != "brain" {
        return None;
    }
    let id = id_dir.file_name()?.to_str()?;
    if !safe_id(id) {
        return None;
    }
    let root = brain.parent()?;
    Some(ConversationPaths {
        db: root.join("conversations").join(format!("{id}.db")),
        summaries: root.join("conversation_summaries.db"),
        id: id.to_string(),
    })
}

/// Sum of child conversation revisions. `None` means the summaries db could
/// not be read. A missing summaries file is `Some(0)`.
pub(crate) fn child_mtime_stamp(paths: &ConversationPaths) -> Option<u64> {
    if !paths.summaries.is_file() {
        return Some(0);
    }
    let ids = child_ids(&paths.summaries, &paths.id)?;
    let mut stamp = 0u64;
    for id in ids {
        let Some(db) = child_db(paths, &id) else {
            continue;
        };
        stamp = stamp.wrapping_add(file_revision(&db));
    }
    Some(stamp)
}

/// Db mtime mixed with the `-wal` mtime. A WAL append often leaves the db
/// mtime unchanged, and that append is where a new `model_cost` lands.
pub(crate) fn file_revision(path: &Path) -> u64 {
    let db = mtime_ms(path);
    if db == 0 {
        return 0;
    }
    let wal = mtime_ms(&sidecar(path, "-wal"));
    db.wrapping_mul(0x9E37_79B9) ^ wal.wrapping_mul(0x85EB_CA6B).wrapping_add(1)
}

pub(crate) fn read_model_cost_total(paths: &ConversationPaths) -> CostRead {
    let mut saw = false;
    let mut total = 0.0f64;
    if sum_file(&paths.db, &mut saw, &mut total).is_err() {
        return CostRead::Unreadable;
    }
    if paths.summaries.is_file() {
        let Some(ids) = child_ids(&paths.summaries, &paths.id) else {
            return CostRead::Unreadable;
        };
        for id in ids {
            let Some(db) = child_db(paths, &id) else {
                continue;
            };
            if !db.is_file() {
                continue;
            }
            if sum_file(&db, &mut saw, &mut total).is_err() {
                return CostRead::Unreadable;
            }
        }
    }
    if saw {
        CostRead::Total(total)
    } else {
        CostRead::NoModelCost
    }
}

/// Top-level fixed32 field 10. Nested floats are not this field.
pub(crate) fn step_model_cost(metadata: &[u8]) -> Option<f32> {
    let mut i = 0;
    let mut found = None;
    while i < metadata.len() {
        let (key, next) = read_varint(metadata, i)?;
        let field = key >> 3;
        let wire = key & 7;
        if field == 0 {
            return found;
        }
        i = next;
        match wire {
            0 => {
                let (_, next) = read_varint(metadata, i)?;
                i = next;
            }
            1 => {
                if i + 8 > metadata.len() {
                    return found;
                }
                i += 8;
            }
            5 => {
                if i + 4 > metadata.len() {
                    return found;
                }
                if field == 10 {
                    let bytes: [u8; 4] = metadata[i..i + 4].try_into().ok()?;
                    let cost = f32::from_le_bytes(bytes);
                    if cost.is_finite() {
                        found = Some(cost);
                    }
                }
                i += 4;
            }
            2 => {
                let (len, next) = read_varint(metadata, i)?;
                let len = usize::try_from(len).ok()?;
                if next.checked_add(len)? > metadata.len() {
                    return found;
                }
                i = next + len;
            }
            _ => return found,
        }
    }
    found
}

fn sum_file(path: &Path, saw: &mut bool, total: &mut f64) -> Result<(), ()> {
    with_ro(path, |conn| {
        let mut stmt = conn
            .prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL")
            .map_err(|_| ())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|_| ())?;
        for row in rows {
            let blob = row.map_err(|_| ())?;
            if let Some(cost) = step_model_cost(&blob) {
                *saw = true;
                *total += f64::from(cost);
            }
        }
        Ok(())
    })
}

fn child_ids(summaries: &Path, parent: &str) -> Option<Vec<String>> {
    with_ro(summaries, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id = ?1",
            )
            .map_err(|_| ())?;
        let rows = stmt
            .query_map([parent], |row| row.get::<_, String>(0))
            .map_err(|_| ())?;
        let mut ids = Vec::new();
        for row in rows {
            let id = row.map_err(|_| ())?;
            if safe_id(&id) {
                ids.push(id);
            }
        }
        Ok(ids)
    })
    .ok()
}

fn child_db(paths: &ConversationPaths, id: &str) -> Option<PathBuf> {
    if !safe_id(id) || id == paths.id {
        return None;
    }
    Some(paths.db.parent()?.join(format!("{id}.db")))
}

/// Read a CLI database without creating or touching its `-shm` file.
///
/// A direct read-only open of a WAL database writes the shared-memory file
/// next to the CLI's db. An `immutable=1` open does not, but it also cannot
/// see rows that are still only in the `-wal`. When that file is non-empty,
/// copy the db and the wal into a temp directory and open the copy.
fn with_ro<T>(path: &Path, body: impl FnOnce(&Connection) -> Result<T, ()>) -> Result<T, ()> {
    let (conn, scratch) = open_ro(path)?;
    let result = body(&conn);
    drop(conn);
    if let Some(dir) = scratch {
        let _ = std::fs::remove_dir_all(dir);
    }
    result
}

fn open_ro(path: &Path) -> Result<(Connection, Option<PathBuf>), ()> {
    let wal = sidecar(path, "-wal");
    let wal_len = std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0);
    if wal_len == 0 {
        let conn = Connection::open_with_flags(
            file_uri(path),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ())?;
        quiet(&conn)?;
        return Ok((conn, None));
    }
    let dir = std::env::temp_dir().join(format!(
        "sparkmux-agy-ro-{}-{}",
        std::process::id(),
        COPY_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if std::fs::create_dir_all(&dir).is_err() {
        return Err(());
    }
    let dest = dir.join("conv.db");
    if std::fs::copy(path, &dest).is_err() || std::fs::copy(&wal, dir.join("conv.db-wal")).is_err()
    {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(());
    }
    match Connection::open(&dest) {
        Ok(conn) => {
            if quiet(&conn).is_err() {
                drop(conn);
                let _ = std::fs::remove_dir_all(&dir);
                return Err(());
            }
            Ok((conn, Some(dir)))
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(())
        }
    }
}

fn quiet(conn: &Connection) -> Result<(), ()> {
    conn.busy_timeout(Duration::from_millis(80))
        .map_err(|_| ())?;
    conn.execute_batch("PRAGMA query_only = ON")
        .map_err(|_| ())?;
    Ok(())
}

fn file_uri(path: &Path) -> String {
    let mut out = String::from("file:");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out.push_str("?immutable=1");
    out
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

fn read_varint(buf: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut n = 0u64;
    let mut shift = 0;
    while i < buf.len() && shift < 64 {
        let byte = buf[i];
        i += 1;
        n |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some((n, i));
        }
        shift += 7;
    }
    None
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) const CAPTURED_STEP: &[u8] = include_bytes!("testdata/e5b88dc4-step1.metadata.pb");

/// Field 10, wire type 5, the encoding `GetModelCost` unmarshals.
#[cfg(test)]
pub(crate) fn with_model_cost(metadata: &[u8], cost: f32) -> Vec<u8> {
    let mut out = metadata.to_vec();
    out.push((10 << 3) | 5);
    out.extend_from_slice(&cost.to_le_bytes());
    out
}

/// One conversation db, the same `steps.metadata` column the CLI writes.
#[cfg(test)]
pub(crate) fn write_steps(path: &Path, blobs: &[Vec<u8>]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);")
        .unwrap();
    for (i, blob) in blobs.iter().enumerate() {
        conn.execute(
            "INSERT INTO steps (idx, metadata) VALUES (?1, ?2)",
            rusqlite::params![(i + 1) as i64, blob],
        )
        .unwrap();
    }
}

/// `conversation_summaries.parent_conversation_id` is how a subagent db is found.
#[cfg(test)]
pub(crate) fn write_child_link(summaries: &Path, parent: &str, child: &str) {
    if let Some(dir) = summaries.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    let conn = Connection::open(summaries).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_summaries (
            conversation_id TEXT,
            parent_conversation_id TEXT
        );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id) VALUES (?1, ?2)",
        rusqlite::params![child, parent],
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_planner_step_has_no_model_cost() {
        assert!(step_model_cost(CAPTURED_STEP).is_none());
        let usage = model_usage_tokens(CAPTURED_STEP).unwrap();
        assert_eq!(usage, (8093, 247));
        let priced = with_model_cost(CAPTURED_STEP, 0.5);
        let cost = step_model_cost(&priced).unwrap();
        assert!((f64::from(cost) - 0.5).abs() < 1e-6);
    }

    /// The captured step, stored the way the CLI stores it, is not a dollar.
    /// A later `model_cost` on that same blob, plus the linked child db, is
    /// the status-line total. An unlinked db is not added, and a recorded 0
    /// is a stamp rather than "no cost".
    #[test]
    fn captured_db_sums_model_cost_once() {
        let dir = std::env::temp_dir().join(format!(
            "sparkmux-agy-model-cost-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let parent = "e5b88dc4-16a4-4c0b-8011-621243f0f559";
        let child = "c0ffee00-16a4-4c0b-8011-621243f0f559";
        let decoy = "deadbeef-16a4-4c0b-8011-621243f0f559";
        let conv = dir.join("conversations");
        let parent_db = conv.join(format!("{parent}.db"));
        let summaries = dir.join("conversation_summaries.db");
        let paths = ConversationPaths {
            db: parent_db.clone(),
            summaries: summaries.clone(),
            id: parent.to_string(),
        };

        write_steps(&parent_db, &[CAPTURED_STEP.to_vec()]);
        assert!(
            matches!(read_model_cost_total(&paths), CostRead::NoModelCost),
            "the captured planner step has no model_cost"
        );

        std::fs::remove_file(&parent_db).unwrap();
        write_steps(&parent_db, &[with_model_cost(CAPTURED_STEP, 0.0)]);
        match read_model_cost_total(&paths) {
            CostRead::Total(usd) => assert!(usd.abs() < 1e-9, "{usd}"),
            CostRead::NoModelCost => panic!("a recorded 0 must stay 0"),
            CostRead::Unreadable => panic!("zero-cost db was unreadable"),
        }

        std::fs::remove_file(&parent_db).unwrap();
        write_steps(
            &parent_db,
            &[CAPTURED_STEP.to_vec(), with_model_cost(CAPTURED_STEP, 0.25)],
        );
        write_steps(
            &conv.join(format!("{child}.db")),
            &[with_model_cost(CAPTURED_STEP, 0.25)],
        );
        write_steps(
            &conv.join(format!("{decoy}.db")),
            &[with_model_cost(CAPTURED_STEP, 9.0)],
        );
        write_child_link(&summaries, parent, child);
        match read_model_cost_total(&paths) {
            CostRead::Total(usd) => {
                assert!((usd - 0.5).abs() < 1e-6, "parent + child = {usd}, not 9.5");
            }
            CostRead::NoModelCost => panic!("priced steps were ignored"),
            CostRead::Unreadable => panic!("priced db was unreadable"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rows that exist only in the `-wal` are part of the status-line total.
    /// Reading them must not write the source `-shm`.
    #[test]
    fn wal_model_cost_is_read_without_touching_the_source_shm() {
        let dir = std::env::temp_dir().join(format!(
            "sparkmux-agy-wal-{}-{}",
            std::process::id(),
            COPY_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let parent = "e5b88dc4-16a4-4c0b-8011-621243f0f559";
        let db = dir.join(format!("{parent}.db"));
        let writer = Connection::open(&db).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);",
            )
            .unwrap();
        let priced = with_model_cost(CAPTURED_STEP, 0.5);
        writer
            .execute(
                "INSERT INTO steps (idx, metadata) VALUES (1, ?1)",
                rusqlite::params![priced],
            )
            .unwrap();
        let wal = sidecar(&db, "-wal");
        assert!(
            std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0) > 0,
            "the fixture must still be uncheckpointed"
        );
        let shm = sidecar(&db, "-shm");
        let before = std::fs::metadata(&shm).unwrap().modified().unwrap();
        let paths = ConversationPaths {
            db: db.clone(),
            summaries: dir.join("conversation_summaries.db"),
            id: parent.to_string(),
        };
        match read_model_cost_total(&paths) {
            CostRead::Total(usd) => assert!((usd - 0.5).abs() < 1e-6, "{usd}"),
            CostRead::NoModelCost => panic!("wal row was invisible"),
            CostRead::Unreadable => panic!("wal db was unreadable"),
        }
        let after = std::fs::metadata(&shm).unwrap().modified().unwrap();
        assert_eq!(before, after, "reading cost wrote the source -shm");
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Field 9 is `model_usage`. Field 2 is input tokens, field 3 is output.
    fn model_usage_tokens(metadata: &[u8]) -> Option<(u64, u64)> {
        let mut i = 0;
        while i < metadata.len() {
            let (key, next) = read_varint(metadata, i)?;
            let field = key >> 3;
            let wire = key & 7;
            i = next;
            match wire {
                0 => {
                    let (_, next) = read_varint(metadata, i)?;
                    i = next;
                }
                1 => i += 8,
                5 => i += 4,
                2 => {
                    let (len, next) = read_varint(metadata, i)?;
                    let len = usize::try_from(len).ok()?;
                    let end = next + len;
                    if field == 9 {
                        return usage_pair(&metadata[next..end]);
                    }
                    i = end;
                }
                _ => return None,
            }
        }
        None
    }

    fn usage_pair(buf: &[u8]) -> Option<(u64, u64)> {
        let mut i = 0;
        let mut input = None;
        let mut output = None;
        while i < buf.len() {
            let (key, next) = read_varint(buf, i)?;
            let field = key >> 3;
            let wire = key & 7;
            i = next;
            match wire {
                0 => {
                    let (val, next) = read_varint(buf, i)?;
                    if field == 2 {
                        input = Some(val);
                    } else if field == 3 {
                        output = Some(val);
                    }
                    i = next;
                }
                1 => i += 8,
                5 => i += 4,
                2 => {
                    let (len, next) = read_varint(buf, i)?;
                    i = next + usize::try_from(len).ok()?;
                }
                _ => return None,
            }
        }
        Some((input?, output?))
    }
}
