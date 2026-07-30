// Claude (Anthropic) is the single provider offered in Settings — it powers the
// quick chat and screenshot/vision. The desktop reads ANTHROPIC_API_KEY /
// ANTHROPIC_MODEL from src-tauri/.env (or you can paste the key in Settings).
//
// The job + Upwork generators run on DeepSeek instead — see DEEPSEEK_PROVIDER
// at the bottom of this file.
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

// Provider used by the job + Upwork generators (CV parse/tailor, JD parse, gap
// analysis, company research, cover letter, follow-up, proposals). Deliberately
// NOT in AI_PROVIDERS: it isn't a user-selectable chat provider, it's the fixed
// backend for structured generation.
//
// `thinking` is DISABLED on purpose. DeepSeek's thinking mode (reasoning_effort
// high) adds 10-30s per call and spends the output budget on reasoning, which
// truncates schema-following JSON mid-array. With thinking off the same calls
// return complete JSON in ~2-3s.
//
// The key/model come from DEEPSEEK_API_KEY / DEEPSEEK_MODEL in src-tauri/.env,
// resolved by the Rust `get_ai_provider_api_key` / `get_ai_provider_default_model`
// commands via the provider id below.
export const DEEPSEEK_PROVIDER = {
  id: "deepseek",
  name: "DeepSeek",
  curl: `curl https://api.deepseek.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -d '{
    "model": "{{MODEL}}",
    "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": [{"type": "text", "text": "{{TEXT}}"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,{{IMAGE}}"}}]}],
    "temperature": 0.2,
    "max_tokens": 4096,
    "thinking": {"type": "disabled"}
  }'`,
  responseContentPath: "choices[0].message.content",
  streaming: true,
};

// The `selectedProvider`-shaped companion for DEEPSEEK_PROVIDER. Empty
// variables => fetchAIResponse env-autofills the key + model from the Rust side.
export const DEEPSEEK_SELECTED = {
  provider: "deepseek",
  variables: {} as Record<string, string>,
};
