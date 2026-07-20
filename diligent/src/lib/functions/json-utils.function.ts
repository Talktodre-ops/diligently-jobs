// Shared JSON-extraction + repair helpers for LLM streaming output.
//
// LLM JSON output breaks in many small ways:
//   - Wrapped in ```json ... ``` markdown fences
//   - Wrapped in <think> ... </think> reasoning blocks (DeepSeek-R1, etc.)
//   - Truncated mid-array when max_tokens is hit
//   - Trailing commas, line comments, single-quoted strings
//   - Unescaped quotes / control chars inside string values
//   - Mixed JSON + prose explanation
//
// The repair pipeline tries strict → custom truncation repair → jsonrepair
// (purpose-built for LLM output). Logs the failing slice so we can
// diagnose recurrences without guessing.
//
// Originally lived as private copies in cv.function.ts and job.function.ts.
// Extracted here once jsonrepair joined the chain — both call sites now
// share the same hardened path.

import { jsonrepair } from "jsonrepair";

/** Strip <think>...</think> reasoning blocks that some models emit before
 *  their structured output. Case-insensitive, multiline. */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Escape control chars that appear unescaped inside JSON string values.
 *  Tracks string state so we only escape chars between unescaped quotes. */
export function sanitizeJson(str: string): string {
  const escapeMap: Record<string, string> = {
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\b": "\\b",
    "\f": "\\f",
  };
  let out = "";
  let inString = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (inString) {
      if (ch === "\\") {
        out += ch;
        i++;
        if (i < str.length) out += str[i];
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) {
        out +=
          escapeMap[ch] ??
          `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
    i++;
  }
  return out;
}

/** Strip prose/markdown around a JSON object or array. Returns the
 *  candidate JSON substring (still possibly malformed). */
export function extractJson(text: string): string {
  const cleaned = stripThinkBlocks(text);
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return sanitizeJson(codeBlock[1].trim());
  const firstBracket = cleaned.indexOf("[");
  const firstBrace = cleaned.indexOf("{");
  if (firstBracket === -1 && firstBrace === -1) return cleaned;
  const isArray =
    firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);
  const start = isArray ? firstBracket : firstBrace;
  const end = cleaned.lastIndexOf(isArray ? "]" : "}");
  const raw = end === -1 ? cleaned.slice(start) : cleaned.slice(start, end + 1);
  return sanitizeJson(raw);
}

/** Truncation-tolerant repair: when the LLM ran out of tokens mid-array,
 *  cut to the last whole element + closing bracket. Conservative — won't
 *  touch valid input. */
export function repairTruncatedJson(raw: string): string {
  const trimmed = raw.trim();
  const isArray = trimmed.startsWith("[");
  const isObject = trimmed.startsWith("{");
  if (!isArray && !isObject) return raw;
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastSafeArrayItemEnd = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (isArray && depth === 1 && c === "}") {
        lastSafeArrayItemEnd = i;
      }
      if (depth === 0) return trimmed.slice(0, i + 1);
    }
  }
  if (isArray && lastSafeArrayItemEnd !== -1) {
    return trimmed.slice(0, lastSafeArrayItemEnd + 1) + "]";
  }
  return raw;
}

/** Pull a line-and-column reference + the ~200 chars around it out of a
 *  JSON parse error message so logs are useful at a glance. */
function describeFailure(raw: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const posMatch = /position (\d+)/.exec(msg);
  if (!posMatch) return msg;
  const pos = parseInt(posMatch[1], 10);
  const start = Math.max(0, pos - 100);
  const end = Math.min(raw.length, pos + 100);
  // Show \n as literal so the snippet stays on one line in the console.
  const snippet = raw.slice(start, end).replace(/\n/g, "\\n");
  return `${msg}\n  context: …${snippet}…\n  pointer:  ${" ".repeat(Math.min(100, pos - start))}^`;
}

/** Parse JSON with three escalating recovery strategies. Logs a useful
 *  failure snippet if everything fails — so the next bug report includes
 *  the actual offending input. */
export function parseJsonLenient<T>(raw: string): T {
  // 1. Strict — the happy path.
  try {
    return JSON.parse(raw) as T;
  } catch (firstErr) {
    // 2. Truncation repair — handles "ran out of tokens" mid-array.
    const truncRepaired = repairTruncatedJson(raw);
    if (truncRepaired !== raw) {
      try {
        return JSON.parse(truncRepaired) as T;
      } catch {
        /* fall through */
      }
    }
    // 3. jsonrepair — fixes trailing commas, unescaped quotes, comments,
    //    single-quoted strings, missing brackets, and similar LLM-ish
    //    breakage. Purpose-built for this exact use case.
    try {
      const fullRepaired = jsonrepair(raw);
      return JSON.parse(fullRepaired) as T;
    } catch (lastErr) {
      console.error(
        "[json-utils] parseJsonLenient: all repair strategies failed.",
        "\n  first error:",
        describeFailure(raw, firstErr),
        "\n  jsonrepair error:",
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      );
      throw firstErr;
    }
  }
}
