// Pure helpers for the interview state machine. Zero deps — easy to test.
//
// Three jobs:
//   1. Filler filter: drop "mhm", "yeah", "ok" before we ever fire the LLM.
//   2. Technical classifier: bump to a stronger model on hard questions.
//   3. Code detector: surface a "send screenshot" affordance when the
//      interviewer's question implies writing code.

const FILLER_PHRASES = new Set([
  "mhm",
  "mm-hmm",
  "uh-huh",
  "uh huh",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "alright",
  "right",
  "right right",
  "sure",
  "got it",
  "i see",
  "i see.",
  "go on",
  "uh",
  "um",
  "hmm",
  "hm",
  "cool",
  "nice",
  "great",
  "perfect",
  "thanks",
  "thank you",
]);

const QUESTION_WORDS = [
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "tell",
  "describe",
  "explain",
  "walk",
  "design",
  "implement",
  "write",
  "code",
  "build",
  "give",
  "show",
  "compare",
  "contrast",
];

/**
 * True if the utterance is a filler / affirmation and should NOT trigger an
 * LLM call.
 *
 * Rules:
 *   - exact-match against known filler phrases (case + punctuation
 *     insensitive)
 *   - <=3 words AND no question word AND no question mark
 */
export function isFiller(text: string): boolean {
  const cleaned = text.trim().toLowerCase().replace(/[.,!?]+$/, "");
  if (!cleaned) return true;
  if (FILLER_PHRASES.has(cleaned)) return true;

  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount > 3) return false;

  const hasQuestionMark = /[?]/.test(text);
  if (hasQuestionMark) return false;

  const hasQuestionWord = QUESTION_WORDS.some((w) =>
    new RegExp(`\\b${w}\\b`, "i").test(cleaned)
  );
  return !hasQuestionWord;
}

// Words that strongly imply the interviewer wants code now.
const CODE_KEYWORDS = [
  "implement",
  "write a function",
  "write the code",
  "write code",
  "leetcode",
  "algorithm",
  "data structure",
  "code this",
  "solve this",
  "reverse a",
  "binary tree",
  "linked list",
  "graph",
  "dynamic programming",
];

export function suggestsCodeMode(text: string): boolean {
  const lower = text.toLowerCase();
  return CODE_KEYWORDS.some((k) => lower.includes(k));
}

// System-design triggers — broad patterns because we want to
// catch open-ended questions like "how would you architect X" or "walk me
// through the design of Y" even without classic textbook keywords.
const SYSTEM_DESIGN_PATTERNS: RegExp[] = [
  /\bsystem\s+design\b/i,
  /\bdesign\s+(a|an|the)\s+\w+/i,
  /\barchitect(ure)?\b/i,
  /\bhow\s+would\s+you\s+(build|design|architect|scale)\b/i,
  /\bdraw\s+(a|the)?\s*(diagram|architecture)\b/i,
  /\bhigh[- ]level\s+(design|architecture)\b/i,
  /\b(scal(e|ing)\s+to|millions?|billions?)\s+(of\s+)?(users|requests|qps|rps|tps)\b/i,
  /\bdistributed\s+(system|service|architecture)\b/i,
  /\bmicroservices\b/i,
  /\bdata\s+pipeline\b/i,
];

export function suggestsSystemDesign(text: string): boolean {
  return SYSTEM_DESIGN_PATTERNS.some((re) => re.test(text));
}
