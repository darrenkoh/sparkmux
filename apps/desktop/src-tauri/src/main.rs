#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(opts) = sparkmux_desktop_lib::serve_options_from_env(&args) {
        if let Err(err) = sparkmux_desktop_lib::serve_blocking(opts) {
            eprintln!("error: {err}");
            std::process::exit(1);
        }
        return;
    }
    sparkmux_desktop_lib::run()
}
