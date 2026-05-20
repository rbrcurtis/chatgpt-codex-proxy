import type { AnthropicRequest, AnthropicResponse } from "../types/anthropic.js";
import type { OllamaBackendRoute } from "../routing/routes.js";
import type { OpenAIChatCompletionResponse } from "./types.js";
import { transformAnthropicToOllamaChat, transformOllamaChatToAnthropic } from "./transformers.js";
import { ProxyError } from "../utils/errors.js";

export class OllamaClient {
  async createMessage(route: OllamaBackendRoute, body: AnthropicRequest): Promise<AnthropicResponse> {
    const res = await fetch(`${route.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(transformAnthropicToOllamaChat({ ...body, stream: false })),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProxyError(
        `Ollama upstream ${res.status}: ${text.slice(0, 500)}`,
        res.status >= 500 ? 502 : res.status,
        res.status === 401 || res.status === 403 ? "authentication_error" : "api_error",
      );
    }

    const json = (await res.json()) as OpenAIChatCompletionResponse;
    return transformOllamaChatToAnthropic(json, body.model);
  }
}
