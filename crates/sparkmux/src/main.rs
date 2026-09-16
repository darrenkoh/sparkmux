mod action;
mod app;
mod config;
mod event;
mod ui;

use std::io::{self, stdout, Stdout};
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use color_eyre::eyre::{self, WrapErr};
use crossterm::cursor::{Hide, Show};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::prelude::{CrosstermBackend, Terminal};
use sparkmux_core::{is_inside_tmux, TmuxClient};
use tracing_subscriber::EnvFilter;

use crate::app::{App, ExitAction};
use crate::config::Config;

#[derive(Debug, Parser)]
#[command(
    name = "sparkmux",
    version,
    about = "A fast Ratatui dashboard for a live tmux server"
)]
pub(crate) struct Cli {
    /// Path to the tmux binary
    #[arg(long, env = "SPARKMUX_TMUX")]
    pub(crate) tmux_bin: Option<PathBuf>,

    /// tmux socket name (`tmux -L`)
    #[arg(short = 'L', long)]
    pub(crate) socket_name: Option<String>,

    /// tmux socket path (`tmux -S`)
    #[arg(short = 'S', long)]
    pub(crate) socket_path: Option<PathBuf>,

    /// Config file path
    #[arg(long)]
    pub(crate) config: Option<PathBuf>,

    /// Verbose logging
    #[arg(short, long)]
    pub(crate) verbose: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Print the current tmux snapshot as JSON
    Dump,
    /// Print sparkmux and detected tmux versions
    Version,
}

#[tokio::main]
async fn main() -> eyre::Result<ExitCode> {
    color_eyre::install()?;
    install_panic_hook();

    let cli = Cli::parse();
    let is_tui = cli.command.is_none();
    init_tracing(cli.verbose, is_tui);
    let (cfg, config_warning) = config::load(&cli);
    if let Some(ref msg) = config_warning {
        eprintln!("warning: {msg}");
    }

    match cli.command {
        Some(Commands::Dump) => {
            let client = make_client(&cfg)?;
            let snap = client.snapshot().wrap_err("failed to list tmux tree")?;
            println!("{}", serde_json::to_string_pretty(&snap)?);
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Version) => Ok(cmd_version(&cfg)),
        None => {
            run_tui(cfg, config_warning).await?;
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn make_client(cfg: &Config) -> sparkmux_core::Result<TmuxClient> {
    TmuxClient::new(
        cfg.tmux_bin.clone(),
        cfg.socket_name.clone(),
        cfg.socket_path.clone(),
    )
}

fn cmd_version(cfg: &Config) -> ExitCode {
    println!("sparkmux {}", env!("CARGO_PKG_VERSION"));
    match make_client(cfg) {
        Ok(client) => match client.version() {
            Ok(v) => {
                println!(
                    "{} ({}.{}) at {}",
                    v.raw,
                    v.major,
                    v.minor,
                    client.bin.display()
                );
                if !v.is_supported() {
                    eprintln!("error: tmux {}.{} is older than 3.2", v.major, v.minor);
                    ExitCode::from(2)
                } else {
                    ExitCode::SUCCESS
                }
            }
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::from(1)
            }
        },
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

async fn run_tui(cfg: Config, config_warning: Option<String>) -> eyre::Result<()> {
    let inside = is_inside_tmux();
    let mut read_only = false;
    let mut version_banner = None;
    let mut server_error = None;
    let client = match make_client(&cfg) {
        Ok(c) => {
            match c.version() {
                Ok(v) if !v.is_supported() => {
                    read_only = true;
                    version_banner = Some(format!("tmux {}.{} < 3.2: read-only", v.major, v.minor));
                }
                Err(e) => server_error = Some(e.to_string()),
                _ => {}
            }
            Some(c)
        }
        Err(e) => {
            server_error = Some(e.to_string());
            None
        }
    };

    let attach_client = client.clone();
    let exit = {
        let _guard = TuiGuard;
        let mut terminal = setup_terminal()?;
        let app = App::new(
            client,
            cfg,
            inside,
            read_only,
            version_banner,
            server_error,
            config_warning,
        );
        app.run(&mut terminal).await?
    };

    if let ExitAction::Attach(session) = exit {
        let client = attach_client.ok_or_else(|| eyre::eyre!("tmux binary not found"))?;
        exec_attach(&client, &session)?;
    }
    Ok(())
}

fn exec_attach(client: &TmuxClient, session: &str) -> eyre::Result<()> {
    use std::os::unix::process::CommandExt;
    let mut cmd = client.attach_command(session);
    let err = cmd.exec();
    Err(err).wrap_err("failed to exec tmux attach-session")
}

struct TuiGuard;

impl Drop for TuiGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

fn setup_terminal() -> eyre::Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen, Hide)?;
    Ok(Terminal::new(CrosstermBackend::new(out))?)
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let mut out = stdout();
    let _ = execute!(out, LeaveAlternateScreen, Show);
}

fn install_panic_hook() {
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        original(info);
    }));
}

fn init_tracing(verbose: bool, for_tui: bool) {
    let level = if verbose { "debug" } else { "warn" };
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    let want_file =
        std::env::var("SPARKMUX_LOG").ok().as_deref() == Some("1") || (for_tui && verbose);

    if want_file {
        if let Some(dirs) = config::project_dirs() {
            let dir = dirs.cache_dir();
            let _ = std::fs::create_dir_all(dir);
            let path = dir.join("sparkmux.log");
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                tracing_subscriber::fmt()
                    .with_env_filter(filter)
                    .with_ansi(false)
                    .with_writer(std::sync::Mutex::new(file))
                    .init();
                return;
            }
        }
    }

    if for_tui {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(io::sink)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(io::stderr)
            .init();
    }
}
