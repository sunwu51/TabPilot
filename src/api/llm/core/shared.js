import { DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS } from "./constants";

export function mergeUsage(current = {}, next) {
  if (!next || typeof next !== "object") return current || null;
  return { ...(current || {}), ...next };
}

export function getFirstPacketTimeoutMs(config) {
  return Math.max(1, Number(config?.firstPacketTimeoutSeconds) || DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS) * 1000;
}

export function createFirstPacketTimeoutState(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let firstPacketReceived = false;
  let didTimeout = false;

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    get firstPacketReceived() {
      return firstPacketReceived;
    },
    get didTimeout() {
      return didTimeout;
    },
    markFirstPacketReceived() {
      if (firstPacketReceived) return;
      firstPacketReceived = true;
      clearTimeout(timeoutId);
    },
    cleanup() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener?.("abort", abortFromParent);
    }
  };
}

export function buildFirstPacketTimeoutError(config) {
  const timeoutSeconds = Math.max(1, Number(config?.firstPacketTimeoutSeconds) || DEFAULT_LLM_FIRST_PACKET_TIMEOUT_SECONDS);
  return createLlmStreamError({
    code: "FIRST_PACKET_TIMEOUT",
    message: `首包超时，${timeoutSeconds} 秒内未收到响应`,
    detail: { timeoutSeconds }
  });
}

export function createLlmStreamError({ code, message, status, detail }) {
  const error = new Error(message || "LLM request failed");
  error.code = code || "LLM_ERROR";
  if (status != null) error.status = status;
  if (detail != null) error.detail = detail;
  return error;
}

export function normalizeLlmStreamError(error, { apiType, attempt, maxAttempts }) {
  if (error?.code) {
    error.apiType = apiType;
    error.attempt = attempt;
    error.maxAttempts = maxAttempts;
    return error;
  }

  const normalized = createLlmStreamError({
    code: inferLlmErrorCode(error),
    message: error?.message || "LLM 请求失败",
    detail: error?.stack || String(error)
  });
  normalized.apiType = apiType;
  normalized.attempt = attempt;
  normalized.maxAttempts = maxAttempts;
  return normalized;
}

function inferLlmErrorCode(error) {
  if (isAbortError(error)) return "REQUEST_ABORTED";
  if (error instanceof TypeError) return "NETWORK_ERROR";
  return "LLM_ERROR";
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export async function delayRetry(attempt, signal) {
  const delayMs = Math.min(800, attempt * 250);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
