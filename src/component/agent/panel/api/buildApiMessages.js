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
  return (Array.isArray(messages) ? messages : []).map(message => {
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

