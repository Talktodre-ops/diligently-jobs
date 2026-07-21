// Diligently ships with a single built-in provider: Claude (Anthropic).
// The desktop reads ANTHROPIC_API_KEY / ANTHROPIC_MODEL from src-tauri/.env
// (or you can paste the key in Settings → AI Providers).
export const AI_PROVIDERS = [
  {
    id: "claude",
    name: "Claude (Anthropic)",
    // media_type MUST match the actual bytes — Anthropic strictly validates
    // this and 400s ("image was specified using the image/png media type but
    // the image appears to be image/jpeg") if they disagree. Our pipeline
    // produces JPEG (Rust capture_to_base64 + JS compressScreenshot both encode
    // JPEG), so this is image/jpeg.
    curl: `curl https://api.anthropic.com/v1/messages \\
  -H "x-api-key: {{API_KEY}}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "anthropic-dangerous-direct-browser-access: true" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "{{MODEL}}",
    "system": "{{SYSTEM_PROMPT}}",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "{{TEXT}}"}, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "{{IMAGE}}"}}]}],
    "max_tokens": 4096
  }'`,
    responseContentPath: "content[0].text",
    streaming: true,
  },
];
