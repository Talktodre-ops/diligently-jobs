// Storage keys
export const STORAGE_KEYS = {
  THEME: "theme",
  CHAT_HISTORY: "chat_history",
  SYSTEM_PROMPT: "system_prompt",
  SCREENSHOT_CONFIG: "screenshot_config",
  // add curl_ prefix because we are using curl to store the providers
  CUSTOM_AI_PROVIDERS: "curl_custom_ai_providers",
  SELECTED_AI_PROVIDER: "curl_selected_ai_provider",
  SYSTEM_AUDIO_CONTEXT: "system_audio_context",
  SYSTEM_AUDIO_QUICK_ACTIONS: "system_audio_quick_actions",
  CUSTOMIZABLE: "customizable",
  JOB_WORKSPACES: "job_workspaces",
  UPWORK_WORKSPACES: "upwork_workspaces",
} as const;

// Max number of files that can be attached to a message
export const MAX_FILES = 20;

// Default settings
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, knowledgeable assistant. Answer the user's questions clearly and accurately in plain text. Be concise and direct — skip greetings and filler.

When given an image or screenshot, read what it contains and answer the question it poses: explain the concept, work through the problem, or give the solution shown.
- For code: provide the corrected or requested code in a fenced block, then a short explanation of what it does or what you changed and why.
- For math or factual questions: give the final answer first, then brief working.
- For anything else: just answer it clearly.

Use the conversation so far as context. Ask a clarifying question only when the request is genuinely ambiguous; otherwise give your best answer.`;

// Default user message sent automatically with an auto-mode screenshot.
// Branches by content type so the same default answers a question, solves a
// coding problem, or works a math problem depending on what's shown.
export const DEFAULT_SCREENSHOT_AUTO_PROMPT =
  `Answer the question shown in this screenshot. Identify what it's asking — a concept, a coding task, or a math/factual question — and answer it directly.

- Code: give the corrected or requested code in a single fenced block, plus one short line on the approach.
- Math or factual: give the final answer first, then minimal working.
- Otherwise: answer clearly and concisely.

No preamble, no closing summary.`;

export const DEFAULT_QUICK_ACTIONS = [
  "What should I say?",
  "Follow-up questions",
  "Fact-check",
  "Recap",
];
