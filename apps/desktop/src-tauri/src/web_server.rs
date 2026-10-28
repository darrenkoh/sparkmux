//! HTTP and WebSocket server for the Sparkmux iOS web app (`sparkmux serve`).

use std::collections::HashSet;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Query, State as AxumState};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode, Uri};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use rand::RngCore;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::board_api::BoardPane;
use crate::change_graph::SearchFileTarget;
use crate::control;
use crate::state::{next_subscriber_id, AppState, PaneSink};
use crate::web_protocol::{
    collect_pairing_urls, decode_frame, phone_scan_url, request_is_authenticated,
    session_set_cookie, FRAME_WRITE,
};

pub const WEB_SERVE_MENU_ID: &str = "web-serve";
pub const WEB_SERVE_MENU_START: &str = "Start Remote Server";
pub const WEB_SERVE_MENU_STOP: &str = "Stop Remote Server";

// Release builds embed `dist/` at compile time. Debug builds read that
// folder from disk on each request. Cargo does not rebuild this module
// when only the folder contents change.
#[derive(RustEmbed)]
#[folder = "../dist/"]
struct DistAssets;

#[derive(Clone)]
pub struct WebServerContext {
    pub state: Arc<AppState>,
    pub auth_token: Arc<String>,
    pub shutdown: tokio::sync::watch::Receiver<bool>,
}

#[derive(Clone, serde::Serialize)]
pub struct PairingLink {
    pub url: String,
    /// Square module grid, one row per line. `1` is dark. Includes the quiet zone.
    pub modules: String,
}

#[derive(Clone, serde::Serialize)]
pub struct WebServeStatus {
    pub running: bool,
    pub links: Vec<PairingLink>,
    /// Address shown until another row is selected.
    pub selected: String,
}

fn serve_status(running: bool, urls: Vec<String>) -> WebServeStatus {
    let selected = phone_scan_url(&urls).unwrap_or("").to_string();
    let links = urls
        .into_iter()
        .map(|url| {
            let modules = qr_modules(&url).unwrap_or_default();
            PairingLink { url, modules }
        })
        .collect();
    WebServeStatus {
        running,
        links,
        selected,
    }
}

fn qr_modules(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|err| err.to_string())?;
    let quiet = 4usize;
    let width = code.width();
    let size = width + quiet * 2;
    let mut rows = Vec::with_capacity(size);
    for y in 0..size {
        let mut row = String::with_capacity(size);
        for x in 0..size {
            let dark = x >= quiet
                && y >= quiet
                && x < quiet + width
                && y < quiet + width
                && code[(x - quiet, y - quiet)] == qrcode::Color::Dark;
            row.push(if dark { '1' } else { '0' });
        }
        rows.push(row);
    }
    Ok(rows.join("\n"))
}

struct RunningWeb {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), String>>,
    urls: Vec<String>,
    state: AppState,
    is_headless: bool,
}

/// Desktop menu start/stop. Headless `sparkmux serve` does not use this slot.
pub struct WebServeSlot {
    current: tokio::sync::Mutex<Option<RunningWeb>>,
}

impl Default for WebServeSlot {
    fn default() -> Self {
        Self {
            current: tokio::sync::Mutex::new(None),
        }
    }
}

impl WebServeSlot {
    pub async fn start(
        &self,
        state: AppState,
        opts: ServeOptions,
    ) -> Result<WebServeStatus, String> {
        let mut guard = self.current.lock().await;
        if let Some(running) = guard.as_ref() {
            return Ok(serve_status(true, running.urls.clone()));
        }
        let running = open_web(state, opts, false).await?;
        let urls = running.urls.clone();
        *guard = Some(running);
        Ok(serve_status(true, urls))
    }

    pub async fn stop(&self) -> Result<WebServeStatus, String> {
        let running = {
            let mut guard = self.current.lock().await;
            guard.take()
        };
        if let Some(running) = running {
            shutdown_web(running).await;
        }
        Ok(serve_status(false, Vec::new()))
    }

    pub async fn toggle(
        &self,
        state: AppState,
        opts: ServeOptions,
    ) -> Result<WebServeStatus, String> {
        let already = self.current.lock().await.is_some();
        if already {
            self.stop().await
        } else {
            self.start(state, opts).await
        }
    }

    pub async fn status(&self, state: &AppState) -> WebServeStatus {
        let guard = self.current.lock().await;
        if let Some(running) = guard.as_ref() {
            serve_status(true, running.urls.clone())
        } else {
            let urls = state.web_urls.lock().unwrap().clone();
            let running = !urls.is_empty();
            serve_status(running, urls)
        }
    }
}

fn menu_serve_options() -> ServeOptions {
    ServeOptions {
        bind: "0.0.0.0".into(),
        port: 7420,
        token: None,
        token_dir: None,
    }
}

#[tauri::command]
pub async fn web_serve_status(
    state: tauri::State<'_, AppState>,
    slot: tauri::State<'_, WebServeSlot>,
) -> Result<WebServeStatus, String> {
    Ok(slot.status(state.inner()).await)
}

#[tauri::command]
pub async fn web_serve_toggle(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    slot: tauri::State<'_, WebServeSlot>,
) -> Result<WebServeStatus, String> {
    let status = slot
        .toggle(state.inner().clone(), menu_serve_options())
        .await?;
    set_web_menu_label(&app, status.running);
    Ok(status)
}

pub fn set_web_menu_label(app: &tauri::AppHandle, running: bool) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Ok(items) = menu.items() else {
        return;
    };
    let label = if running {
        WEB_SERVE_MENU_STOP
    } else {
        WEB_SERVE_MENU_START
    };
    apply_web_menu_label(&items, label);
}

fn apply_web_menu_label<R: tauri::Runtime>(items: &[tauri::menu::MenuItemKind<R>], label: &str) {
    for item in items {
        if item.id().as_ref() == WEB_SERVE_MENU_ID {
            if let Some(menu_item) = item.as_menuitem() {
                let _ = menu_item.set_text(label);
            }
        }
        if let Some(submenu) = item.as_submenu() {
            if let Ok(children) = submenu.items() {
                apply_web_menu_label(&children, label);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub bind: String,
    pub port: u16,
    pub token: Option<String>,
    /// Isolated store for tests. Production passes `None` and uses the Sparkmux config directory.
    pub token_dir: Option<PathBuf>,
}

#[derive(Deserialize, Default)]
pub struct AuthQuery {
    pub token: Option<String>,
}

#[derive(Deserialize)]
struct RpcRequest {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct RpcResponse {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const LOGIN_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>__WINDOW_TITLE__</title>
  <style>
    body {
      margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0f12; color: #e6e8ee; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    form {
      background: #12151b; border: 1px solid #2a2f3a; border-radius: 10px;
      padding: 24px; width: min(360px, 90vw); display: flex; flex-direction: column; gap: 12px;
    }
    h1 { margin: 0; font-size: 16px; letter-spacing: 0.04em; }
    p { margin: 0; font-size: 13px; color: #8b93a1; line-height: 1.4; }
    input {
      background: #0d0f12; border: 1px solid #2a2f3a; border-radius: 6px;
      padding: 10px 12px; color: #e6e8ee; font-family: ui-monospace, monospace; font-size: 14px;
    }
    button {
      background: #5b8def; color: #fff; border: 0; border-radius: 6px;
      padding: 10px 14px; font-weight: 600; font-size: 14px; cursor: pointer;
    }
  </style>
</head>
<body>
  <form method="GET" action="/">
    <h1>SPARKMUX iOS PAIRING</h1>
    <p>Enter the pairing token printed by <code>sparkmux serve</code> or scan the terminal QR code.</p>
    <input type="password" name="token" placeholder="Pairing token" required autofocus />
    <button type="submit">Connect to -L sparkmux</button>
  </form>
</body>
</html>"#;

fn login_html() -> String {
    LOGIN_HTML.replace("__WINDOW_TITLE__", &crate::app_window_title())
}

/// Name of the persisted pairing secret inside the Sparkmux config directory.
pub const WEB_TOKEN_FILE: &str = "web_token";

/// Pairing secret for this server process.
///
/// An explicit token or `SPARKMUX_WEB_TOKEN` wins. Otherwise the 32-byte secret
/// in the config directory `web_token` file is reused, and created (mode `0600`
/// on Unix) when that file is missing.
pub fn resolve_token(explicit: Option<String>) -> String {
    resolve_stored_token(
        explicit,
        std::env::var("SPARKMUX_WEB_TOKEN").ok(),
        sparkmux_config_dir(),
    )
}

/// Same order as [`resolve_token`], with the env value and directory passed in
/// so tests can use an isolated folder and a cleared env token.
pub fn resolve_stored_token(
    explicit: Option<String>,
    env_token: Option<String>,
    config_dir: Option<PathBuf>,
) -> String {
    if let Some(token) = trimmed_token(explicit) {
        return token;
    }
    if let Some(token) = trimmed_token(env_token) {
        return token;
    }
    let Some(dir) = config_dir else {
        return generate_token();
    };
    if let Some(token) = read_token_file(&dir) {
        return token;
    }
    let token = generate_token();
    let _ = write_token_file(&dir, &token);
    token
}

fn sparkmux_config_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "sparkmux").map(|dirs| dirs.config_dir().to_path_buf())
}

fn token_path(dir: &Path) -> PathBuf {
    dir.join(WEB_TOKEN_FILE)
}

fn read_token_file(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(token_path(dir)).ok()?;
    trimmed_token(Some(raw))
}

fn write_token_file(dir: &Path, token: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let path = token_path(dir);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|err| err.to_string())?;
    file.write_all(token.as_bytes())
        .map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Resize when the process is headless or the client sets `force`.
pub fn should_apply_window_resize(is_headless: bool, force: bool) -> bool {
    is_headless || force
}

/// Inject the pairing token into an authenticated manifest. An absent token
/// leaves the file bytes unchanged, so the secret is not added.
pub fn manifest_with_token(raw: &str, token: Option<&str>) -> String {
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return raw.to_string();
    };
    let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
    let replacement = format!("\"start_url\": \"/?token={escaped}\"");
    for needle in ["\"start_url\": \"/\"", "\"start_url\":\"/\""] {
        if raw.contains(needle) {
            return raw.replacen(needle, &replacement, 1);
        }
    }
    raw.to_string()
}

fn trimmed_token(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn write_pairing_banner(urls: &[String]) {
    for url in urls {
        println!("{url}");
    }
    if let Some(scan) = phone_scan_url(urls) {
        println!("scan: {scan}");
        print_qr(scan);
    }
    println!(
        "bind default is 0.0.0.0 so a LAN or Tailscale address can open the page; pass --bind 127.0.0.1 for loopback only"
    );
    let _ = io::stdout().flush();
}

pub async fn serve(opts: ServeOptions) -> Result<(), String> {
    let state = AppState::new_headless();
    let running = open_web(state, opts, true).await?;
    write_pairing_banner(&running.urls);
    match running.task.await {
        Ok(result) => result,
        Err(err) => Err(format!("web server task ended: {err}")),
    }
}

async fn open_web(
    state: AppState,
    opts: ServeOptions,
    is_headless: bool,
) -> Result<RunningWeb, String> {
    let token = if let Some(dir) = opts.token_dir.clone() {
        resolve_stored_token(opts.token.clone(), None, Some(dir))
    } else {
        resolve_token(opts.token.clone())
    };
    let addr: SocketAddr = format!("{}:{}", opts.bind, opts.port)
        .parse()
        .map_err(|err| format!("invalid bind address: {err}"))?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|err| format!("failed to bind {addr}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("failed to read bind address: {err}"))?;
    let extras = if opts.bind == "0.0.0.0" || opts.bind == "::" {
        host_ipv4()
    } else {
        Vec::new()
    };
    let urls = collect_pairing_urls(&opts.bind, bound.port(), &token, &extras);
    *state.web_urls.lock().unwrap() = urls.clone();
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let task_state = Arc::new(state.clone());
    let task = tokio::spawn(async move {
        let result = run_web_server(task_state, listener, token, shutdown_rx).await;
        if let Err(err) = &result {
            tracing::error!(%err, "web server stopped");
        }
        result
    });
    Ok(RunningWeb {
        shutdown: shutdown_tx,
        task,
        urls,
        state,
        is_headless,
    })
}

async fn shutdown_web(running: RunningWeb) {
    running.state.web_urls.lock().unwrap().clear();
    let _ = running.shutdown.send(true);
    let RunningWeb {
        mut task,
        state,
        is_headless,
        ..
    } = running;
    tokio::select! {
        _ = &mut task => {}
        _ = tokio::time::sleep(Duration::from_secs(3)) => {
            task.abort();
            let _ = task.await;
        }
    }
    if is_headless {
        let _ = control::disconnect_core(&state).await;
    }
}

fn print_qr(url: &str) {
    match qrcode::QrCode::new(url.as_bytes()) {
        Ok(code) => {
            let image = code
                .render::<qrcode::render::unicode::Dense1x2>()
                .quiet_zone(true)
                .build();
            println!("{image}");
        }
        Err(err) => eprintln!("qr: {err}"),
    }
}

/// Frees a `getifaddrs` list, including a null list.
struct IfaddrsList(*mut libc::ifaddrs);

impl Drop for IfaddrsList {
    fn drop(&mut self) {
        unsafe { libc::freeifaddrs(self.0) };
    }
}

fn host_ipv4() -> Vec<String> {
    let mut found = Vec::new();
    // `getifaddrs` writes the list pointer. Seeding it with `null_mut` leaves
    // an invalid pointer in scope until that write, which is what the walk
    // used to dereference.
    let mut raw = std::mem::MaybeUninit::<*mut libc::ifaddrs>::uninit();
    if unsafe { libc::getifaddrs(raw.as_mut_ptr()) } != 0 {
        return found;
    }
    // SAFETY: `getifaddrs` returned 0, so `raw` is initialized. A null list
    // means the host has no interfaces; `freeifaddrs(null)` is defined.
    let head = unsafe { raw.assume_init() };
    let _list = IfaddrsList(head);
    let mut cursor = head;
    loop {
        if cursor.is_null() {
            break;
        }
        // SAFETY: `cursor` was just checked non-null and still points into
        // the list owned by `_list`.
        let ifa = unsafe { &*cursor };
        let next = ifa.ifa_next;
        let addr = ifa.ifa_addr;
        if !addr.is_null() {
            // SAFETY: `addr` was just checked non-null. Only AF_INET entries
            // are read as `sockaddr_in`, which is how `getifaddrs` stores them.
            let family = unsafe { (*addr).sa_family } as i32;
            if family == libc::AF_INET {
                let sa = unsafe { &*addr.cast::<libc::sockaddr_in>() };
                let ip = std::net::Ipv4Addr::from(u32::from_be(sa.sin_addr.s_addr));
                if !ip.is_loopback() && !ip.is_unspecified() {
                    found.push(ip.to_string());
                }
            }
        }
        cursor = next;
    }
    found.sort();
    found.dedup();
    found
}

pub async fn run_web_server(
    state: Arc<AppState>,
    listener: tokio::net::TcpListener,
    auth_token: String,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let mut shutdown_watch = shutdown.clone();
    let ctx = WebServerContext {
        state,
        auth_token: Arc::new(auth_token),
        shutdown,
    };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(health_handler))
        .fallback(static_handler)
        .layer(from_fn_with_state(ctx.clone(), reject_anonymous_ws))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .with_state(ctx);
    if let Ok(addr) = listener.local_addr() {
        tracing::info!("sparkmux web listening on http://{addr}");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            loop {
                if *shutdown_watch.borrow() {
                    break;
                }
                if shutdown_watch.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|err| format!("web server error: {err}"))
}

async fn reject_anonymous_ws(
    AxumState(ctx): AxumState<WebServerContext>,
    req: Request<Body>,
    next: Next,
) -> Response {
    if req.uri().path() == "/ws" {
        let query_token = query_token(req.uri());
        let cookie = req
            .headers()
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok());
        if !request_is_authenticated(cookie, query_token.as_deref(), &ctx.auth_token) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }
    next.run(req).await
}

fn query_token(uri: &Uri) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "token" {
            return Some(urlencoding_decode(value).unwrap_or_else(|_| value.to_string()));
        }
    }
    None
}

fn urlencoding_decode(raw: &str) -> Result<String, String> {
    let mut out = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex =
                    std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|err| err.to_string())?;
                let byte = u8::from_str_radix(hex, 16).map_err(|err| err.to_string())?;
                out.push(byte);
                i += 2;
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8(out).map_err(|err| err.to_string())
}

async fn health_handler() -> impl IntoResponse {
    axum::Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

fn is_public_asset(path: &str) -> bool {
    path == "manifest.webmanifest" || path == "apple-touch-icon.png" || path.starts_with("icons/")
}

async fn static_handler(
    AxumState(ctx): AxumState<WebServerContext>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
    uri: Uri,
) -> Response<Body> {
    let path = uri.path().trim_start_matches('/');
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok());
    let authenticated = request_is_authenticated(cookie, query.token.as_deref(), &ctx.auth_token);
    if !is_public_asset(path) && !authenticated {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(login_html()))
            .unwrap_or_else(|_| Response::new(Body::from("unauthorized")));
    }

    let target = if path.is_empty() { "index.html" } else { path };
    let navigation = path.is_empty() || !path.contains('.');
    let asset = DistAssets::get(target).or_else(|| {
        if navigation {
            DistAssets::get("index.html")
        } else {
            None
        }
    });
    let Some(content) = asset else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap_or_else(|_| Response::new(Body::from("not found")));
    };
    let served = if DistAssets::get(target).is_some() {
        target
    } else {
        "index.html"
    };
    let mime = if served.ends_with(".html") {
        "text/html; charset=utf-8".to_string()
    } else if served.ends_with(".webmanifest") {
        "application/manifest+json".to_string()
    } else {
        mime_guess::from_path(served)
            .first_or_octet_stream()
            .to_string()
    };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime);
    if query.token.is_some() {
        builder = builder.header(header::SET_COOKIE, session_set_cookie(&ctx.auth_token));
    }
    let body = if served == "manifest.webmanifest" {
        let text = String::from_utf8_lossy(&content.data);
        let token = if authenticated {
            Some(ctx.auth_token.as_str())
        } else {
            None
        };
        Body::from(manifest_with_token(&text, token))
    } else {
        Body::from(content.data.into_owned())
    };
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Body::from("")))
}

async fn ws_handler(AxumState(ctx): AxumState<WebServerContext>, req: Request<Body>) -> Response {
    let query_token = query_token(req.uri());
    let cookie = req
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok());
    if !request_is_authenticated(cookie, query_token.as_deref(), &ctx.auth_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let (mut parts, body) = req.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &ctx).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    drop(body);
    let state = Arc::clone(&ctx.state);
    let shutdown = ctx.shutdown.clone();
    upgrade
        .on_upgrade(move |socket| handle_ws_client(socket, state, shutdown))
        .into_response()
}

async fn handle_ws_client(
    mut socket: WebSocket,
    state: Arc<AppState>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let (bin_tx, mut bin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mut events_rx = state.events_tx.subscribe();
    let mut client_subs: HashSet<(String, u64)> = HashSet::new();
    let mut ping_interval = tokio::time::interval(Duration::from_secs(20));

    loop {
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            result = shutdown.changed() => {
                if result.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = ping_interval.tick() => {
                if socket.send(Message::Ping(Vec::<u8>::new().into())).await.is_err() {
                    break;
                }
            }
            Some(frame) = bin_rx.recv() => {
                if socket.send(Message::Binary(frame.into())).await.is_err() {
                    break;
                }
            }
            push = events_rx.recv() => {
                match push {
                    Ok(event) => {
                        if let Ok(text) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    Message::Binary(bytes) => {
                        if let Some(frame) = decode_frame(&bytes) {
                            if frame.kind == FRAME_WRITE {
                                let _ = crate::commands::pane_write_core(&state, &frame.pane_id, &frame.payload).await;
                            }
                        }
                    }
                    Message::Text(text) => {
                        let Ok(req) = serde_json::from_str::<RpcRequest>(text.as_str()) else {
                            continue;
                        };
                        let resp = dispatch_rpc(&state, &bin_tx, &mut client_subs, req).await;
                        if let Ok(json_txt) = serde_json::to_string(&resp) {
                            if socket.send(Message::Text(json_txt.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    for (pane_id, sub_id) in client_subs {
        control::unsubscribe_pane_by_id(&state, &pane_id, Some(sub_id)).await;
    }
}

async fn dispatch_rpc(
    state: &Arc<AppState>,
    bin_tx: &mpsc::UnboundedSender<Vec<u8>>,
    client_subs: &mut HashSet<(String, u64)>,
    req: RpcRequest,
) -> RpcResponse {
    let id = req.id;
    match dispatch_rpc_inner(state, bin_tx, client_subs, &req.cmd, req.args).await {
        Ok(data) => RpcResponse {
            id,
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(err) => RpcResponse {
            id,
            ok: false,
            data: None,
            error: Some(err),
        },
    }
}

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

fn u16_arg(args: &Value, key: &str, default: u16) -> u16 {
    args.get(key)
        .and_then(|value| value.as_u64())
        .and_then(|number| u16::try_from(number).ok())
        .unwrap_or(default)
}

fn u32_arg(args: &Value, key: &str) -> u32 {
    args.get(key)
        .and_then(|value| value.as_u64())
        .and_then(|number| u32::try_from(number).ok())
        .unwrap_or(0)
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

async fn dispatch_rpc_inner(
    state: &Arc<AppState>,
    bin_tx: &mpsc::UnboundedSender<Vec<u8>>,
    client_subs: &mut HashSet<(String, u64)>,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    match cmd {
        "tmux_status" => json_ok(crate::commands::tmux_status_core(state).await?),
        "snapshot" => json_ok(crate::commands::snapshot_core(state).await?),
        "ensure_ready" => json_ok(crate::commands::ensure_ready_core(state).await?),
        "new_session" => {
            crate::commands::new_session_core(state, str_arg(&args, "name")).await?;
            Ok(Value::Null)
        }
        "rename_session" => {
            crate::commands::rename_session_core(
                state,
                str_arg(&args, "target"),
                str_arg(&args, "newName"),
            )
            .await?;
            Ok(Value::Null)
        }
        "kill_session" => {
            crate::commands::kill_session_core(state, str_arg(&args, "target")).await?;
            Ok(Value::Null)
        }
        "new_window" => {
            crate::commands::new_window_core(
                state,
                str_arg(&args, "session"),
                str_arg(&args, "name"),
            )
            .await?;
            Ok(Value::Null)
        }
        "select_window" => {
            crate::commands::select_window_core(state, str_arg(&args, "windowId")).await?;
            Ok(Value::Null)
        }
        "move_window" => {
            crate::commands::move_window_core(
                state,
                str_arg(&args, "srcWindowId"),
                str_arg(&args, "dstWindowId"),
                bool_arg(&args, "before"),
            )
            .await?;
            Ok(Value::Null)
        }
        "rename_window" => {
            crate::commands::rename_window_core(
                state,
                str_arg(&args, "windowId"),
                str_arg(&args, "name"),
            )
            .await?;
            Ok(Value::Null)
        }
        "kill_window" => {
            crate::commands::kill_window_core(state, str_arg(&args, "windowId")).await?;
            Ok(Value::Null)
        }
        "kill_pane" => {
            crate::commands::kill_pane_core(state, str_arg(&args, "paneId")).await?;
            Ok(Value::Null)
        }
        "split_pane" => {
            crate::commands::split_pane_core(
                state,
                str_arg(&args, "paneId"),
                bool_arg(&args, "vertical"),
            )
            .await?;
            Ok(Value::Null)
        }
        "control_connect" => {
            control::connect_core(
                None,
                state,
                str_arg(&args, "session"),
                u16_arg(&args, "cols", 80),
                u16_arg(&args, "rows", 24),
            )
            .await?;
            Ok(Value::Null)
        }
        "control_disconnect" => {
            for (pane_id, sub_id) in client_subs.drain() {
                control::unsubscribe_pane_by_id(state, &pane_id, Some(sub_id)).await;
            }
            Ok(Value::Null)
        }
        "pane_subscribe" => {
            let pane_id = str_arg(&args, "paneId");
            let existing: Vec<u64> = client_subs
                .iter()
                .filter(|(pane, _)| pane == &pane_id)
                .map(|(_, id)| *id)
                .collect();
            for old_sub in existing {
                client_subs.remove(&(pane_id.clone(), old_sub));
                control::unsubscribe_pane_by_id(state, &pane_id, Some(old_sub)).await;
            }
            let sub_id = next_subscriber_id();
            client_subs.insert((pane_id.clone(), sub_id));
            control::subscribe_pane_with_sink(
                state,
                pane_id,
                sub_id,
                PaneSink::WebSocket(bin_tx.clone()),
            )
            .await?;
            Ok(Value::Null)
        }
        "pane_unsubscribe" => {
            let pane_id = str_arg(&args, "paneId");
            let matching: Vec<u64> = client_subs
                .iter()
                .filter(|(pane, _)| pane == &pane_id)
                .map(|(_, id)| *id)
                .collect();
            for sub_id in matching {
                client_subs.remove(&(pane_id.clone(), sub_id));
                control::unsubscribe_pane_by_id(state, &pane_id, Some(sub_id)).await;
            }
            Ok(Value::Null)
        }
        "pane_write" => {
            let pane_id = str_arg(&args, "paneId");
            let data: Vec<u8> = serde_json::from_value(
                args.get("data")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(vec![])),
            )
            .map_err(|err| err.to_string())?;
            crate::commands::pane_write_core(state, &pane_id, &data).await?;
            Ok(Value::Null)
        }
        "window_resize" => {
            let force = bool_arg(&args, "force");
            if should_apply_window_resize(state.is_headless, force) {
                crate::commands::window_resize_core(
                    state,
                    u16_arg(&args, "cols", 80),
                    u16_arg(&args, "rows", 24),
                )
                .await?;
            }
            Ok(Value::Null)
        }
        "ping" => Ok(json!({ "pong": true })),
        "pane_cursor" => {
            json_ok(crate::commands::pane_cursor_core(state, str_arg(&args, "paneId")).await?)
        }
        "focus_pane" => {
            crate::commands::focus_pane_core(state, str_arg(&args, "paneId")).await?;
            Ok(Value::Null)
        }
        "stop_server" => {
            crate::commands::stop_server_core(None, state).await?;
            Ok(Value::Null)
        }
        "remember_session" => {
            crate::commands::remember_session_core(state, str_arg(&args, "name")).await?;
            Ok(Value::Null)
        }
        "parse_layout" => json_ok(crate::commands::parse_layout(str_arg(&args, "layout"))?),
        "attach_target_name" => json_ok(crate::commands::attach_target_name_core(state).await?),
        "app_telemetry" => json_ok(crate::telemetry::app_telemetry()),
        "llm_usage" => json_ok(
            crate::llm_usage::llm_usage(
                str_arg(&args, "command"),
                str_arg(&args, "title"),
                str_arg(&args, "cwd"),
                u32_arg(&args, "pid"),
            )
            .await,
        ),
        "pane_artifacts" => json_ok(
            crate::artifacts::pane_artifacts(
                str_arg(&args, "command"),
                str_arg(&args, "cwd"),
                str_arg(&args, "title"),
                u32_arg(&args, "pid"),
            )
            .await?,
        ),
        "change_graph" => json_ok(
            crate::change_graph::change_graph(
                str_arg(&args, "command"),
                str_arg(&args, "cwd"),
                str_arg(&args, "title"),
                u32_arg(&args, "pid"),
            )
            .await?,
        ),
        "file_diff" => json_ok(
            crate::change_graph::file_diff(
                str_arg(&args, "repoId"),
                str_arg(&args, "path"),
                str_arg(&args, "cwd"),
            )
            .await?,
        ),
        "search_changed_files" => {
            let targets: Vec<SearchFileTarget> = serde_json::from_value(
                args.get("targets")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(vec![])),
            )
            .map_err(|err| err.to_string())?;
            json_ok(
                crate::change_graph::search_changed_files(
                    targets,
                    str_arg(&args, "query"),
                    str_arg(&args, "scope"),
                    str_arg(&args, "cwd"),
                )
                .await?,
            )
        }
        "git_history" => {
            let path = args
                .get("path")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let max_count = args
                .get("maxCount")
                .and_then(|value| value.as_u64())
                .and_then(|number| usize::try_from(number).ok());
            json_ok(
                crate::change_graph::git_history(
                    str_arg(&args, "repoId"),
                    str_arg(&args, "cwd"),
                    path,
                    max_count,
                )
                .await?,
            )
        }
        "git_commit_detail" => json_ok(
            crate::change_graph::git_commit_detail(
                str_arg(&args, "repoId"),
                str_arg(&args, "cwd"),
                str_arg(&args, "commitHash"),
            )
            .await?,
        ),
        "git_commit_diff" => json_ok(
            crate::change_graph::git_commit_diff(
                str_arg(&args, "repoId"),
                str_arg(&args, "cwd"),
                str_arg(&args, "commitHash"),
                str_arg(&args, "path"),
            )
            .await?,
        ),
        "chronicle_session" => json_ok(
            crate::chronicle::chronicle_session(
                str_arg(&args, "command"),
                str_arg(&args, "cwd"),
                str_arg(&args, "title"),
                u32_arg(&args, "pid"),
            )
            .await?,
        ),
        "chronicle_hologram" => json_ok(
            crate::chronicle::chronicle_hologram(
                str_arg(&args, "command"),
                str_arg(&args, "cwd"),
                str_arg(&args, "title"),
                u32_arg(&args, "pid"),
                str_arg(&args, "stationId"),
            )
            .await?,
        ),
        "clear_chronicle_cache" => {
            crate::chronicle::clear_chronicle_cache().await?;
            Ok(Value::Null)
        }
        "tab_analytics" => json_ok(
            crate::analytics::tab_analytics(
                str_arg(&args, "sessionName"),
                str_arg(&args, "tabId"),
                str_arg(&args, "command"),
                str_arg(&args, "cwd"),
                str_arg(&args, "title"),
                u32_arg(&args, "pid"),
            )
            .await?,
        ),
        "set_analytics_enabled" => {
            crate::analytics::set_analytics_enabled(bool_arg(&args, "enabled"))?;
            Ok(Value::Null)
        }
        "clear_analytics_data" => {
            crate::analytics::clear_analytics_data()?;
            Ok(Value::Null)
        }
        "analytics_config" => json_ok(crate::analytics::analytics_config()?),
        "agent_board" => {
            let panes: Vec<BoardPane> = serde_json::from_value(
                args.get("panes")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(vec![])),
            )
            .map_err(|err| err.to_string())?;
            json_ok(crate::board_api::agent_board(panes).await?)
        }
        "sync_active_target" => {
            let target = serde_json::from_value(args.get("target").cloned().unwrap_or(Value::Null))
                .map_err(|err| err.to_string())?;
            crate::commands::sync_active_target_core(None, state, target)?;
            Ok(Value::Null)
        }
        "get_active_target" => json_ok(crate::commands::get_active_target_core(state)?),
        "open_editor_path" => {
            crate::open_path::open_editor_path(str_arg(&args, "path"), str_arg(&args, "cwd"))?;
            Ok(Value::Null)
        }
        "web_serve_status" => {
            let urls = state.web_urls.lock().unwrap().clone();
            let running = !urls.is_empty();
            json_ok(serve_status(running, urls))
        }
        other => Err(format!("unsupported RPC command: {other}")),
    }
}

fn json_ok<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn rpc_dispatch_routes_parse_layout_and_telemetry() {
        let state = Arc::new(AppState::new());
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut subs = HashSet::new();
        let layout = dispatch_rpc(
            &state,
            &tx,
            &mut subs,
            RpcRequest {
                id: 7,
                cmd: "parse_layout".into(),
                args: json!({ "layout": "b260,80x24,0,0,3" }),
            },
        )
        .await;
        assert!(layout.ok, "{:?}", layout.error);
        assert_eq!(layout.id, 7);
        let data = layout.data.expect("layout data");
        assert!(data.get("Pane").is_some() || data.get("Split").is_some());

        let telemetry = dispatch_rpc(
            &state,
            &tx,
            &mut subs,
            RpcRequest {
                id: 8,
                cmd: "app_telemetry".into(),
                args: json!({}),
            },
        )
        .await;
        assert!(telemetry.ok, "{:?}", telemetry.error);
        let body = telemetry.data.expect("telemetry");
        assert!(
            body.get("memory_bytes")
                .and_then(|value| value.as_u64())
                .unwrap_or(0)
                > 0
        );

        let unknown = dispatch_rpc(
            &state,
            &tx,
            &mut subs,
            RpcRequest {
                id: 9,
                cmd: "not_a_real_command".into(),
                args: json!({}),
            },
        )
        .await;
        assert!(!unknown.ok);
        assert!(unknown
            .error
            .unwrap_or_default()
            .contains("unsupported RPC command"));

        // A desktop client does not resize unless force is set. The RPC still
        // returns null when no control client is attached, so the gate itself
        // is what decides whether window_resize_core runs.
        assert!(!should_apply_window_resize(false, false));
        assert!(should_apply_window_resize(false, true));
        assert!(should_apply_window_resize(true, false));
        assert!(should_apply_window_resize(true, true));
        let resize_ignored = dispatch_rpc(
            &state,
            &tx,
            &mut subs,
            RpcRequest {
                id: 10,
                cmd: "window_resize".into(),
                args: json!({ "cols": 60, "rows": 30 }),
            },
        )
        .await;
        assert!(resize_ignored.ok);
        assert!(!should_apply_window_resize(state.is_headless, false));
        let resize_forced = dispatch_rpc(
            &state,
            &tx,
            &mut subs,
            RpcRequest {
                id: 11,
                cmd: "window_resize".into(),
                args: json!({ "cols": 54, "rows": 36, "force": true }),
            },
        )
        .await;
        assert!(resize_forced.ok);
        assert!(should_apply_window_resize(state.is_headless, true));
        let headless = Arc::new(AppState::new_headless());
        assert!(should_apply_window_resize(headless.is_headless, false));
        let ping = dispatch_rpc(
            &state,
            &tx,
            &mut subs,
            RpcRequest {
                id: 12,
                cmd: "ping".into(),
                args: json!({ "t": 1 }),
            },
        )
        .await;
        assert!(ping.ok, "{:?}", ping.error);
        assert_eq!(ping.data, Some(json!({ "pong": true })));
        let src = include_str!("web_server.rs");
        let start = src.find("\"window_resize\" =>").expect("resize arm");
        let rest = &src[start..];
        let end = rest.find("\"pane_cursor\"").expect("next arm");
        let arm = &rest[..end];
        assert!(arm.contains("should_apply_window_resize"));
        assert!(arm.contains("bool_arg(&args, \"force\")"));
    }

    #[test]
    fn control_disconnect_does_not_stop_the_tmux_server() {
        let src = include_str!("web_server.rs");
        let start = src
            .find("\"control_disconnect\" =>")
            .expect("disconnect arm");
        let rest = &src[start..];
        let end = rest.find("\"pane_subscribe\"").expect("next arm");
        let arm = &rest[..end];
        assert!(arm.contains("unsubscribe_pane_by_id"));
        assert!(!arm.contains("kill_server"));
        assert!(!arm.contains("stop_server_core"));
        assert!(!arm.contains("disconnect_core"));
    }

    #[test]
    fn stopping_the_web_server_detaches_and_leaves_tmux_up() {
        let src = include_str!("web_server.rs");
        let start = src.find("async fn shutdown_web").expect("shutdown_web");
        let rest = &src[start..];
        let end = rest[1..]
            .find("\nasync fn ")
            .map(|index| index + 1)
            .unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(body.contains("disconnect_core"));
        assert!(!body.contains("kill_server"));
        assert!(!body.contains("stop_server_core"));
        assert!(src.contains("WEB_SERVE_MENU_START"));
        assert!(src.contains("Start Remote Server"));
        assert!(src.contains("Stop Remote Server"));
    }

    #[test]
    fn lan_addresses_skip_loopback_and_unspecified() {
        for ip in host_ipv4() {
            let parsed: std::net::Ipv4Addr = ip.parse().expect("ipv4");
            assert!(!parsed.is_loopback(), "{ip}");
            assert!(!parsed.is_unspecified(), "{ip}");
        }
    }

    #[test]
    fn a_stored_pairing_token_is_reused_and_explicit_values_win() {
        let first = generate_token();
        let second = generate_token();
        assert_ne!(first, second);
        assert!(is_fresh_token(&first), "{first}");
        assert!(is_fresh_token(&second), "{second}");
        assert_eq!(
            resolve_stored_token(Some("  pinned  ".into()), None, None),
            "pinned"
        );

        let dir = isolated_token_dir("resolve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("token dir");
        let env_cleared = None;
        let created = resolve_stored_token(None, env_cleared.clone(), Some(dir.clone()));
        let again = resolve_stored_token(None, env_cleared, Some(dir.clone()));
        assert_eq!(created, again);
        assert!(is_fresh_token(&created), "{created}");
        let path = dir.join(WEB_TOKEN_FILE);
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("web_token")
        );
        let stored = std::fs::read_to_string(&path).expect("web_token");
        assert_eq!(stored.trim(), created);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "mode {mode:o}");
        }
        assert_eq!(
            resolve_stored_token(
                Some("explicit-token".into()),
                Some("env-token".into()),
                Some(dir.clone())
            ),
            "explicit-token"
        );
        assert_eq!(
            resolve_stored_token(None, Some("env-token".into()), Some(dir.clone())),
            "env-token"
        );
        assert_eq!(
            std::fs::read_to_string(&path)
                .expect("file unchanged")
                .trim(),
            created,
            "an override must not replace the saved secret"
        );
        let _ = std::fs::remove_dir_all(&dir);

        let src = include_str!("web_server.rs");
        let start = src
            .find("pub const WEB_TOKEN_FILE")
            .expect("web_token file");
        let rest = &src[start..];
        let end = rest.find("\nfn generate_token").expect("generate_token");
        let body = &rest[..end];
        assert!(body.contains("web_token"));
        assert!(body.contains("pub fn resolve_token"));
        assert!(body.contains("resolve_stored_token"));
        assert!(body.contains("SPARKMUX_WEB_TOKEN"));
        assert!(body.contains("generate_token()"));
        assert!(body.contains("0o600"));
    }

    fn isolated_token_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "sparkmux-web-token-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn is_fresh_token(token: &str) -> bool {
        token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    #[test]
    fn the_pairing_qr_follows_each_address() {
        let urls = vec![
            "http://127.0.0.1:7420/?token=tok".to_string(),
            "http://192.168.1.20:7420/?token=tok".to_string(),
        ];
        let status = serve_status(true, urls);
        assert_eq!(status.selected, "http://192.168.1.20:7420/?token=tok");
        assert_eq!(status.links.len(), 2);
        assert_ne!(status.links[0].modules, status.links[1].modules);
        for link in &status.links {
            let rows: Vec<&str> = link.modules.lines().collect();
            assert!(rows.len() > 20, "{}", link.url);
            assert!(rows.iter().all(|row| row.len() == rows.len()));
            assert!(link.modules.contains('1') && link.modules.contains('0'));
        }
    }

    #[tokio::test]
    async fn the_menu_server_starts_and_stops_without_stopping_tmux() {
        let slot = WebServeSlot::default();
        let state = AppState::new();
        let started = slot
            .start(
                state,
                ServeOptions {
                    bind: "127.0.0.1".into(),
                    port: 0,
                    token: Some("menu-test-token".into()),
                    token_dir: None,
                },
            )
            .await;
        let probe = async {
            let status = started?;
            assert!(status.running);
            let url = status
                .links
                .first()
                .map(|link| link.url.clone())
                .ok_or("missing url")?;
            assert!(url.contains("menu-test-token"));
            let body = tokio::time::timeout(Duration::from_secs(2), http_get(&url))
                .await
                .map_err(|_| "timed out waiting for the page".to_string())??;
            assert!(body.starts_with("HTTP/1.1 "), "{body}");
            assert!(body.contains("sparkmux_session="), "{body}");
            Ok::<String, String>(url)
        };
        let url = probe.await;
        let stopped = slot.stop().await.expect("stop");
        assert!(!stopped.running);
        let url = url.expect("page");
        let again = http_get(&url).await;
        assert!(again.is_err(), "server still accepted {again:?}");
    }

    #[tokio::test]
    async fn restarting_the_remote_server_reuses_the_stored_token() {
        let dir = isolated_token_dir("restart");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("token dir");
        let slot = WebServeSlot::default();
        let state = AppState::new();
        let opts = || ServeOptions {
            bind: "127.0.0.1".into(),
            port: 0,
            token: None,
            token_dir: Some(dir.clone()),
        };
        let first = slot.start(state.clone(), opts()).await.expect("start");
        let first_token = token_from_pairing_url(&first.links[0].url);
        let origin = origin_from_pairing_url(&first.links[0].url);
        let authed = http_get_path(
            &origin,
            &format!("/manifest.webmanifest?token={first_token}"),
        )
        .await
        .expect("authenticated manifest");
        let anon = http_get_path(&origin, "/manifest.webmanifest")
            .await
            .expect("anonymous manifest");
        slot.stop().await.expect("stop");
        let second = slot.start(state, opts()).await.expect("start again");
        let second_token = token_from_pairing_url(&second.links[0].url);
        slot.stop().await.expect("stop");
        assert_eq!(first_token, second_token);
        assert!(is_fresh_token(&first_token), "{first_token}");
        let path = dir.join("web_token");
        assert!(path.is_file(), "web_token missing in {}", dir.display());
        assert_eq!(
            std::fs::read_to_string(&path).expect("read").trim(),
            first_token
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "mode {mode:o}");
        }
        let needle = format!("\"start_url\": \"/?token={first_token}\"");
        assert!(
            authed.contains(&needle),
            "authenticated manifest missing {needle}: {authed}"
        );
        assert!(
            !anon.contains(&first_token),
            "anonymous manifest leaked the token: {anon}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_start_url_keeps_the_token_out_of_anonymous_bytes() {
        let raw = "{\n  \"start_url\": \"/\",\n  \"name\": \"Sparkmux\"\n}\n";
        let token = "abc123token";
        let authed = manifest_with_token(raw, Some(token));
        assert!(authed.contains("\"start_url\": \"/?token=abc123token\""));
        let anon = manifest_with_token(raw, None);
        assert!(!anon.contains(token));
        assert!(anon.contains("\"start_url\": \"/\""));
    }

    fn token_from_pairing_url(url: &str) -> String {
        url.split_once("token=")
            .map(|(_, token)| token.to_string())
            .unwrap_or_default()
    }

    fn origin_from_pairing_url(url: &str) -> String {
        let rest = url.trim_start_matches("http://");
        rest.split('/').next().unwrap_or(rest).to_string()
    }

    async fn http_get_path(origin: &str, path: &str) -> Result<String, String> {
        let mut stream = tokio::net::TcpStream::connect(origin)
            .await
            .map_err(|err| err.to_string())?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: {origin}\r\nConnection: close\r\n\r\n");
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        stream
            .write_all(req.as_bytes())
            .await
            .map_err(|err| err.to_string())?;
        let mut buf = Vec::new();
        stream
            .read_to_end(&mut buf)
            .await
            .map_err(|err| err.to_string())?;
        String::from_utf8(buf).map_err(|err| err.to_string())
    }

    async fn http_get(url: &str) -> Result<String, String> {
        let rest = url.trim_start_matches("http://");
        let (host_port, query) = rest.split_once('/').unwrap_or((rest, ""));
        let path = format!("/{query}");
        let mut stream = tokio::net::TcpStream::connect(host_port)
            .await
            .map_err(|err| err.to_string())?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        stream
            .write_all(req.as_bytes())
            .await
            .map_err(|err| err.to_string())?;
        let mut buf = Vec::new();
        stream
            .read_to_end(&mut buf)
            .await
            .map_err(|err| err.to_string())?;
        String::from_utf8(buf).map_err(|err| err.to_string())
    }
}
