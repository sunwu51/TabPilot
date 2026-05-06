import { MAX_LLM_STREAM_RETRIES } from "./constants";
import { API_TYPES, normalizeApiType } from "./config";
import { delayRetry, normalizeLlmStreamError } from "./shared";
import { streamAnthropicAttempt } from "./anthropic";
import { streamOpenAIAttempt } from "./openai-chat-completions";
import { streamOpenAIResponsesAttempt } from "./openai-responses";


export function streamChat(config, messages, { onText, onDone, onError, onRetry }, mcpTools = [], options = {}) {
  const controller = new AbortController();

  void streamWithRetry(config, messages, controller.signal, { onText, onDone, onError, onRetry }, mcpTools, options);

  return () => controller.abort();
}

async function streamWithRetry(config, messages, signal, callbacks, mcpTools = [], options = {}) {
  const failures = [];

  for (let attempt = 1; attempt <= MAX_LLM_STREAM_RETRIES; attempt++) {
    if (signal.aborted) return;

    try {
      const apiType = normalizeApiType(config.apiType);
      if (apiType === API_TYPES.ANTHROPIC) {
        await streamAnthropicAttempt(config, messages, signal, callbacks, mcpTools, options);
      } else if (apiType === API_TYPES.OPENAI_RESPONSES) {
        await streamOpenAIResponsesAttempt(config, messages, signal, callbacks, mcpTools, options);
      } else {
        await streamOpenAIAttempt(config, messages, signal, callbacks, mcpTools, options);
      }
      return;
    } catch (error) {
      if (error?.name === "AbortError" && signal.aborted) return;

      const normalizedError = normalizeLlmStreamError(error, {
        apiType: config.apiType,
        attempt,
        maxAttempts: MAX_LLM_STREAM_RETRIES
      });

      failures.push({
        attempt,
        code: normalizedError.code || "LLM_ERROR",
        message: normalizedError.message || "LLM request failed",
        status: normalizedError.status || null,
        detail: normalizedError.detail || null
      });

      if (attempt < MAX_LLM_STREAM_RETRIES) {
        callbacks.onRetry?.({
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: MAX_LLM_STREAM_RETRIES,
          error: normalizedError
        });
        try {
          await delayRetry(attempt, signal);
        } catch (retryError) {
          if (retryError?.name === "AbortError") return;
          throw retryError;
        }
        continue;
      }

      normalizedError.attempts = attempt;
      normalizedError.maxAttempts = MAX_LLM_STREAM_RETRIES;
      normalizedError.failures = failures;
      callbacks.onError?.(normalizedError);
      return;
    }
  }
}
