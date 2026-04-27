const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

export function getAcpControllerBaseUrl() {
  return DEFAULT_BASE_URL;
}

async function requestJson(path, options = {}) {
  const baseUrl = getAcpControllerBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const message = data?.error || data?.message || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

export async function getAcpHealth() {
  return requestJson("/health", { method: "GET" });
}

export async function listAcpAgents() {
  return requestJson("/api/agents", { method: "GET" });
}

export async function listAcpSessions() {
  return requestJson("/api/sessions", { method: "GET" });
}

export async function createAcpSession({ agentId, cwd, title }) {
  return requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ agentId, cwd, title }),
  });
}

export async function sendAcpPrompt(sessionId, text) {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function subscribeAcpSessionEvents(sessionId, { onEvent, onError, onOpen, skipReplay = false } = {}) {
  const baseUrl = getAcpControllerBaseUrl();
  const replayParam = skipReplay ? "?replay=0" : "";
  const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events/sse${replayParam}`;
  const source = new EventSource(url);

  source.onopen = () => onOpen?.();
  source.onerror = (error) => onError?.(error);

  const eventTypes = [
    "session_created",
    "session_status",
    "session_update",
    "prompt_done",
    "permission_request",
    "stderr",
    "error",
  ];

  for (const type of eventTypes) {
    source.addEventListener(type, (event) => {
      const data = safeJsonParse(event.data);
      onEvent?.(data || { type, raw: event.data });
    });
  }

  source.onmessage = (event) => {
    const data = safeJsonParse(event.data);
    if (data) onEvent?.(data);
  };

  return () => source.close();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

