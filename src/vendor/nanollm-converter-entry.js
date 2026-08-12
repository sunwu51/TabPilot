import {
  chatParamsToAnthropicMessageRequest,
  chatParamsToResponsesRequest,
  anthropicMessageToChatCompletion,
  responsesResponseToChatCompletion
} from "../../../nanollm/src/converters/index.ts";

export function chatRequestToProvider(request, provider) {
  if (provider === "openai-responses") return chatParamsToResponsesRequest(request);
  if (provider === "anthropic") return chatParamsToAnthropicMessageRequest(request);
  throw new Error(`Unsupported provider: ${provider}`);
}

export function providerResponseToChat(response, provider) {
  if (provider === "openai-responses") return responsesResponseToChatCompletion(response);
  if (provider === "anthropic") return anthropicMessageToChatCompletion(response);
  throw new Error(`Unsupported provider: ${provider}`);
}
