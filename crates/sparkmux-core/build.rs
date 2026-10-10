fn main() {
    // libc::openpty is in libutil on Linux. macOS provides it in libSystem.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-lib=util");
    }
}
