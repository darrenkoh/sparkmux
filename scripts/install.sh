#!/usr/bin/env bash
# Install Sparkmux on Apple Silicon macOS or ARM64 Linux (DGX Spark / Ubuntu).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/darrenkoh/sparkmux/main/scripts/install.sh | bash
#   ./scripts/install.sh              # download a GitHub Release if one exists
#   ./scripts/install.sh --from-source
set -euo pipefail

REPO="${SPARKMUX_REPO:-darrenkoh/sparkmux}"
FROM_SOURCE=0
SKIP_TMUX=0
PREFIX="${SPARKMUX_PREFIX:-$HOME/.local}"

usage() {
  cat <<'EOF'
Install Sparkmux (desktop app that owns tmux -L sparkmux).

Options:
  --from-source   Build with Rust + Node instead of downloading a release
  --skip-tmux     Do not install tmux even if it is missing
  --prefix DIR    Linux user-install prefix (default: ~/.local)
  -h, --help      Show this help

Environment:
  SPARKMUX_REPO    GitHub repo (default: darrenkoh/sparkmux)
  SPARKMUX_PREFIX  Same as --prefix
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-source) FROM_SOURCE=1 ;;
    --skip-tmux) SKIP_TMUX=1 ;;
    --prefix)
      PREFIX="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64 | aarch64) ARCH=aarch64 ;;
  *) die "sparkmux v0 ships for aarch64 only (got $ARCH)" ;;
esac

need_tmux() {
  if have tmux; then
    local raw major minor
    raw="$(tmux -V 2>/dev/null || true)"
    major="$(printf '%s\n' "$raw" | sed -n 's/^tmux \([0-9][0-9]*\).*/\1/p')"
    minor="$(printf '%s\n' "$raw" | sed -n 's/^tmux [0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')"
    if [[ -n "$major" && "$major" -gt 3 ]] || { [[ "$major" == "3" && -n "$minor" && "$minor" -ge 2 ]]; }; then
      log "tmux ok: $raw ($(command -v tmux))"
      return 0
    fi
    log "tmux is too old ($raw); sparkmux needs 3.2+"
  else
    log "tmux not found"
  fi
  return 1
}

install_tmux() {
  if need_tmux; then
    return 0
  fi
  if [[ "$SKIP_TMUX" -eq 1 ]]; then
    log "skipping tmux install; the app will show an in-window hint"
    return 0
  fi
  if [[ "$OS" == "Darwin" ]] && have brew; then
    log "installing tmux with Homebrew"
    brew install tmux
    need_tmux || die "tmux still missing after brew install"
    return 0
  fi
  if have apt-get && can_sudo; then
    log "installing tmux with apt"
    sudo apt-get update -y
    sudo apt-get install -y tmux
    need_tmux || die "tmux still missing after apt install"
    return 0
  fi
  die "install tmux 3.2+ then re-run (macOS: brew install tmux / Ubuntu: sudo apt install tmux)"
}

can_sudo() {
  have sudo || return 1
  if sudo -n true 2>/dev/null; then
    return 0
  fi
  [[ -t 0 ]]
}

repo_root() {
  if [[ -f "${PWD}/apps/desktop/src-tauri/tauri.conf.json" ]]; then
    printf '%s\n' "$PWD"
    return 0
  fi
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "$here/apps/desktop/src-tauri/tauri.conf.json" ]]; then
    printf '%s\n' "$here"
    return 0
  fi
  return 1
}

ensure_build_tools() {
  have git || die "git is required to build from source"
  if ! have rustc || ! have cargo; then
    die "Rust is required to build from source. Install rustup: https://rustup.rs"
  fi
  if ! have node || ! have npm; then
    die "Node.js + npm are required to build from source"
  fi
  if [[ "$OS" == "Linux" ]]; then
    if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
      can_sudo || die "need sudo to install WebKitGTK build deps (libwebkit2gtk-4.1-dev …)"
      log "installing Tauri Linux build dependencies"
      sudo apt-get update -y
      sudo apt-get install -y \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        patchelf \
        libssl-dev \
        build-essential \
        curl \
        wget \
        file \
        libxdo-dev \
        pkg-config
    fi
  fi
}

clone_or_use_repo() {
  local root
  if root="$(repo_root)"; then
    printf '%s\n' "$root"
    return 0
  fi
  local dest="${TMPDIR:-/tmp}/sparkmux-src-$$"
  log "cloning https://github.com/${REPO}.git"
  git clone --depth 1 "https://github.com/${REPO}.git" "$dest"
  printf '%s\n' "$dest"
}

install_macos_app() {
  local app="$1"
  [[ -d "$app" ]] || die "Sparkmux.app not found at $app"
  local dest
  if [[ -w /Applications ]]; then
    dest="/Applications/Sparkmux.app"
  else
    mkdir -p "$HOME/Applications"
    dest="$HOME/Applications/Sparkmux.app"
  fi
  log "installing $dest"
  rm -rf "$dest"
  cp -R "$app" "$dest"
  if have xattr; then
    xattr -cr "$dest" 2>/dev/null || true
  fi
  INSTALLED="$dest"
}

install_linux_deb_or_bin() {
  local deb="$1"
  local bin="${2:-}"
  if [[ -n "$deb" && -f "$deb" ]] && have dpkg && can_sudo; then
    log "installing $(basename "$deb")"
    sudo dpkg -i "$deb" || sudo apt-get install -f -y
    INSTALLED="$(command -v sparkmux-desktop || true)"
    INSTALLED="${INSTALLED:-/usr/bin/sparkmux-desktop}"
    return 0
  fi
  if [[ -n "$deb" && -f "$deb" ]] && have dpkg-deb; then
    local extract
    extract="$(mktemp -d)"
    dpkg-deb -x "$deb" "$extract"
    bin="$(find "$extract" -type f -name sparkmux-desktop | head -n 1)"
    local desktop
    desktop="$(find "$extract" -type f -name '*.desktop' | head -n 1 || true)"
    mkdir -p "$PREFIX/bin" "$PREFIX/share/applications"
    [[ -n "$bin" ]] || die "deb did not contain sparkmux-desktop"
    install -m 755 "$bin" "$PREFIX/bin/sparkmux-desktop"
    if [[ -n "$desktop" ]]; then
      sed "s|^Exec=.*|Exec=$PREFIX/bin/sparkmux-desktop|" "$desktop" \
        >"$PREFIX/share/applications/sparkmux.desktop"
    fi
    rm -rf "$extract"
    INSTALLED="$PREFIX/bin/sparkmux-desktop"
    return 0
  fi
  if [[ -n "$bin" && -f "$bin" ]]; then
    mkdir -p "$PREFIX/bin"
    install -m 755 "$bin" "$PREFIX/bin/sparkmux-desktop"
    INSTALLED="$PREFIX/bin/sparkmux-desktop"
    return 0
  fi
  die "could not install a Linux bundle"
}

download_release() {
  have curl || die "curl is required to download a release"
  local api json tag
  api="https://api.github.com/repos/${REPO}/releases/latest"
  log "checking GitHub Releases for $REPO"
  if ! json="$(curl -fsSL "$api" 2>/dev/null)"; then
    return 1
  fi
  tag="$(printf '%s\n' "$json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ -n "$tag" ]] || return 1
  local url=""
  if [[ "$OS" == "Darwin" ]]; then
    url="$(printf '%s\n' "$json" | sed -n 's/.*"browser_download_url": *"\([^"]*aarch64[^"]*\.dmg\)".*/\1/p' | head -n 1)"
    if [[ -z "$url" ]]; then
      url="$(printf '%s\n' "$json" | sed -n 's/.*"browser_download_url": *"\([^"]*\.dmg\)".*/\1/p' | head -n 1)"
    fi
  else
    url="$(printf '%s\n' "$json" | sed -n 's/.*"browser_download_url": *"\([^"]*arm64[^"]*\.deb\)".*/\1/p' | head -n 1)"
    if [[ -z "$url" ]]; then
      url="$(printf '%s\n' "$json" | sed -n 's/.*"browser_download_url": *"\([^"]*aarch64[^"]*\.deb\)".*/\1/p' | head -n 1)"
    fi
  fi
  [[ -n "$url" ]] || return 1
  local tmp
  tmp="$(mktemp -d)"
  local file="$tmp/$(basename "$url")"
  log "downloading $url"
  curl -fL --progress-bar -o "$file" "$url"
  if [[ "$OS" == "Darwin" ]]; then
    local mount
    mount="$(hdiutil attach -nobrowse -mountrandom /tmp "$file" | awk '/\/Volumes\// {print $3}' | tail -n 1)"
    [[ -n "$mount" ]] || die "failed to mount DMG"
    local app
    app="$(find "$mount" -maxdepth 2 -name 'Sparkmux.app' -type d | head -n 1)" || true
    install_macos_app "$app"
    hdiutil detach "$mount" >/dev/null
  else
    install_linux_deb_or_bin "$file" ""
  fi
  rm -rf "$tmp"
  return 0
}

build_from_source() {
  ensure_build_tools
  local root
  root="$(clone_or_use_repo)"
  log "building desktop app in $root"
  (cd "$root/apps/desktop" && npm ci && npm run tauri build)
  local bundle="$root/target/release/bundle"
  if [[ "$OS" == "Darwin" ]]; then
    local app
    app="$(find "$bundle" "$root/apps/desktop/src-tauri/target/release/bundle" -name 'Sparkmux.app' -type d 2>/dev/null | head -n 1)" || true
    [[ -n "$app" ]] || die "build finished but Sparkmux.app was not found"
    install_macos_app "$app"
  else
    local deb bin
    deb="$(find "$bundle" "$root/apps/desktop/src-tauri/target/release/bundle" -name '*.deb' 2>/dev/null | head -n 1)" || true
    bin="$(find "$root/target/release" "$root/apps/desktop/src-tauri/target/release" -name sparkmux-desktop -type f 2>/dev/null | head -n 1)" || true
    install_linux_deb_or_bin "${deb:-}" "${bin:-}"
  fi
}

print_next() {
  cat <<EOF

Sparkmux is installed${INSTALLED:+ at $INSTALLED}.

Next:
  1. Open the app (macOS: double-click Sparkmux; Linux: sparkmux-desktop).
  2. If macOS blocks it, right-click the app → Open. Builds are unsigned.
  3. Create a session in the sidebar. Sparkmux uses tmux -L sparkmux only —
     your default tmux server is never touched.
  4. Attach from a real terminal anytime:  tmux -L sparkmux attach

Optional: a nerd font such as 0xProto improves glyph rendering in the tiles.
EOF
}

INSTALLED=""
install_tmux
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  build_from_source
elif download_release; then
  :
else
  log "no GitHub Release asset for this platform; building from source"
  build_from_source
fi
print_next
