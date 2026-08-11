import { API_TYPES, normalizeApiType } from "../../../../api/llm";
import { buildAnthropicApiMessages } from "./anthropicMessages";
import { buildOpenAIApiMessages } from "./openaiMessages";

export function buildApiMessages(apiType, messages, options = {}) {
  const normalizedApiType = normalizeApiType(apiType);
  const requestMessages = appendUploadedImageUrlText(messages);
  if (normalizedApiType === API_TYPES.ANTHROPIC) {
    return buildAnthropicApiMessages(requestMessages, options);
  }
  return buildOpenAIApiMessages(requestMessages, { ...options, apiType: normalizedApiType });
}

export function appendUploadedImageUrlText(messages = []) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const requestMessages = sourceMessages.map(message => {
    if (message?.role !== "user") return message;
    const urls = [...new Set((Array.isArray(message.imageRefs) ? message.imageRefs : [])
      .map(item => String(item?.uploadedUrl || "").trim())
      .filter(url => /^https?:\/\//i.test(url)))];
    if (urls.length === 0) return message;
    const text = urls.map(url => `This image has been uploaded to URL: ${url}`).join("\n");
    if (Array.isArray(message.content)) {
      return { ...message, content: [...message.content, { type: "text", text }] };
    }
    return { ...message, content: [
      ...(String(message.content || "").trim() ? [{ type: "text", text: String(message.content) }] : []),
      { type: "text", text }
    ] };
  });

  const contextualUrls = collectUploadedImageUrls(
    sourceMessages.filter(message => message?.role !== "user")
  );
  if (contextualUrls.length === 0) return requestMessages;

  const lastUserIndex = requestMessages.findLastIndex(message => message?.role === "user");
  if (lastUserIndex < 0) return requestMessages;
  const contextText = [
    "Uploaded image URLs from earlier assistant or tool messages:",
    ...contextualUrls.map(item => `- ${item.ref || "image"}: ${item.url}`)
  ].join("\n");
  requestMessages[lastUserIndex] = appendTextToUserMessage(requestMessages[lastUserIndex], contextText);
  return requestMessages;
}

function collectUploadedImageUrls(value, entries = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectUploadedImageUrls(item, entries);
    return Array.from(entries.values());
  }
  if (!value || typeof value !== "object") return Array.from(entries.values());

  const url = String(value.uploadedUrl || "").trim();
  if (/^https?:\/\//i.test(url)) {
    const ref = String(value.ref || value.source?.ref || "").trim();
    entries.set(`${ref}\n${url}`, { ref, url });
  }
  for (const child of Object.values(value)) collectUploadedImageUrls(child, entries);
  return Array.from(entries.values());
}

function appendTextToUserMessage(message, text) {
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, { type: "text", text }] };
  }
  return {
    ...message,
    content: [
      ...(String(message.content || "").trim() ? [{ type: "text", text: String(message.content) }] : []),
      { type: "text", text }
    ]
  };
}

export function buildPlatformSystemPrompt(platformInfo) {
  if (!platformInfo?.os) {
    return "";
  }

  const parts = [`Current operating system: ${platformInfo.os}`];
  if (platformInfo.arch) parts.push(`architecture: ${platformInfo.arch}`);
  if (platformInfo.nacl_arch) parts.push(`nacl_arch: ${platformInfo.nacl_arch}`);

  return `Environment:\n- ${parts.join("; ")}.\n\n`;
}

