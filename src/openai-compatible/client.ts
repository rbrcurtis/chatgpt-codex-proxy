import { type Response as ExpressResponse } from "express";

import type { AnthropicRequest, AnthropicResponse } from "../types/anthropic.js";
import type { OpenAICompatibleBackendRoute } from "../routing/routes.js";
import type { OpenAIChatCompletionResponse } from "./types.js";
import { transformAnthropicToOpenAIChat, transformOpenAIChatToAnthropic } from "./transformers.js";
import { ProxyError } from "../utils/errors.js";

interface OpenAIStreamingChoice {
  delta?: {
    content?: string;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }[];
  };
  finish_reason?: string;
}

interface OpenAIStreamingUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIStreamingResponse {
  id?: string;
  model?: string;
  choices?: OpenAIStreamingChoice[];
  usage?: OpenAIStreamingUsage;
}

interface OpenAICompatibleToolCallBuffer {
  id: string;
  name: string;
  arguments: string;
}

function mapStopReason(finishReason: string | undefined, hasToolCalls: boolean): AnthropicResponse["stop_reason"] {
  if (hasToolCalls) {
    return "tool_use";
  }

  if (finishReason === "tool_calls") {
    return "tool_use";
  }

  if (finishReason === "length") {
    return "max_tokens";
  }

  return "end_turn";
}

function parseToolArguments(args: string): unknown {
  if (!args) {
    return {};
  }

  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSseEvent(res: ExpressResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function applyRouteModel(route: OpenAICompatibleBackendRoute, body: AnthropicRequest): AnthropicRequest {
  if (!route.model) {
    return body;
  }

  return {
    ...body,
    model: route.model,
  };
}

export class OpenAICompatibleClient {
  async createMessage(route: OpenAICompatibleBackendRoute, body: AnthropicRequest): Promise<AnthropicResponse> {
    const effectiveBody = applyRouteModel(route, body);
    const res = await fetch(`${route.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
      },
      body: JSON.stringify(transformAnthropicToOpenAIChat({ ...effectiveBody, stream: false })),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProxyError(
        `OpenAI-compatible upstream ${res.status}: ${text.slice(0, 500)}`,
        res.status >= 500 ? 502 : res.status,
        res.status === 401 || res.status === 403 ? "authentication_error" : "api_error",
      );
    }

    const json = (await res.json()) as OpenAIChatCompletionResponse;
    return transformOpenAIChatToAnthropic(json, effectiveBody.model);
  }

  async streamMessage(route: OpenAICompatibleBackendRoute, body: AnthropicRequest, res: ExpressResponse): Promise<void> {
    const effectiveBody = applyRouteModel(route, body);
    const upstreamRes = await fetch(`${route.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
      },
      body: JSON.stringify(transformAnthropicToOpenAIChat({ ...effectiveBody, stream: true })),
    });

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      throw new ProxyError(
        `OpenAI-compatible upstream ${upstreamRes.status}: ${text.slice(0, 500)}`,
        upstreamRes.status >= 500 ? 502 : upstreamRes.status,
        upstreamRes.status === 401 || upstreamRes.status === 403 ? "authentication_error" : "api_error",
      );
    }

    if (!upstreamRes.body) {
      throw new ProxyError("OpenAI-compatible upstream returned no stream body", 502, "api_error");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const textReader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let sawTextBlock = false;
    const toolCallsByIndex = new Map<number, OpenAICompatibleToolCallBuffer>();
    let usage: OpenAIStreamingUsage = {};
    let finishReason: string | undefined;
    let responseId = "chatcmpl-unknown";
    let responseModel = effectiveBody.model;
    let messageStartSent = false;

    const sendMessageStart = () => {
      if (messageStartSent) {
        return;
      }

      messageStartSent = true;
      writeSseEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: responseId,
          type: "message",
          role: "assistant",
          model: responseModel,
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      });
    };

    const handleStreamingChoice = (choice: OpenAIStreamingChoice): void => {
      sendMessageStart();

      const delta = choice.delta;
      if (!delta) {
        return;
      }

      const textChunk = delta.content;
      if (typeof textChunk === "string" && textChunk.length > 0) {
        if (!sawTextBlock) {
          sawTextBlock = true;
          writeSseEvent(res, "content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: "",
            },
          });
        }

        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: textChunk,
          },
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const toolIndex = toolCall.index ?? 0;
          const existing = toolCallsByIndex.get(toolIndex) ?? {
            id: `tool_${toolIndex}`,
            name: "tool",
            arguments: "",
          };

          if (toolCall.id !== undefined) {
            existing.id = toolCall.id;
          }
          if (toolCall.function?.name !== undefined) {
            existing.name = toolCall.function.name;
          }
          if (toolCall.function?.arguments !== undefined) {
            existing.arguments = `${existing.arguments}${toolCall.function.arguments}`;
          }

          toolCallsByIndex.set(toolIndex, existing);
        }
      }

      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
    };

    const processSseLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        return;
      }

      const rawPayload = trimmed.slice(5);
      const payload = rawPayload.startsWith(" ") ? rawPayload.slice(1).trim() : rawPayload.trim();
      if (payload === "" || payload === "[DONE]") {
        return;
      }

      let parsed: OpenAIStreamingResponse;
      try {
        parsed = JSON.parse(payload) as OpenAIStreamingResponse;
      } catch {
        return;
      }

      if (parsed.id) {
        responseId = parsed.id;
      }
      if (parsed.model) {
        responseModel = parsed.model;
      }

      const choice = parsed.choices?.[0];
      if (!choice) {
        return;
      }

      if (parsed.usage) {
        usage = parsed.usage;
      }

      handleStreamingChoice(choice);
    };

    while (true) {
      const { value, done } = await textReader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }

        processSseLine(line);
      }
    }

    const tail = decoder.decode();
    buffer += tail;
    if (buffer.trim().length > 0) {
      processSseLine(buffer.trim());
    }

    if (sawTextBlock) {
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: 0,
      });
    }

    const baseToolIndex = sawTextBlock ? 1 : 0;
    const toolIndices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
    for (const toolIndex of toolIndices) {
      const toolCall = toolCallsByIndex.get(toolIndex);
      if (!toolCall) {
        continue;
      }

      const blockIndex = baseToolIndex + toolIndex;
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: {},
        },
      });
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(parseToolArguments(toolCall.arguments)),
        },
      });
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
    }

    writeSseEvent(res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(finishReason, toolCallsByIndex.size > 0),
        stop_sequence: null,
      },
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
      },
    });

    writeSseEvent(res, "message_stop", {
      type: "message_stop",
    });
    res.end();
  }
}
