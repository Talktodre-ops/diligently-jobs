fn main() {
    let env_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env");
    let _ = dotenv::from_path(&env_path);
    
     if let Ok(payment_endpoint) = std::env::var("PAYMENT_ENDPOINT") {
        println!("cargo:rustc-env=PAYMENT_ENDPOINT={}", payment_endpoint);
    }
    
    if let Ok(api_access_key) = std::env::var("API_ACCESS_KEY") {
        println!("cargo:rustc-env=API_ACCESS_KEY={}", api_access_key);
    }
    
    if let Ok(app_endpoint) = std::env::var("APP_ENDPOINT") {
        println!("cargo:rustc-env=APP_ENDPOINT={}", app_endpoint);
    }

    if let Ok(deepgram_api_key) = std::env::var("DEEPGRAM_API_KEY") {
        println!("cargo:rustc-env=DEEPGRAM_API_KEY={}", deepgram_api_key);
    }

    if let Ok(deepgram_model) = std::env::var("DEEPGRAM_MODEL") {
        println!("cargo:rustc-env=DEEPGRAM_MODEL={}", deepgram_model);
    }

    // Tavily Search API key — powers the company-research feature (Phase 3, M1).
    // Baked at build time like the other secrets; also readable at runtime from
    // src-tauri/.env via dotenv in lib.rs, so it can be set without a rebuild.
    if let Ok(tavily_api_key) = std::env::var("TAVILY_API_KEY") {
        println!("cargo:rustc-env=TAVILY_API_KEY={}", tavily_api_key);
    }

    tauri_build::build()
}
