import { useEffect, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import {
  fetchInterviewResponse,
  isFiller,
  suggestsCodeMode,
  suggestsSystemDesign,
  type InterviewModel,
} from "@/lib/functions";
import {
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  STORAGE_KEYS,
} from "@/config";
import {
  generateConversationTitle,
  loadWorkspaces,
  safeLocalStorage,
  saveConversation,
} from "@/lib";
import {
  appendEvent,
  endInterview,
  presignUpload,
  startInterview,
} from "@/lib/backend";
import { Message } from "@/types/completion";
import type { JobWorkspace } from "@/types";

export const CODE_LANGUAGES = ["python", "javascript", "typescript", "go", "rust", "java", "cpp"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  go: "Go",
  rust: "Rust",
  java: "Java",
  cpp: "C++",
};
export { CODE_LANGUAGE_LABELS };

/** Best-effort backend write helper. */
function fireAndForget(label: string, p: Promise<unknown>): void {
  p.catch((err) => {
    console.warn(`[backend] ${label} failed:`, err);
  });
}

// =============================================================================
// Settle / cancel state machine constants
// =============================================================================
/** ms to wait after a final before firing the LLM — coalesces fragmented
 *  speech like "Tell me about X. Specifically the data part." */
const SETTLE_MS = 500;
/** if the LLM has been streaming for less than this AND fewer than
 *  STREAM_CANCEL_TOKEN_THRESHOLD tokens have been rendered, a new utterance
 *  cancels and restarts (interruption). */
const STREAM_CANCEL_WINDOW_MS = 1500;
const STREAM_CANCEL_TOKEN_THRESHOLD = 50;

// =============================================================================
// Chat / conversation types (mirrored from prior version of this hook)
// =============================================================================
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

interface TranscriptInterimPayload {
  text: string;
  speaker?: number | null;
}
interface TranscriptFinalPayload {
  text: string;
  start: number;
  duration: number;
  speech_final: boolean;
  /** Deepgram's diarized speaker id (0, 1, 2…). Null when no words were
   *  tagged (rare — happens on very short utterances). */
  speaker?: number | null;
}
interface CaptureFinishedPayload {
  wav_path: string;
  sample_rate: number;
  duration_seconds: number;
}

/**
 * Pick the active job workspace at the time of an interview turn. Uses the
 * most-recently-updated workspace as the heuristic — the user almost always
 * runs the interview against the JD they just parsed.
 */
function activeWorkspace(): JobWorkspace | null {
  const all = loadWorkspaces();
  if (all.length === 0) return null;
  return all.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/**
 * Build the interview system prompt. When a job workspace exists and the
 * "use workspace context" toggle is on, inject the role/company/requirements
 * + CV bullets so answers are anchored to the candidate's actual experience.
 */
function buildInterviewPrompt(
  basePrompt: string,
  workspace: JobWorkspace | null,
  useWorkspaceContext: boolean,
  codeLanguage: CodeLanguage
): string {
  const header = `You are speaking as the candidate in a live interview. Generate the answer
they should say, in first person ("I built…", "We scaled…", "My approach was…").
Output goes directly on-screen — what you write is what they read aloud.

QUALITY BAR — do not fail this:
- Specific, never generic. Concrete tech names, real numbers, named outcomes
  ("cut p95 latency from 380ms to 90ms", not "improved performance").
- Match the role's seniority. Junior → simpler scope; senior/staff → architecture,
  trade-offs, cross-team impact.
- Length: behavioral 100-180 words. Technical 150-300 words. System-design or
  coding: as long as needed for completeness, no padding.
- Behavioral: STAR (Situation → Task → Action → Result), but written as flowing
  prose, not labeled sections.
- Technical: 1-sentence hook → concrete approach → 1-2 trade-offs → result/numbers.
- End with a thread the interviewer can pull on ("happy to go deeper on the
  consistency model", "we also looked at X but rejected it because…").

ABBREVIATION RULE — non-negotiable, check before you finalize each response:

Every abbreviation, acronym, or initialism MUST be followed by its full
expansion in parentheses the first time it appears in THIS response (not
"in the conversation" — every response stands alone for this rule). After
its first expansion in this response, the bare form is fine.

CORRECT: "We exposed an API (Application Programming Interface) over HTTPS
(Hypertext Transfer Protocol Secure), and the SDK (Software Development Kit)
wrapped the auth flow."
INCORRECT: "We exposed an API over HTTPS, and the SDK wrapped the auth flow."

This applies to ALL three- and four-letter forms: API, SDK, ORM, DB, RDBMS,
ML, AI, NLP, CI/CD, TDD, BDD, DDD, SLA, SLO, SLI, KPI, OKR, CDN, DNS, TLS,
SSL, HTTP, HTTPS, REST, RPC, gRPC, GraphQL, JWT, OAuth, SAML, SSO, RBAC,
ACID, BASE, CAP, CQRS, ETL, ELT, OLAP, OLTP, MVC, MVVM, SPA, SSR, SSG, ISR,
PWA, IDE, OS, VM, K8s, AWS, GCP, CRUD — and any others you use.

Before you stop generating, mentally scan your response for any 2-5 letter
all-caps token. If it lacks parens on first use, you've violated the rule —
revise it. This is not optional.

SYSTEM-DESIGN QUESTIONS — when the interviewer asks to design, architect, or
scale a system, follow this exact structure (do NOT fall back to a generic
answer):

1. **Clarify (one paragraph, 2-4 sentences)** — Surface the load/scale
   assumptions you're making (read-heavy vs write-heavy? expected QPS
   (Queries Per Second)? consistency requirements? latency SLOs (Service
   Level Objectives)?). Phrase as decisions, not questions — you don't
   pause for the interviewer to answer.

2. **Architecture diagram** — A Mermaid flowchart that shows the major
   components and data flow.

   MERMAID SYNTAX RULES — follow exactly, the parser is strict:

   FORMAT:
   - ONE statement per line. Never put two node definitions or an edge and
     a node on the same line.
   - ALWAYS put a space (or newline) between any closing bracket (\`]\`, \`)\`,
     \`}\`) and the next token. Bad: \`Cache[("Redis")]API --> DB\` — the parser
     reads \`Cache[("Redis")]API\` as one malformed node. Good (one per line):
        \`Cache[("Redis")]\`
        \`Cache --> API\`
        \`API --> DB\`

   NODES:
   - Every node id is one word, alphanumeric only, no spaces or dashes.
     Good: \`LB\`, \`API1\`, \`PostgresMain\`. Bad: \`Load Balancer\`, \`API-1\`.
   - Every node LABEL is wrapped in DOUBLE QUOTES if it contains anything
     other than letters, digits, and single spaces. ANY of these characters
     forces quotes: \`&\` \`(\` \`)\` \`/\` \`<\` \`>\` \`-\` \`,\` \`:\` numerals next to letters.
     Good: \`Client["Mobile & Web"]\`, \`API1["API Server (v2)"]\`,
            \`Cache[("Redis Cluster")]\`.
     Bad:  \`Client[Mobile & Web]\` ← unquoted & breaks the parser.
   - When in doubt, ALWAYS quote the label. Quoting never hurts; missing
     quotes around special chars always breaks.
   - Shapes: \`Node[Label]\` for services, \`Node[("Datastore Label")]\` for
     datastores (double parens = cylinder), \`Node{"Decision"}\` for diamonds
     (rare). Stick to these three.

   EDGES:
   - \`-->\` for synchronous calls, \`-.-> \` for async / replication,
     \`-- "label" -->\` for labeled edges.
   - One edge per line. NEVER chain: \`A --> B --> C\` should be split into
     two lines: \`A --> B\` then \`B --> C\`.
   - Always whitespace around arrows: \`A --> B\`, never \`A-->B\`.

   Example that parses cleanly:

   \`\`\`mermaid
   graph LR
     Client["Mobile & Web Clients"] --> CDN["CDN (CloudFront)"]
     CDN --> LB["Load Balancer (ALB)"]
     LB --> API1["API Server"]
     LB --> API2["API Server"]
     API1 --> Cache[("Redis Cluster")]
     API2 --> Cache
     API1 --> Queue["Kafka Topic"]
     Queue --> Worker["Async Workers"]
     Worker --> DB[("Postgres Primary")]
     DB -. replication .-> Replica[("Postgres Replica")]
     API1 --> Replica
   \`\`\`

   Keep it to 6-12 nodes — readable over complete. Use real technology
   names (Redis, Kafka, Postgres, S3, CloudFront, Cassandra), not "Database
   Service" or "Caching Layer".

3. **Component walkthrough** — Each major component gets one paragraph
   explaining: what it does, why it's needed at this scale, the specific
   technology choice. Reference the diagram by label.

4. **Trade-offs (opinionated, not generic)** — Pick 2-4 hard design
   decisions and take a position. For each:
   - The choice you made and your specific reasoning
   - The alternative you considered and the concrete reason you rejected it
   - The cost of your choice (what you're giving up)
   Example: "I'd use eventual consistency for the feed (vs strong
   consistency) because read latency dominates user perception, and the
   timeline can tolerate ~500ms staleness. The cost is that a user might
   not see their own post for half a second on the read replica — we
   mitigate that with a 'read your own writes' route via the primary."

5. **Scale evolution (one paragraph)** — At 10x load, what breaks first
   and how do you fix it without rewriting? Cite specific bottlenecks
   from your diagram.

System-design rules:
- Be opinionated. Generic answers ("we'd add caching", "we could shard")
  fail this format. Name the cache (Redis with LRU eviction, 30s TTL),
  the shard key (user_id hashed mod 256), the concrete numbers.
- Don't hedge. The candidate is asserting their design.
- The ABBREVIATION RULE applies throughout — first use of CDN, QPS, LB,
  RPS, etc. gets the expansion in parens.

CODE QUESTIONS — when the interviewer asks for code, follow this exact format:

1. **Approach** — explain the strategy with enough depth that the candidate
   can defend it under follow-up questions. Cover: why this algorithm/data
   structure, the key insight that makes it work, and the main alternative
   you considered and rejected. 3-6 sentences for typical problems; fewer
   only for trivial ones.

2. **Complexity** — Time O(...), Space O(...), with a one-clause "because…"
   so the reasoning is visible.

3. A markdown-fenced code block. The user's selected language is injected
   below this prompt as CODE_LANGUAGE — USE THAT, not Python, unless the
   interviewer's question explicitly forces a different language.

   \`\`\`{{CODE_LANGUAGE}}
   // production-quality, idiomatic, edge cases handled inline
   \`\`\`

4. **Walkthrough** — narrate the code block-by-block. One short paragraph per
   logical section (the setup, the main loop, the return). Reference variable
   names so the reader can follow line-to-line.

Strict formatting rules for the code answer:
- Use **bold labels** ("**Approach**", "**Complexity**", "**Walkthrough**").
  Do NOT use markdown headings (#, ##) — they create big vertical gaps.
- Keep each labeled section to a single paragraph. No empty lines between
  the label and its content; no trailing blank lines.
- The code fence goes on its own block, no surrounding empty lines beyond
  what's natural.
- End the entire answer with the last sentence of the Walkthrough — no
  closing summary, no "Hope this helps", no whitespace.

Code rules:
- Production-quality. Idiomatic for the chosen language. Handle edge cases
  (empty input, None/null, overflow, off-by-one) inline in the code, not
  in prose around it.
- Prefer the optimal solution. If brute force is requested first, give it,
  then add a second \`\`\`language\`\`\` block titled "Optimal" with the better
  approach.
- Comment a line ONLY when the intent isn't obvious from the code. Skip
  comments on trivial lines.

WHEN THE CV DOESN'T COVER THE TOPIC:
- Do NOT say "I haven't worked with that directly" or "I'm not familiar with X."
- Instead, construct a plausible, impressive answer grounded in the candidate's
  general skill set and the job's requirements. Use realistic team sizes, tech
  stacks, and outcomes that fit their stated seniority.
- Do not invent named companies or impossible scale. Use generic placeholders
  ("at my previous startup", "on the platform team I led", "in the last system
  I built") to keep it credible.
- Treat their CV as the floor of their experience, not the ceiling.

OUTPUT FORMAT:
- First-person flowing prose for behavioral and technical answers.
- No markdown headings (#, ##), no bullet lists — interviewers hear answers
  spoken, not formatted documents.
- EXCEPTION: code questions use the format above with markdown code fences
  and **bolded** section labels.`;

  const langInjected = header.replace(/\{\{CODE_LANGUAGE\}\}/g, codeLanguage);

  if (!useWorkspaceContext || !workspace || !workspace.requirements) {
    return `${langInjected}\n\nCODE_LANGUAGE: ${codeLanguage}\n\n${basePrompt || ""}`.trim();
  }

  const req = workspace.requirements;
  const role = req.role || "(unknown)";
  const company = req.company || "(unknown)";
  const required = (req.required || []).slice(0, 12).join(", ");
  const niceTo = (req.nice_to_have || []).slice(0, 8).join(", ");

  // Prefer the tailored variant if present (it's the JD-aligned bullets).
  const cv = workspace.cv_variant?.length
    ? workspace.cv_variant
    : workspace.cv_snapshot;
  const cvText = cv
    .slice(0, 6)
    .map(
      (s) =>
        `## ${s.section}\n${s.bullets.slice(0, 8).map((b) => `- ${b}`).join("\n")}`
    )
    .join("\n\n");

  const workspaceCustom = workspace.interview_system_prompt?.trim();

  return `${langInjected}

CODE_LANGUAGE: ${codeLanguage}

CANDIDATE CONTEXT — answer as if applying for this role:
- Role: ${role} at ${company}
${required ? `- Required skills: ${required}` : ""}
${niceTo ? `- Nice-to-have: ${niceTo}` : ""}

Candidate's CV (the floor of their experience — extrapolate generously when needed):
${cvText}
${
  workspaceCustom
    ? `\nROLE-SPECIFIC NOTES (from the candidate — apply throughout):\n${workspaceCustom}\n`
    : ""
}
${basePrompt ? `Additional instructions:\n${basePrompt}` : ""}`.trim();
}

export function useSystemAudio() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  /** True between "user clicked start" and "Deepgram WS is open + capture
   *  is actually running." Lets the UI show "Starting…" instead of looking
   *  dead during the 0.5-2s init window. */
  const [isInitializing, setIsInitializing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  /** Live Deepgram interim text — shown faded above the input. Cleared on final. */
  const [interimText, setInterimText] = useState<string>("");
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [showQuickActions, setShowQuickActions] = useState<boolean>(true);

  /** Model toggle. Defaults to Sonnet — fast enough + smart enough for most Qs. */
  const [interviewModel, setInterviewModel] = useState<InterviewModel>(
    "claude-sonnet-4-6"
  );
  const [useWorkspaceContext, setUseWorkspaceContext] = useState<boolean>(true);
  /** Speaker id that should be IGNORED (user's own voice when in-room).
   *  null = no filtering. On the mic source we auto-set this to the first
   *  speaker we hear on the assumption that the user starts talking; on
   *  system loopback no filtering is needed (interviewer is the only voice).
   *  User can manually flip via the InterviewControls button. */
  const [ignoreSpeaker, setIgnoreSpeaker] = useState<number | null>(null);
  /** All speaker ids seen so far in this capture — populated from finals
   *  so the UI can offer a button per speaker to flip. */
  const [knownSpeakers, setKnownSpeakers] = useState<number[]>([]);
  /** Audio source: "system" = what's playing through the speakers (the
   *  interviewer's voice on Zoom/Meet/Teams). "mic" = the user's own
   *  microphone — for testing or in-person interviews. Persisted so the
   *  user's choice survives reloads. */
  const [audioSource, setAudioSourceState] = useState<"system" | "mic">(() => {
    const stored = safeLocalStorage.getItem("diligently_audio_source");
    return stored === "mic" ? "mic" : "system";
  });
  const setAudioSource = useCallback((s: "system" | "mic") => {
    setAudioSourceState(s);
    safeLocalStorage.setItem("diligently_audio_source", s);
  }, []);

  /** True only while a mid-capture source swap is happening — used so the
   *  source buttons can show a loader and the UI doesn't flash "stopped." */
  const [isSwappingSource, setIsSwappingSource] = useState(false);

  /** Preferred language for code answers (voice-triggered + screenshot
   *  mode). Defaults to Python since LeetCode/most coding interviews
   *  expect it, but persists the user's choice. */
  const [codeLanguage, setCodeLanguageState] = useState<CodeLanguage>(() => {
    const stored = safeLocalStorage.getItem("diligently_code_language");
    return CODE_LANGUAGES.find((l) => l === stored) ?? "python";
  });
  const setCodeLanguage = useCallback((l: CodeLanguage) => {
    setCodeLanguageState(l);
    safeLocalStorage.setItem("diligently_code_language", l);
  }, []);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  // Context management states
  const [useSystemPrompt, setUseSystemPrompt] = useState<boolean>(true);
  const [contextContent, setContextContent] = useState<string>("");

  const { systemPrompt } = useApp();
  // Refs for the cancel-and-restart machinery. Refs (not state) because:
  //  - the streaming AsyncIterable reads these from inside the loop, and
  //  - React state setters batch / re-render, which would race the stream.
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamStartedAtRef = useRef<number | null>(null);
  const streamTokenCountRef = useRef<number>(0);
  const queuedFollowupRef = useRef<string | null>(null);

  // Settle window
  const settleTimerRef = useRef<number | null>(null);
  const pendingFinalsRef = useRef<string[]>([]);

  /** Backend interview row id for the active capture session. */
  const interviewIdRef = useRef<string | null>(null);
  /** Captured wav path from the Rust `capture-finished` event. Used by the
   *  async R2 upload that fires after stopCapture. */
  const lastWavPathRef = useRef<string | null>(null);

  // Load context settings + quick actions on mount
  useEffect(() => {
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPrompt(parsed.useSystemPrompt ?? true);
        setContextContent(parsed.contextContent ?? "");
      } catch (error) {
        console.error("Failed to load system audio context:", error);
      }
    }

    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        setQuickActions(JSON.parse(savedActions));
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // ===========================================================================
  // Settle + cancel state machine
  // ===========================================================================

  /** Append messages to the conversation in chronological order (newest last in
   *  the array we ship to the LLM as history; the UI reverses for display). */
  const appendConversationTurn = useCallback(
    (userText: string, aiText: string) => {
      setConversation((prev) => ({
        ...prev,
        messages: [
          {
            id: `msg_${Date.now()}_user`,
            role: "user" as const,
            content: userText,
            timestamp: Date.now(),
          },
          {
            id: `msg_${Date.now()}_assistant`,
            role: "assistant" as const,
            content: aiText,
            timestamp: Date.now(),
          },
          ...prev.messages,
        ],
        updatedAt: Date.now(),
        title: prev.title || generateConversationTitle(userText),
      }));
    },
    []
  );

  const runLLM = useCallback(
    async (userMessage: string) => {
      // Cancel any prior in-flight stream (defensive — caller usually already
      // aborted before calling us).
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamStartedAtRef.current = Date.now();
      streamTokenCountRef.current = 0;

      const basePrompt = useSystemPrompt
        ? systemPrompt || DEFAULT_SYSTEM_PROMPT
        : contextContent || DEFAULT_SYSTEM_PROMPT;
      const composedPrompt = buildInterviewPrompt(
        basePrompt,
        activeWorkspace(),
        useWorkspaceContext,
        codeLanguage
      );

      // Conversation history — ChatMessage[] is newest-first in state; the
      // LLM expects oldest-first, so reverse + map.
      const history: Message[] = conversation.messages
        .slice()
        .reverse()
        .map((m) => ({ role: m.role as Message["role"], content: m.content }));

      setIsAIProcessing(true);
      setLastTranscription(userMessage);
      setLastAIResponse("");
      setError("");

      // Fire-and-forget the audit event for this turn.
      const ivId = interviewIdRef.current;
      if (ivId) {
        fireAndForget(
          "event interview_question",
          appendEvent({
            kind: "interview_question",
            payload: { interview_id: ivId, question: userMessage, model: interviewModel },
          })
        );
      }

      // Classify the question and nudge Sonnet to use the right format.
      // System design is the priority check — "design X" can also look like
      // a coding question to the regex, but design wins.
      const designQuestion = suggestsSystemDesign(userMessage);
      const codeQuestion = !designQuestion && suggestsCodeMode(userMessage);

      // Force at least Sonnet for code / design (Haiku is overridden).
      const effectiveModel: InterviewModel =
        codeQuestion || designQuestion
          ? interviewModel === "claude-opus-4-7"
            ? "claude-opus-4-7"
            : "claude-sonnet-4-6"
          : interviewModel;

      let effectiveUserMessage = userMessage;
      if (designQuestion) {
        effectiveUserMessage = `${userMessage}\n\n(This is a system-design question — respond using the SYSTEM-DESIGN QUESTIONS format from your instructions, including a Mermaid architecture diagram in a \`\`\`mermaid fenced block.)`;
      } else if (codeQuestion) {
        effectiveUserMessage = `${userMessage}\n\n(This is a coding question — respond using the CODE QUESTIONS format from your instructions, with a markdown-fenced code block.)`;
      }

      let fullResponse = "";
      try {
        for await (const chunk of fetchInterviewResponse({
          model: effectiveModel,
          systemPrompt: composedPrompt,
          history,
          userMessage: effectiveUserMessage,
        })) {
          if (controller.signal.aborted) break;
          fullResponse += chunk;
          streamTokenCountRef.current += 1;
          setLastAIResponse((prev) => prev + chunk);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsAIProcessing(false);
        streamStartedAtRef.current = null;
      }

      // Persist the turn IF it actually produced output (skipped if aborted
      // before any tokens).
      if (!controller.signal.aborted && fullResponse) {
        appendConversationTurn(userMessage, fullResponse);

        if (ivId) {
          fireAndForget(
            "event interview_answer",
            appendEvent({
              kind: "interview_answer",
              payload: {
                interview_id: ivId,
                answer_chars: fullResponse.length,
                model: interviewModel,
              },
            })
          );
        }
      }

      // Stream ended naturally — check for a queued follow-up.
      if (!controller.signal.aborted && queuedFollowupRef.current) {
        const next = queuedFollowupRef.current;
        queuedFollowupRef.current = null;
        // Defer to next tick so React state updates flush first.
        setTimeout(() => runLLM(next), 0);
      }
    },
    [
      appendConversationTurn,
      contextContent,
      conversation.messages,
      interviewModel,
      codeLanguage,
      systemPrompt,
      useSystemPrompt,
      useWorkspaceContext,
    ]
  );

  /** Settle timer callback — merge accumulated finals and fire the LLM. */
  const fireSettledFinals = useCallback(() => {
    settleTimerRef.current = null;
    const merged = pendingFinalsRef.current.join(" ").trim();
    pendingFinalsRef.current = [];
    if (!merged) return;
    runLLM(merged);
  }, [runLLM]);

  /** Called for every transcript-final from Deepgram. Implements the
   *  filler-drop + idle-settle + streaming-windowed-cancel logic.
   *  Speaker filtering applies before any of that — utterances from the
   *  configured `ignoreSpeaker` are dropped silently. */
  const onFinalTranscript = useCallback(
    (text: string, speaker: number | null | undefined) => {
      // Track every speaker we see so the UI can offer them as toggle options.
      if (typeof speaker === "number") {
        setKnownSpeakers((cur) =>
          cur.includes(speaker) ? cur : [...cur, speaker].sort((a, b) => a - b)
        );
        if (speaker === ignoreSpeaker) {
          // User's own voice on the mic path — drop silently.
          setInterimText("");
          return;
        }
      }

      const trimmed = text.trim();
      if (!trimmed) return;
      if (isFiller(trimmed)) {
        // Visible-but-low-priority signal that we heard it and dropped.
        setInterimText("");
        return;
      }
      setInterimText("");

      const isStreaming = abortControllerRef.current !== null;

      if (!isStreaming) {
        // Idle: accumulate + (re)start settle timer.
        pendingFinalsRef.current.push(trimmed);
        if (settleTimerRef.current !== null) {
          window.clearTimeout(settleTimerRef.current);
        }
        settleTimerRef.current = window.setTimeout(
          fireSettledFinals,
          SETTLE_MS
        );
        return;
      }

      // Streaming: decide between interrupt and queue.
      const startedAt = streamStartedAtRef.current ?? Date.now();
      const elapsed = Date.now() - startedAt;
      const tokens = streamTokenCountRef.current;

      if (
        elapsed < STREAM_CANCEL_WINDOW_MS &&
        tokens < STREAM_CANCEL_TOKEN_THRESHOLD
      ) {
        // Interrupt: cancel + restart with merged text.
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        pendingFinalsRef.current = [trimmed];
        if (settleTimerRef.current !== null) {
          window.clearTimeout(settleTimerRef.current);
        }
        settleTimerRef.current = window.setTimeout(
          fireSettledFinals,
          SETTLE_MS
        );
      } else {
        // Late in the stream: queue as follow-up.
        queuedFollowupRef.current = queuedFollowupRef.current
          ? `${queuedFollowupRef.current} ${trimmed}`
          : trimmed;
      }
    },
    [fireSettledFinals, ignoreSpeaker]
  );

  // ===========================================================================
  // Tauri event listeners
  // ===========================================================================

  useEffect(() => {
    let unInterim: (() => void) | undefined;
    let unFinal: (() => void) | undefined;
    let unFinished: (() => void) | undefined;
    let unError: (() => void) | undefined;

    (async () => {
      unInterim = await listen<TranscriptInterimPayload>(
        "transcript-interim",
        (event) => {
          if (!capturing) return;
          setInterimText(event.payload.text);
        }
      );
      unFinal = await listen<TranscriptFinalPayload>(
        "transcript-final",
        (event) => {
          if (!capturing) return;
          onFinalTranscript(event.payload.text, event.payload.speaker ?? null);

          // Crash-safe transcript persistence: each final goes straight to
          // the backend timeline so a crash mid-interview doesn't lose Qs.
          const ivId = interviewIdRef.current;
          if (ivId && event.payload.text.trim()) {
            fireAndForget(
              "event transcript_segment",
              appendEvent({
                kind: "transcript_segment",
                payload: {
                  interview_id: ivId,
                  text: event.payload.text,
                  start: event.payload.start,
                  duration: event.payload.duration,
                },
              })
            );
          }
        }
      );
      unFinished = await listen<CaptureFinishedPayload>(
        "capture-finished",
        (event) => {
          lastWavPathRef.current = event.payload.wav_path;
        }
      );
      unError = await listen<{ message: string }>(
        "transcript-error",
        (event) => {
          // Don't block capture on Deepgram outages — show the user but keep
          // recording locally so audio is preserved.
          console.warn("[transcript]", event.payload.message);
          setError(`Live transcription degraded: ${event.payload.message}`);
        }
      );
    })();

    return () => {
      unInterim?.();
      unFinal?.();
      unFinished?.();
      unError?.();
    };
  }, [capturing, onFinalTranscript]);

  // ===========================================================================
  // Context settings persistence
  // ===========================================================================
  const saveContextSettings = useCallback(
    (usePrompt: boolean, content: string) => {
      try {
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
          JSON.stringify({ useSystemPrompt: usePrompt, contextContent: content })
        );
      } catch (error) {
        console.error("Failed to save context settings:", error);
      }
    },
    []
  );

  const updateUseSystemPrompt = useCallback(
    (value: boolean) => {
      setUseSystemPrompt(value);
      saveContextSettings(value, contextContent);
    },
    [contextContent, saveContextSettings]
  );

  const updateContextContent = useCallback(
    (content: string) => {
      setContextContent(content);
      saveContextSettings(useSystemPrompt, content);
    },
    [useSystemPrompt, saveContextSettings]
  );

  // ===========================================================================
  // Quick actions
  // ===========================================================================
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  const handleQuickActionClick = useCallback(
    async (action: string) => {
      // Quick actions bypass the settle window — fire immediately.
      if (abortControllerRef.current) abortControllerRef.current.abort();
      pendingFinalsRef.current = [];
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      await runLLM(action);
    },
    [runLLM]
  );

  /** Public — used by the chat input + screenshot-code mode. */
  const processWithAI = useCallback(
    async (userMessage: string, _prompt?: string, _history?: Message[]) => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      await runLLM(userMessage);
    },
    [runLLM]
  );

  /**
   * Code-from-screenshot helper.
   *
   * Captures the primary monitor, sends to Claude (always Sonnet for code —
   * we don't honor the speed-priority Haiku toggle here because correctness
   * matters more than TTFT on code). Runs the same conversation-append flow
   * as a voice question so the answer joins the live transcript history.
   */
  const captureAndAnalyzeScreen = useCallback(
    async (userInstruction?: string) => {
      const instruction =
        userInstruction?.trim() ||
        "Solve the coding problem visible on screen. Use the CODE QUESTIONS format from your instructions: a properly-explained Approach (3-6 sentences with the key insight and rejected alternative), Complexity with a 'because…' clause, the code in a markdown-fenced block with language tag, and a Walkthrough that narrates the code block-by-block. Don't truncate the Approach to be brief — depth matters more than length here.";

      try {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        streamStartedAtRef.current = Date.now();
        streamTokenCountRef.current = 0;

        setIsAIProcessing(true);
        setLastTranscription(instruction);
        setLastAIResponse("");
        setError("");

        // Rust-side capture returns a compressed JPEG sized to stay under
        // Anthropic's 5 MB encoded cap. We retry on transient categories
        // (monitor enum hiccup, DXGI-style capture failure) because those
        // routinely succeed on the next try after a display state change.
        // Permanent categories (NoPrimaryMonitor / CannotCompress) abort.
        const TRANSIENT_PREFIXES = ["MonitorEnum:", "CaptureFailed:", "EmptyImage"];
        const BACKOFF_MS = [500, 1000, 2000];
        let jpegB64: string | null = null;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
          try {
            jpegB64 = await invoke<string>("capture_to_base64");
            break;
          } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const transient = TRANSIENT_PREFIXES.some((p) => msg.startsWith(p));
            if (!transient || attempt === BACKOFF_MS.length) throw err;
            console.warn(
              `[capture] attempt ${attempt + 1} failed (${msg.split(":")[0]}), retrying in ${BACKOFF_MS[attempt]}ms`
            );
            await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
          }
        }
        if (!jpegB64) throw lastErr ?? new Error("capture_to_base64 returned empty");

        const ivId = interviewIdRef.current;
        if (ivId) {
          fireAndForget(
            "event interview_code_screenshot",
            appendEvent({
              kind: "interview_code_screenshot",
              payload: { interview_id: ivId, instruction },
            })
          );
        }

        const codeSystemPrompt = `You are helping the candidate solve a coding problem shown in the screenshot.
Speak as them — first person, like they're whiteboarding the solution aloud.

USE LANGUAGE: ${codeLanguage}
This is the language the candidate has selected. Use it for the code block
unless the screenshot makes a different language unambiguous (e.g., a
TypeScript file is visible, or the prompt says "in Java").

Output exactly four labeled sections, using **bold labels** (not # headings),
with no empty lines between a label and its content and no trailing whitespace:

1. **Approach** — Explain the strategy with enough depth to defend under
   follow-up questions. Cover why this algorithm/data structure, the key
   insight that makes it work, and the main alternative you rejected.
   3-6 sentences for typical problems; fewer only for trivial ones.

2. **Complexity** — Time O(...), Space O(...), with a one-clause "because…".

3. A single markdown-fenced code block with the language tag matching
   USE LANGUAGE above:
   \`\`\`${codeLanguage}
   // production-quality, idiomatic, edge cases handled inline
   \`\`\`
   Production-quality, idiomatic, handles edge cases (empty, null, overflow,
   off-by-one) inline. Comment only where the logic isn't obvious from the code.

4. **Walkthrough** — Narrate the code block-by-block. One short paragraph per
   logical section (setup → main loop → return). Reference variable names
   so the reader can follow line-by-line.

ABBREVIATION RULE: any acronym in your Approach or Walkthrough (e.g., API,
DFS, BFS, DP, LRU, LFU) MUST be followed by its full expansion in parens
the first time it appears in this response. After that, the bare form is fine.

End the answer with the last sentence of the Walkthrough — no closing
summary, no "Hope this helps", no trailing blank lines.`;

        const history: Message[] = conversation.messages
          .slice()
          .reverse()
          .map((m) => ({ role: m.role as Message["role"], content: m.content }));

        let fullResponse = "";
        for await (const chunk of fetchInterviewResponse({
          // Always Sonnet for code — Haiku is too risky on correctness.
          model:
            interviewModel === "claude-opus-4-7"
              ? "claude-opus-4-7"
              : "claude-sonnet-4-6",
          systemPrompt: codeSystemPrompt,
          history,
          userMessage: instruction,
          imagesBase64: [jpegB64],
        })) {
          if (controller.signal.aborted) break;
          fullResponse += chunk;
          streamTokenCountRef.current += 1;
          setLastAIResponse((prev) => prev + chunk);
        }

        if (!controller.signal.aborted && fullResponse) {
          appendConversationTurn(instruction, fullResponse);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (abortControllerRef.current) {
          abortControllerRef.current = null;
        }
        setIsAIProcessing(false);
        streamStartedAtRef.current = null;
      }
    },
    [appendConversationTurn, codeLanguage, conversation.messages, interviewModel]
  );

  // ===========================================================================
  // Capture lifecycle
  // ===========================================================================

  const startCapture = useCallback(async () => {
    // Re-entrancy guard: if another start is mid-flight, ignore this click.
    if (isInitializing || capturing) return;
    try {
      setError("");
      setInterimText("");
      pendingFinalsRef.current = [];
      queuedFollowupRef.current = null;
      lastWavPathRef.current = null;
      setKnownSpeakers([]);
      setIgnoreSpeaker(null);
      // Open the popover IMMEDIATELY so the user sees "Starting…" feedback.
      setIsInitializing(true);
      setIsPopoverOpen(true);

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        return;
      }

      await invoke<string>("stop_system_audio_capture").catch(() => {});
      await invoke<string>("start_system_audio_capture", { source: audioSource });
      setCapturing(true);

      const conversationId = `sysaudio_conv_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      setConversation({
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      });

      const ws = activeWorkspace();
      try {
        const iv = await startInterview({
          application_id: ws?.backend_application_id ?? null,
        });
        interviewIdRef.current = iv.id;
        fireAndForget(
          "event interview_started",
          appendEvent({
            kind: "interview_started",
            payload: {
              interview_id: iv.id,
              local_conversation_id: conversationId,
              model: interviewModel,
              workspace_id: ws?.id,
            },
          })
        );
      } catch (err) {
        console.warn(
          "[backend] startInterview failed; capture continues local-only:",
          err
        );
        interviewIdRef.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInitializing(false);
    }
  }, [audioSource, capturing, interviewModel, isInitializing]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any in-flight LLM stream.
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      pendingFinalsRef.current = [];
      queuedFollowupRef.current = null;

      setCapturing(false);
      setIsAIProcessing(false);
      setInterimText("");

      await invoke<string>("stop_system_audio_capture");

      // Flush the interview row to backend.
      const ivId = interviewIdRef.current;
      const wavPath = lastWavPathRef.current;
      if (ivId) {
        const transcript = conversation.messages
          .filter((m) => m.role === "user")
          .map((m) => ({
            ts: new Date(m.timestamp).toISOString(),
            kind: "final" as const,
            text: m.content,
          }));
        const ai_messages = conversation.messages
          .filter((m) => m.role === "assistant")
          .map((m) => ({
            ts: new Date(m.timestamp).toISOString(),
            text: m.content,
          }));

        try {
          await endInterview(ivId, { transcript, ai_messages });
        } catch (err) {
          console.warn("[backend] endInterview failed:", err);
        }
        fireAndForget(
          "event interview_ended",
          appendEvent({
            kind: "interview_ended",
            payload: {
              interview_id: ivId,
              transcript_segments: transcript.length,
              ai_message_count: ai_messages.length,
              wav_path: wavPath,
            },
          })
        );

        // Async audio upload chain. Lives in its own IIFE so it never
        // blocks the UI — the user sees the popover close and the
        // conversation stay visible; the upload finishes in the
        // background. The Rust upload command streams bytes directly
        // from disk to R2 (no JS memory pressure).
        if (wavPath) {
          fireAndForget(
            "upload interview audio",
            (async () => {
              const key = `interviews/${ivId}.wav`;
              const presigned = await presignUpload(key, "audio/wav", 3600);
              const bytes = await invoke<number>(
                "upload_audio_file_to_url",
                { wavPath, putUrl: presigned.url }
              );
              await endInterview(ivId, { r2_audio_key: presigned.key });
              fireAndForget(
                "event interview_audio_uploaded",
                appendEvent({
                  kind: "interview_audio_uploaded",
                  payload: {
                    interview_id: ivId,
                    r2_audio_key: presigned.key,
                    bytes,
                  },
                })
              );
            })()
          );
        }

        interviewIdRef.current = null;
      }

      // Clean state reset — no full-page reload. The conversation stays
      // visible until the user explicitly starts a new one.
      lastWavPathRef.current = null;
      setLastTranscription("");
      setLastAIResponse("");
      setInterimText("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversation.messages]);

  /**
   * Hot-swap the audio source mid-capture. Stops the Rust audio task, opens
   * a fresh one on the new source, and persists the choice — without
   * touching the active interview row, conversation, or backend audit log.
   *
   * The Rust capture task is bound to whatever source it opened with, so
   * we have to cycle it. Diarization state (knownSpeakers / ignoreSpeaker)
   * resets because Deepgram's speaker IDs aren't stable across sessions.
   */
  const swapAudioSource = useCallback(
    async (next: "system" | "mic") => {
      if (next === audioSource) return;
      // Idle case: just flip the toggle, persist, no Rust call needed.
      if (!capturing) {
        setAudioSource(next);
        return;
      }
      if (isSwappingSource) return; // re-entrancy guard

      setIsSwappingSource(true);
      try {
        // Cancel any in-flight LLM stream — the speaker that was talking
        // probably won't keep going through the swap.
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        if (settleTimerRef.current !== null) {
          window.clearTimeout(settleTimerRef.current);
          settleTimerRef.current = null;
        }
        pendingFinalsRef.current = [];
        queuedFollowupRef.current = null;
        setInterimText("");
        // Diarization speaker IDs are per-session — reset so the new
        // session doesn't inherit stale "ignore speaker 0" filters.
        setKnownSpeakers([]);
        setIgnoreSpeaker(null);

        await invoke<string>("stop_system_audio_capture").catch(() => {});
        setAudioSource(next);
        await invoke<string>("start_system_audio_capture", { source: next });
        // Capture stays true throughout — UI never shows "stopped."
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSwappingSource(false);
      }
    },
    [audioSource, capturing, isSwappingSource, setAudioSource]
  );

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  // Open the popover whenever there's relevant state.
  useEffect(() => {
    const shouldOpenPopover =
      capturing ||
      isInitializing ||
      setupRequired ||
      isAIProcessing ||
      !!lastAIResponse ||
      !!error ||
      !!interimText;
    setIsPopoverOpen(shouldOpenPopover);
    resizeWindow(shouldOpenPopover);
  }, [
    capturing,
    isInitializing,
    setupRequired,
    isAIProcessing,
    lastAIResponse,
    error,
    interimText,
    resizeWindow,
  ]);

  // Wire global shortcut
  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturing) {
        await stopCapture();
      } else {
        await startCapture();
      }
    });
  }, [startCapture, stopCapture]);

  // Tear down on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  useEffect(() => {
    saveConversation(conversation);
  }, [conversation.messages.length, conversation.title, conversation.id]);

  /**
   * Export the current conversation to a Markdown file. Includes workspace
   * metadata (role/company) when present so post-interview review has the
   * context. Downloads via the browser's anchor trick — no Tauri dialog
   * plugin needed.
   */
  const exportConversation = useCallback(() => {
    const ws = activeWorkspace();
    const lines: string[] = [];

    const heading = ws?.requirements?.role
      ? `# Interview — ${ws.requirements.role}${
          ws.requirements.company ? ` @ ${ws.requirements.company}` : ""
        }`
      : "# Interview";
    lines.push(heading);
    lines.push("");
    lines.push(
      `_Session ${conversation.id || "(local)"} · ${new Date().toLocaleString()}_`
    );
    if (interviewIdRef.current) {
      lines.push(`_Backend interview id: \`${interviewIdRef.current}\`_`);
    }
    lines.push("");

    if (ws?.requirements) {
      lines.push("## Role context");
      const req = ws.requirements;
      if (req.required?.length)
        lines.push(`- **Required:** ${req.required.join(", ")}`);
      if (req.nice_to_have?.length)
        lines.push(`- **Nice-to-have:** ${req.nice_to_have.join(", ")}`);
      lines.push("");
    }

    lines.push("## Transcript");
    lines.push("");
    // conversation.messages is newest-first; iterate reversed so the
    // exported transcript reads chronologically.
    const chronological = conversation.messages.slice().reverse();
    for (const m of chronological) {
      if (m.role === "user") {
        lines.push(`### Q: ${m.content}`);
      } else if (m.role === "assistant") {
        lines.push("");
        lines.push(m.content);
        lines.push("");
      }
    }

    const md = lines.join("\n");
    const filename = `interview-${
      ws?.requirements?.role?.replace(/[^a-zA-Z0-9]+/g, "-") || "session"
    }-${new Date().toISOString().slice(0, 10)}.md`;

    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [conversation]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: `sysaudio_conv_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`,
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setLastAIResponse("");
    setInterimText("");
    setError("");
    setSetupRequired(false);
    setIsAIProcessing(false);
    setIsPopoverOpen(false);
    setUseSystemPrompt(true);
  }, []);

  return {
    capturing,
    isInitializing,
    isProcessing: false, // legacy field — batch-STT is gone
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    /** Live (non-final) transcript hypothesis from Deepgram. Render faded. */
    interimText,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    // Conversation
    conversation,
    setConversation,
    // AI surface
    processWithAI,
    // Context controls
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    /** Workspace context auto-injection toggle. */
    useWorkspaceContext,
    setUseWorkspaceContext,
    /** Live model selector (Sonnet / Haiku / Opus). */
    interviewModel,
    setInterviewModel,
    /** Audio source: "system" (default — interviewer on Zoom) or "mic"
     *  (user's own voice, for testing or in-person). */
    audioSource,
    setAudioSource,
    /** Hot-swap mic ↔ system mid-capture. Stops + restarts the Rust audio
     *  task on the new source without ending the interview row. */
    swapAudioSource,
    /** True only during the ~100ms restart window of swapAudioSource. */
    isSwappingSource,
    /** Diarization controls — drop a specific speaker (the user's own voice
     *  on the in-person mic path). */
    ignoreSpeaker,
    setIgnoreSpeaker,
    knownSpeakers,
    /** Preferred language for code answers. */
    codeLanguage,
    setCodeLanguage,
    startNewConversation,
    // Window
    resizeWindow,
    // Quick actions
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    /** Screen-capture → Claude vision (Sonnet) for code interview questions. */
    captureAndAnalyzeScreen,
    /** Export the current Q&A history to a downloadable Markdown file. */
    exportConversation,
  };
}
