fn main() {
    let env_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env");
    let _ = dotenv::from_path(&env_path);

    // Tavily Search API key — powers the company-research feature (Phase 3, M1).
    // Baked at build time like the other secrets; also readable at runtime from
    // src-tauri/.env via dotenv in lib.rs, so it can be set without a rebuild.
    if let Ok(tavily_api_key) = std::env::var("TAVILY_API_KEY") {
        println!("cargo:rustc-env=TAVILY_API_KEY={}", tavily_api_key);
    }

    tauri_build::build()
}
