// rust-embed needs the UI and plugin folders to exist at compile time. When they have not been
// built (e.g. `cargo test` without pnpm), create empty ones so the server still compiles.
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for dir in ["ui/dist", "plugins/dist"] {
        let path = root.join(dir);
        if !path.exists() {
            let _ = std::fs::create_dir_all(&path);
        }
        println!("cargo:rerun-if-changed=../../{dir}");
    }
}
