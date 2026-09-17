use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use color_eyre::eyre::{self, WrapErr};
use sparkmux_core::{
    gui_spawn_env, load_config, Config, ConfigOverrides, TmuxClient, DEFAULT_SESSION,
};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "sparkmux",
    version,
    about = "CLI for a sparkmux-owned tmux server (desktop app is the product UI)"
)]
struct Cli {
    /// Path to the tmux binary
    #[arg(long, env = "SPARKMUX_TMUX")]
    tmux_bin: Option<PathBuf>,

    /// tmux socket name (`tmux -L`). Default: sparkmux
    #[arg(short = 'L', long)]
    socket_name: Option<String>,

    /// tmux socket path (`tmux -S`)
    #[arg(short = 'S', long)]
    socket_path: Option<PathBuf>,

    /// Talk to the user's default tmux server (`-L default`)
    #[arg(long)]
    system: bool,

    /// Config file path
    #[arg(long)]
    config: Option<PathBuf>,

    /// Verbose logging
    #[arg(short, long)]
    verbose: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Print the current tmux snapshot as JSON
    Dump,
    /// Print sparkmux and detected tmux versions
    Version,
    /// Print binary, socket, and session status
    Doctor,
}

fn main() -> eyre::Result<ExitCode> {
    color_eyre::install()?;
    let cli = Cli::parse();
    init_tracing(cli.verbose);
    let (cfg, warning) = load_config(ConfigOverrides {
        tmux_bin: cli.tmux_bin.clone(),
        socket_name: cli.socket_name.clone(),
        socket_path: cli.socket_path.clone(),
        config_path: cli.config.clone(),
        system: cli.system,
    });
    if let Some(msg) = warning {
        eprintln!("warning: {msg}");
    }

    match cli.command {
        Some(Commands::Dump) => cmd_dump(&cfg),
        Some(Commands::Version) => Ok(cmd_version(&cfg)),
        Some(Commands::Doctor) => cmd_doctor(&cfg),
        None => {
            eprintln!(
                "sparkmux {} — desktop app is the UI.\n\nUsage: sparkmux <COMMAND>\n\nCommands:\n  dump      Print the session tree as JSON\n  version   sparkmux + tmux version\n  doctor    Socket and session status\n\nOptions:\n  -L, --socket-name <NAME>  tmux -L (default: sparkmux)\n      --system              Use the default tmux server\n",
                env!("CARGO_PKG_VERSION")
            );
            Ok(ExitCode::from(2))
        }
    }
}

fn make_client(cfg: &Config) -> sparkmux_core::Result<TmuxClient> {
    if cfg.socket_path.is_none() && cfg.socket_name.as_deref().is_some_and(|n| n == "default") {
        TmuxClient::new(cfg.tmux_bin.clone(), Some("default".into()), None)
    } else {
        TmuxClient::new_owned(
            cfg.tmux_bin.clone(),
            cfg.socket_name.clone(),
            cfg.socket_path.clone(),
        )
    }
}

fn cmd_dump(cfg: &Config) -> eyre::Result<ExitCode> {
    let client = make_client(cfg).wrap_err("failed to find tmux")?;
    let snap = match client.snapshot() {
        Ok(s) if s.sessions.is_empty() => {
            client.ensure_ready(&gui_spawn_env(), &cfg.default_session)?;
            client.snapshot().wrap_err("failed to list tmux tree")?
        }
        Ok(s) => s,
        Err(sparkmux_core::Error::ServerDown(_)) => {
            client.ensure_ready(&gui_spawn_env(), &cfg.default_session)?;
            client.snapshot().wrap_err("failed to list tmux tree")?
        }
        Err(e) => return Err(e).wrap_err("failed to list tmux tree"),
    };
    println!("{}", serde_json::to_string_pretty(&snap)?);
    Ok(ExitCode::SUCCESS)
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

fn cmd_doctor(cfg: &Config) -> eyre::Result<ExitCode> {
    let client = match make_client(cfg) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("tmux: {e}");
            return Ok(ExitCode::from(1));
        }
    };
    println!("tmux binary: {}", client.bin.display());
    match client.version() {
        Ok(v) => println!("tmux version: {} ({}.{})", v.raw, v.major, v.minor),
        Err(e) => println!("tmux version: {e}"),
    }
    let sock = cfg
        .socket_name
        .clone()
        .unwrap_or_else(|| sparkmux_core::SOCKET_NAME.to_string());
    println!("socket name: {sock}");
    match client.socket_path_display() {
        Ok(p) => println!("socket path: {p}"),
        Err(e) => println!("socket path: ({e})"),
    }
    match client.snapshot() {
        Ok(s) => {
            println!("sessions: {}", s.sessions.len());
            for sess in &s.sessions {
                println!("  - {}", sess.name);
            }
            if s.sessions.is_empty() {
                println!("default session if started: {DEFAULT_SESSION}");
            }
        }
        Err(e) => println!("sessions: {e}"),
    }
    Ok(ExitCode::SUCCESS)
}

fn init_tracing(verbose: bool) {
    let filter = if verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
