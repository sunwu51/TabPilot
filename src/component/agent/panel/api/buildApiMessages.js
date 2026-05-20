import { API_TYPES, normalizeApiType } from "../../../../api/llm";
import { buildAnthropicApiMessages } from "./anthropicMessages";
import { buildOpenAIApiMessages } from "./openaiMessages";

export function buildApiMessages(apiType, messages, options = {}) {
  const normalizedApiType = normalizeApiType(apiType);
  if (normalizedApiType === API_TYPES.ANTHROPIC) {
    return buildAnthropicApiMessages(messages, options);
  }
  return buildOpenAIApiMessages(messages, { ...options, apiType: normalizedApiType });
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

