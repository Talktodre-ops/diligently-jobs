use serde::{Deserialize, Serialize};
use std::env;
use tauri::{AppHandle, Manager, Emitter};
use futures_util::StreamExt;
use std::fs;
use std::path::PathBuf;
use base64::Engine;

/// PUT a WAV file at the given path to the supplied presigned URL.
///
/// Used by the interview audio upload flow: the desktop presigns an upload
/// URL via the backend, then calls this command to stream the bytes from
/// disk directly to R2. Keeping the transfer in Rust avoids reading a
/// 100MB+ file into JS memory.
///
/// Errors are returned as strings (caller is JS, so no anyhow). We delete
/// the local WAV on success so the user's disk doesn't accumulate session
/// files; leave it on failure so the user can retry / inspect.
#[tauri::command]
pub async fn upload_audio_file_to_url(
    wav_path: String,
    put_url: String,
) -> Result<u64, String> {
    let path = PathBuf::from(&wav_path);
    let bytes = fs::read(&path).map_err(|e| format!("read WAV at {wav_path}: {e}"))?;
    let len = bytes.len() as u64;

    let client = reqwest::Client::new();
    let resp = client
        .put(&put_url)
        .header("Content-Type", "audio/wav")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("upload PUT failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("upload returned {status}: {body}"));
    }

    // Best-effort cleanup of the local WAV — the audio now lives in R2.
    let _ = fs::remove_file(&path);
    Ok(len)
}

fn get_app_endpoint() -> Result<String, String> {
    if let Ok(endpoint) = env::var("APP_ENDPOINT") {
        return Ok(endpoint);
    }
    
    match option_env!("APP_ENDPOINT") {
        Some(endpoint) => Ok(endpoint.to_string()),
        None => Err("APP_ENDPOINT environment variable not set. Please ensure it's set during the build process.".to_string())
    }
}

fn get_api_access_key() -> Result<String, String> {
    if let Ok(key) = env::var("API_ACCESS_KEY") {
        return Ok(key);
    }
    
    match option_env!("API_ACCESS_KEY") {
        Some(key) => Ok(key.to_string()),
        None => Err("API_ACCESS_KEY environment variable not set. Please ensure it's set during the build process.".to_string())
    }
}

/// Tauri command — surfaces whether DEEPGRAM_API_KEY is set, for the System
/// Health diagnostic panel. Returns the key (so the UI can show a prefix)
/// or null if missing/empty.
#[tauri::command]
pub fn get_deepgram_api_key_cmd() -> Result<Option<String>, String> {
    Ok(get_deepgram_api_key())
}

fn get_deepgram_api_key() -> Option<String> {
    if let Ok(key) = env::var("DEEPGRAM_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }

    match option_env!("DEEPGRAM_API_KEY") {
        Some(key) if !key.trim().is_empty() => Some(key.to_string()),
        _ => None,
    }
}

fn get_deepgram_model() -> String {
    if let Ok(model) = env::var("DEEPGRAM_MODEL") {
        if !model.trim().is_empty() {
            return model;
        }
    }

    option_env!("DEEPGRAM_MODEL")
        .unwrap_or("nova-3")
        .to_string()
}

fn get_llm_api_key_for_provider(provider_id: &str) -> Option<String> {
    let env_name = match provider_id.to_lowercase().as_str() {
        "openai" => "OPENAI_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        // Interview mode + screenshot-code mode default to Anthropic. Provider
        // id "claude" matches AI_PROVIDERS[].id in src/config/ai-providers.constants.ts.
        "claude" | "anthropic" => "ANTHROPIC_API_KEY",
        _ => return None,
    };

    if let Ok(value) = env::var(env_name) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }

    match env_name {
        "OPENAI_API_KEY" => option_env!("OPENAI_API_KEY")
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.to_string()),
        "DEEPSEEK_API_KEY" => option_env!("DEEPSEEK_API_KEY")
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.to_string()),
        "ANTHROPIC_API_KEY" => option_env!("ANTHROPIC_API_KEY")
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.to_string()),
        _ => None,
    }
}

fn get_llm_model_for_provider(provider_id: &str) -> Option<String> {
    let env_name = match provider_id.to_lowercase().as_str() {
        "openai" => "OPENAI_MODEL",
        "deepseek" => "DEEPSEEK_MODEL",
        "claude" | "anthropic" => "ANTHROPIC_MODEL",
        _ => return None,
    };

    if let Ok(value) = env::var(env_name) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }

    match env_name {
        "OPENAI_MODEL" => option_env!("OPENAI_MODEL")
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.to_string())
            .or(Some("gpt-4o-mini".to_string())),
        // deepseek-v4-pro — thinking-capable. Default since 2026-06; the
        // older deepseek-chat / deepseek-reasoner IDs deprecate 2026-07-24.
        // Override at build time via option_env! DEEPSEEK_MODEL or at runtime
        // via src-tauri/.env if you want a different model (e.g. v4-flash
        // for lower latency without thinking).
        "DEEPSEEK_MODEL" => option_env!("DEEPSEEK_MODEL")
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.to_string())
            .or(Some("deepseek-v4-pro".to_string())),
        "ANTHROPIC_MODEL" => option_env!("ANTHROPIC_MODEL")
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.to_string())
            .or(Some("claude-sonnet-4-6".to_string())),
        _ => None,
    }
}

// Secure storage functions
fn get_secure_storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    
    Ok(app_data_dir.join("secure_storage.json"))
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SecureStorage {
    license_key: Option<String>,
    instance_id: Option<String>,
    selected_managed_model: Option<String>,
}

async fn get_stored_credentials(app: &AppHandle) -> Result<(String, String, Option<Model>), String> {
    let storage_path = get_secure_storage_path(app)?;
    
    if !storage_path.exists() {
        return Err("No license found. Please activate your license first.".to_string());
    }
    
    let content = fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read storage file: {}", e))?;
    
    let storage: SecureStorage = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse storage file: {}", e))?;
    
    let license_key = storage.license_key.ok_or("License key not found".to_string())?;
    let instance_id = storage.instance_id.ok_or("Instance ID not found".to_string())?;

    let selected_model: Option<Model> = storage.selected_managed_model
        .and_then(|json_str| serde_json::from_str(&json_str).ok());
    
    Ok((license_key, instance_id, selected_model))
}

// Audio API Structs
#[derive(Debug, Serialize, Deserialize)]
pub struct AudioRequest {
    audio_base64: String,  
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioResponse {
    success: bool,
    transcription: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeepgramAlternative {
    transcript: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeepgramChannel {
    alternatives: Option<Vec<DeepgramAlternative>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeepgramResults {
    channels: Option<Vec<DeepgramChannel>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeepgramResponse {
    results: Option<DeepgramResults>,
}

async fn transcribe_with_deepgram(audio_base64: &str, api_key: &str) -> Result<AudioResponse, String> {
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("Failed to decode audio payload: {}", e))?;

    let model = get_deepgram_model();
    let url = format!(
        "https://api.deepgram.com/v1/listen?model={}&smart_format=true&punctuate=true",
        model
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Token {}", api_key))
        .header("Content-Type", "audio/wav")
        .body(audio_bytes)
        .send()
        .await
        .map_err(|e| format!("Failed to call Deepgram API: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown Deepgram error".to_string());
        return Err(format!("Deepgram error ({}): {}", status, error_text));
    }

    let deepgram_response: DeepgramResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Deepgram response: {}", e))?;

    let transcript = deepgram_response
        .results
        .and_then(|r| r.channels)
        .and_then(|mut c| c.drain(..).next())
        .and_then(|channel| channel.alternatives)
        .and_then(|mut alts| alts.drain(..).next())
        .and_then(|alt| alt.transcript)
        .unwrap_or_default()
        .trim()
        .to_string();

    if transcript.is_empty() {
        return Ok(AudioResponse {
            success: false,
            transcription: None,
            error: Some("Deepgram returned an empty transcript".to_string()),
        });
    }

    Ok(AudioResponse {
        success: true,
        transcription: Some(transcript),
        error: None,
    })
}

// Chat API Structs
#[derive(Debug, Serialize, Deserialize)]
pub struct ChatRequest {
    user_message: String,
    system_prompt: Option<String>,
    image_base64: Option<serde_json::Value>, // Can be string or array
    history: Option<String>,
}

// Model API Structs
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Model {
    provider: String,
    name: String,
    id: String,
    model: String,
    description: String,
    modality: String,
    #[serde(rename = "isAvailable")]
    is_available: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelsResponse {
    models: Vec<Model>,
}


// Audio API Command
#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    audio_base64: String,
) -> Result<AudioResponse, String> {
    if let Some(deepgram_api_key) = get_deepgram_api_key() {
        return transcribe_with_deepgram(&audio_base64, &deepgram_api_key).await;
    }

    // Get environment variables
    let app_endpoint = get_app_endpoint()?;
    let api_access_key = get_api_access_key()?;
    
    // Get stored credentials (legacy managed endpoint mode)
    let (license_key, instance_id, _) = get_stored_credentials(&app).await?;
    
    // Prepare audio request
    let audio_request = AudioRequest {
        audio_base64,
     
    };
    
    // Make HTTP request to audio endpoint
    let client = reqwest::Client::new();
    let url = format!("{}/api/audio", app_endpoint);
    
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .header("license_key", &license_key)
        .header("instance", &instance_id)
        .json(&audio_request)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make audio request: {}", parts[0])
                } else {
                    format!("Failed to make audio request: {}", error_msg)
                }
            } else {
                format!("Failed to make audio request: {}", error_msg)
            }
        })?;
    
    // Check if the response is successful
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown server error".to_string());
        
        // Try to parse error as JSON to get a more specific error message
        if let Ok(error_json) = serde_json::from_str::<serde_json::Value>(&error_text) {
            if let Some(error_msg) = error_json.get("error").and_then(|e| e.as_str()) {
                return Err(format!("Server error ({}): {}", status, error_msg));
            } else if let Some(message) = error_json.get("message").and_then(|m| m.as_str()) {
                return Err(format!("Server error ({}): {}", status, message));
            }
        }
        
        return Err(format!("Server error ({}): {}", status, error_text));
    }
    
    let audio_response: AudioResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse audio response: {}", e))?;
    
    Ok(audio_response)
}

// Chat API Command with Streaming
#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    user_message: String,
    system_prompt: Option<String>,
    image_base64: Option<serde_json::Value>,
    history: Option<String>,
) -> Result<String, String> {
    // Get environment variables
    let app_endpoint = get_app_endpoint()?;
    let api_access_key = get_api_access_key()?;
    
    // Get stored credentials
    let (license_key, instance_id, selected_model) = get_stored_credentials(&app).await?;
    let (provider, model) = selected_model.as_ref().map_or((None, None), |m| (Some(m.provider.clone()), Some(m.model.clone())));
   
    // Prepare chat request
    let chat_request = ChatRequest {
        user_message,
        system_prompt,
        image_base64,
        history
    };
    
    // Make HTTP request to chat endpoint with streaming
    let client = reqwest::Client::new();
    let url = format!("{}/api/chat?stream=true", app_endpoint);
    
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .header("license_key", &license_key)
        .header("instance", &instance_id)
        .header("provider", &provider.unwrap_or("None".to_string()))
        .header("model", &model.unwrap_or("None".to_string()))
        .json(&chat_request)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make chat request: {}", parts[0])
                } else {
                    format!("Failed to make chat request: {}", error_msg)
                }
            } else {
                format!("Failed to make chat request: {}", error_msg)
            }
        })?;
    
    // Check if the response is successful
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown server error".to_string());
        
        // Try to parse error as JSON to get a more specific error message
        if let Ok(error_json) = serde_json::from_str::<serde_json::Value>(&error_text) {
            if let Some(error_msg) = error_json.get("error").and_then(|e| e.as_str()) {
                return Err(format!("Server error ({}): {}", status, error_msg));
            } else if let Some(message) = error_json.get("message").and_then(|m| m.as_str()) {
                return Err(format!("Server error ({}): {}", status, message));
            }
        }
        
        return Err(format!("Server error ({}): {}", status, error_text));
    }
    
    // Handle streaming response
    let mut stream = response.bytes_stream();
    let mut full_response = String::new();
    let mut buffer = String::new();
    
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let chunk_str = String::from_utf8_lossy(&bytes);
                buffer.push_str(&chunk_str);
                
                // Process complete lines
                let lines: Vec<&str> = buffer.split('\n').collect();
                let incomplete_line = lines.last().unwrap_or(&"").to_string();
                
                for line in &lines[..lines.len()-1] { // Process all but the last (potentially incomplete) line
                    let trimmed_line = line.trim();
                    
                    if trimmed_line.starts_with("data: ") {
                        let json_str = trimmed_line.strip_prefix("data: ").unwrap_or("");
                        
                        if json_str == "[DONE]" {
                            break;
                        }
                        
                        if !json_str.is_empty() {
                            // Try to parse the JSON and extract content
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
                                if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                                    if let Some(first_choice) = choices.first() {
                                        if let Some(delta) = first_choice.get("delta") {
                                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                                full_response.push_str(content);
                                                // Emit just the content to frontend
                                                let _ = app.emit("chat_stream_chunk", content);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Update buffer with incomplete line
                buffer = incomplete_line;
            }
            Err(e) => {
                return Err(format!("Stream error: {}", e));
            }
        }
    }
    
    // Emit completion event
    let _ = app.emit("chat_stream_complete", &full_response);
    
    Ok(full_response)
}

// Models API Command
#[tauri::command]
pub async fn fetch_models() -> Result<Vec<Model>, String> {
    // Get environment variables
    let app_endpoint = get_app_endpoint()?;
    let api_access_key = get_api_access_key()?;
    
    // Make HTTP request to models endpoint
    let client = reqwest::Client::new();
    let url = format!("{}/api/models", app_endpoint);
    
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_access_key))
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!("{}", e);
            if error_msg.contains("url (") {
                // Remove the URL part from the error message
                let parts: Vec<&str> = error_msg.split(" for url (").collect();
                if parts.len() > 1 {
                    format!("Failed to make models request: {}", parts[0])
                } else {
                    format!("Failed to make models request: {}", error_msg)
                }
            } else {
                format!("Failed to make models request: {}", error_msg)
            }
        })?;
        
    // Check if the response is successful
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown server error".to_string());
        
        // Try to parse error as JSON to get a more specific error message
        if let Ok(error_json) = serde_json::from_str::<serde_json::Value>(&error_text) {
            if let Some(error_msg) = error_json.get("error").and_then(|e| e.as_str()) {
                return Err(format!("Server error ({}): {}", status, error_msg));
            } else if let Some(message) = error_json.get("message").and_then(|m| m.as_str()) {
                return Err(format!("Server error ({}): {}", status, message));
            }
        }
        
        return Err(format!("Server error ({}): {}", status, error_text));
    }
    
    let models_response: ModelsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))?;
        
    Ok(models_response.models)
}

// Helper command to check if license is available
#[tauri::command]
pub async fn check_license_status(app: AppHandle) -> Result<bool, String> {
    match get_stored_credentials(&app).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn get_ai_provider_api_key(provider_id: String) -> Result<Option<String>, String> {
    Ok(get_llm_api_key_for_provider(&provider_id))
}

#[tauri::command]
pub async fn get_ai_provider_default_model(provider_id: String) -> Result<Option<String>, String> {
    Ok(get_llm_model_for_provider(&provider_id))
}
