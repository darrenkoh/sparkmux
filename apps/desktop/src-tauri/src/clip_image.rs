//! Clipboard image paste. A terminal cannot carry pixels, so the image is
//! written as a PNG under the sparkmux cache directory and its path is pasted
//! at the prompt, the same way a dropped file is. Nothing is submitted.

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Refuse anything larger than this many pixels (about 256 MB of RGBA).
const MAX_PIXELS: usize = 64 * 1024 * 1024;
/// Pasted images older than this are removed on the next paste.
const KEEP_FOR: Duration = Duration::from_secs(24 * 60 * 60);

fn paste_dir() -> PathBuf {
    directories::ProjectDirs::from("", "", "sparkmux")
        .map(|dirs| dirs.cache_dir().to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("sparkmux"))
        .join("pasted-images")
}

/// Saves the clipboard image, if there is one, and returns the text to paste:
/// the file's path, shell-quoted when needed, with a trailing space.
pub fn save_clipboard_image() -> Result<Option<String>, String> {
    let image = match arboard::Clipboard::new().and_then(|mut c| c.get_image()) {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };
    let dir = paste_dir();
    let path = write_png(&dir, image.width, image.height, &image.bytes)?;
    prune(&dir, &path);
    Ok(path.to_str().map(|p| format!("{} ", quote_path(p))))
}

fn write_png(dir: &Path, width: usize, height: usize, rgba: &[u8]) -> Result<PathBuf, String> {
    let pixels = width
        .checked_mul(height)
        .filter(|n| *n > 0 && *n <= MAX_PIXELS);
    let Some(pixels) = pixels else {
        return Err("clipboard image is empty or too large".into());
    };
    if rgba.len() != pixels * 4 {
        return Err("clipboard image has an unexpected format".into());
    }
    let (w, h) = (
        u32::try_from(width).map_err(|e| e.to_string())?,
        u32::try_from(height).map_err(|e| e.to_string())?,
    );
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("paste-{millis}-{:08x}.png", rand::random::<u32>()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(|e| e.to_string())?;
    let encode = || -> Result<(), png::EncodingError> {
        let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
        writer.finish()
    };
    if let Err(e) = encode() {
        let _ = fs::remove_file(&path);
        return Err(e.to_string());
    }
    Ok(path)
}

/// Removes old pasted images. Only `paste-*.png` files in our own directory.
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path == keep || !name.starts_with("paste-") || !name.ends_with(".png") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let _ = fs::remove_file(&path);
        }
    }
}

fn quote_path(path: &str) -> String {
    let plain = path.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '/' | '.' | '_' | '-' | '+' | ',' | ':' | '@' | '%')
    });
    if plain {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sparkmux-clip-{tag}-{:08x}", rand::random::<u32>()))
    }

    #[test]
    fn writes_a_decodable_png() {
        let dir = temp_dir("png");
        let rgba = [255u8, 0, 0, 255, 0, 255, 0, 255];
        let path = write_png(&dir, 2, 1, &rgba).unwrap();
        let decoder = png::Decoder::new(std::io::BufReader::new(fs::File::open(&path).unwrap()));
        let reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (2, 1));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_bad_dimensions() {
        let dir = temp_dir("bad");
        assert!(write_png(&dir, 0, 4, &[]).is_err());
        assert!(write_png(&dir, 2, 2, &[0; 4]).is_err());
        assert!(write_png(&dir, usize::MAX, 2, &[0; 4]).is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn prune_keeps_fresh_and_foreign_files() {
        let dir = temp_dir("prune");
        let keep = write_png(&dir, 1, 1, &[0; 4]).unwrap();
        let other = write_png(&dir, 1, 1, &[0; 4]).unwrap();
        let foreign = dir.join("notes.txt");
        fs::write(&foreign, "x").unwrap();
        prune(&dir, &keep);
        assert!(keep.exists() && other.exists() && foreign.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote_path("/tmp/a-b_1.png"), "/tmp/a-b_1.png");
        assert_eq!(quote_path("/tmp/my pics/a.png"), "'/tmp/my pics/a.png'");
        assert_eq!(quote_path("/tmp/it's.png"), "'/tmp/it'\\''s.png'");
    }
}
