import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import curl2Json from "@bany/curl-to-json";
import { shouldUseManagedApi } from "./managed-api";
import { devLog } from "./dev-log.function";

// Managed-API streaming path (Rust `chat_stream` Tauri command).
async function* fetchManagedAIResponse(params: {
  systemPrompt?: string;
  userMessage: string;
  imagesBase64?: string[];
  history?: Message[];
}): AsyncIterable<string> {
  try {
    const {
      systemPrompt,
      userMessage,
      imagesBase64 = [],
      history = [],
    } = params;

    // Convert history to the expected format
    let historyString: string | undefined;
    if (history.length > 0) {
      const formattedHistory = history?.reverse()?.map((msg) => ({
        role: msg.role,
        content: [{ type: "text", text: msg.content }],
      }));
      historyString = JSON.stringify(formattedHistory);
    }

    // Handle images - can be string or array
    let imageBase64: string | string[] | undefined;
    if (imagesBase64.length > 0) {
      imageBase64 = imagesBase64.length === 1 ? imagesBase64[0] : imagesBase64;
    }

    // Set up streaming event listener
    let streamComplete = false;
    const streamChunks: string[] = [];

    const unlisten = await listen("chat_stream_chunk", (event) => {
      const chunk = event.payload as string;
      streamChunks.push(chunk);
    });

    const unlistenComplete = await listen("chat_stream_complete", () => {
      streamComplete = true;
    });

    try {
      // Start the streaming request
      await invoke("chat_stream", {
        userMessage,
        systemPrompt,
        imageBase64,
        history: historyString,
      });

      // Yield chunks as they come in
      let lastIndex = 0;
      while (!streamComplete) {
        // Wait a bit for chunks to accumulate
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Yield any new chunks
        for (let i = lastIndex; i < streamChunks.length; i++) {
          yield streamChunks[i];
        }
        lastIndex = streamChunks.length;
      }

      // Yield any remaining chunks
      for (let i = lastIndex; i < streamChunks.length; i++) {
        yield streamChunks[i];
      }
    } finally {
      unlisten();
      unlistenComplete();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    yield `Managed API error: ${errorMessage}`;
  }
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  /** Shallow-merged into the request body after variable substitution.
   *  Use for per-call tuning like raising max_tokens above the curl-template
   *  default. Useful for CV/JD-parsing tasks that produce long structured
   *  output and were getting truncated at the template's 4096 cap. */
  bodyOverrides?: Record<string, unknown>;
  /** Keys to delete from the request body. Use for stripping params like
   *  "thinking" and "reasoning_effort" on the DeepSeek template for tasks
   *  that don't benefit from reasoning (schema-following CV/job parsing),
   *  saving 10-30s of latency per call. */
  bodyOmit?: string[];
  /** Short label for log lines so calls are greppable. Defaults to "call". */
  logLabel?: string;
}): AsyncIterable<string> {
  // Hoisted for the finally block so the end log always fires even on errors.
  const label = params.logLabel ?? "call";
  const startedAt = performance.now();
  let totalChars = 0;
  const providerLabel = params.selectedProvider?.provider ?? "?";
  let modelInUse = "?";
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
    } = params;

    // Managed-API short-circuits to the Rust streaming path.
    const useManagedApi = await shouldUseManagedApi();
    if (useManagedApi) {
      yield* fetchManagedAIResponse({
        systemPrompt,
        userMessage,
        imagesBase64,
        history,
      });
      return;
    }
    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const effectiveVariables: Record<string, string> = {
      ...(selectedProvider.variables || {}),
    };

    // First-class providers whose key/model the Rust side will auto-fill from
    // the .env when the Settings popover leaves them blank. Keep this list in
    // sync with get_llm_api_key_for_provider in src-tauri/src/api.rs.
    const envAutofillProviders = new Set(["openai", "deepseek", "claude"]);
    const isEnvAutofillProvider = envAutofillProviders.has(
      selectedProvider.provider
    );

    if (
      isEnvAutofillProvider &&
      (!effectiveVariables.api_key || effectiveVariables.api_key.trim() === "")
    ) {
      try {
        const envApiKey = await invoke<string | null>("get_ai_provider_api_key", {
          providerId: selectedProvider.provider,
        });
        if (envApiKey && envApiKey.trim()) {
          effectiveVariables.api_key = envApiKey;
        }
      } catch {
        // Ignore env lookup failure and keep existing validation below.
      }
    }

    if (
      isEnvAutofillProvider &&
      (!effectiveVariables.model || effectiveVariables.model.trim() === "")
    ) {
      try {
        const envModel = await invoke<string | null>(
          "get_ai_provider_default_model",
          {
            providerId: selectedProvider.provider,
          }
        );
        if (envModel && envModel.trim()) {
          effectiveVariables.model = envModel;
        }
      } catch {
        // Ignore env lookup failure and keep existing validation below.
      }
    }

    // Now that the model is resolved, log the start of the call so timing
    // and provider/model selection are visible. devLog mirrors to both
    // browser devtools AND the cargo terminal — without that bridge JS
    // logs are invisible to anyone watching `npm run tauri dev`.
    modelInUse = effectiveVariables.model ?? "?";
    devLog(
      `[ai] ${label} → ${providerLabel}(${modelInUse}) | input=${userMessage.length}c, history=${history.length}, images=${imagesBase64.length}`
    );

    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (
        !effectiveVariables?.[key] ||
        effectiveVariables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(effectiveVariables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: systemPrompt || "",
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);

    // Per-call body customization. bodyOmit removes template defaults that
    // hurt for this call (e.g. DeepSeek's "thinking" + "reasoning_effort"
    // on schema-following CV/JD ops); bodyOverrides bumps fields like
    // max_tokens above the template default for long structured output.
    if (
      params.bodyOmit?.length &&
      typeof bodyObj === "object" &&
      bodyObj !== null
    ) {
      for (const key of params.bodyOmit) {
        delete (bodyObj as Record<string, unknown>)[key];
      }
    }
    if (
      params.bodyOverrides &&
      typeof bodyObj === "object" &&
      bodyObj !== null
    ) {
      bodyObj = { ...(bodyObj as object), ...params.bodyOverrides };
    }

    let url = deepVariableReplacer(curlJson.url || "", allVariables);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    let response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
      });
    } catch (fetchError) {
      yield `Network error during API request: ${
        fetchError instanceof Error ? fetchError.message : "Unknown error"
      }`;
      return;
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      yield `API request failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`;
      return;
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        yield `Failed to parse non-streaming response: ${
          parseError instanceof Error ? parseError.message : "Unknown error"
        }`;
        return;
      }
      const content =
        getByPath(json, provider?.responseContentPath || "") || "";
      totalChars += content.length;
      yield content;
      return;
    }

    if (!response.body) {
      yield "Streaming not supported or response body missing";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        yield `Error reading stream: ${
          readError instanceof Error ? readError.message : "Unknown error"
        }`;
        return;
      }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed);
            const delta = getStreamingContent(
              parsed,
              provider?.responseContentPath || ""
            );
            if (delta) {
              totalChars += delta.length;
              yield delta;
            }
          } catch (e) {
            // Ignore parsing errors for partial JSON chunks
          }
        }
      }
    }
  } catch (error) {
    throw new Error(
      `Error in fetchAIResponse: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  } finally {
    // End log fires on success, error, AND early-break by the caller
    // (for-await-of cleanup runs the generator's finally). This is the
    // single source of truth for "how long did that LLM call take and how
    // much did it produce" — invaluable for diagnosing slow/truncated runs.
    const elapsedMs = Math.round(performance.now() - startedAt);
    devLog(
      `[ai] ${label} ← ${totalChars}c / ${elapsedMs}ms / ${providerLabel}(${modelInUse})`
    );
  }
}
