// rust-embed needs the UI folder to exist at compile time. When the UI has not been built
// (e.g. `cargo test` without pnpm), create an empty one so the server still compiles.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(&dist);
    }
    println!("cargo:rerun-if-changed=../../ui/dist");
}
