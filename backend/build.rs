// Re-embed migrations whenever the folder changes; sqlx::migrate! reads it at
// compile time and cargo would otherwise reuse a stale build.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
