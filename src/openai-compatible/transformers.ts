import type { AnthropicRequest, AnthropicResponse, AnthropicToolChoice, ContentBlock } from "../types/anthropic.js";
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatMessage,
  OpenAIChatTool,
  OpenAIChatToolChoice,
  OpenAIToolCall,
} from "./types.js";

function extractSystemText(system: string | ContentBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;

  return system
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((value) => value && value.length > 0)
    .join("\n");
}

function flattenAnthropicText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((value) => value && value.length > 0)
    .join("\n");
}

function toToolChoice(choice: AnthropicToolChoice | undefined): OpenAIChatToolChoice | undefined {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };

  return undefined;
}

function messageContentToText(message: { content: string | ContentBlock[] | undefined }): string {
  return flattenAnthropicText(message.content).trim();
}

function serializeToolInput(input: unknown): string {
  if (input === undefined) return "{}";
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

function transformAssistantBlocks(content: ContentBlock[]): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text.length > 0) {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: serializeToolInput(block.input),
        },
      });
      continue;
    }

    if (block.type === "tool_result") {
      if (textParts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("\n") : null,
          tool_calls: toolCalls.length > 0 ? [...toolCalls] : undefined,
        });
        textParts.length = 0;
        toolCalls.length = 0;
      }

      const toolResultText =
        typeof block.content === "string"
          ? block.content
          : typeof block.content === "undefined"
            ? block.is_error
              ? "Tool execution failed"
              : ""
            : block.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .filter((value) => value.length > 0)
              .join("\n");

      messages.push({ role: "tool", content: toolResultText, tool_call_id: block.tool_use_id });
    }
  }

  if (textParts.length > 0 || toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }

  return messages;
}

function transformContentToOpenAIMessages(req: AnthropicRequest): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  const systemText = extractSystemText(req.system);

  if (systemText.length > 0) {
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text.length > 0) {
        messages.push({ role: msg.role, content: text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      messages.push(...transformAssistantBlocks(msg.content));
      continue;
    }

    const text = messageContentToText(msg);
    if (text.length > 0) {
      messages.push({ role: msg.role, content: text });
    }

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const toolResultText =
          typeof block.content === "string"
            ? block.content
            : typeof block.content === "undefined"
              ? block.is_error
                ? "Tool execution failed"
                : ""
              : block.content
                .map((part) => (part.type === "text" ? part.text : ""))
                .filter((value) => value.length > 0)
                .join("\n");

        messages.push({ role: "tool", content: toolResultText, tool_call_id: block.tool_use_id });
      }
    }
  }

  return messages;
}

export function transformAnthropicToOpenAIChat(req: AnthropicRequest): OpenAIChatCompletionRequest {
  const messages = transformContentToOpenAIMessages(req);

  const tools: OpenAIChatTool[] | undefined = req.tools
    ? req.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }))
    : undefined;

  const toolChoice = toToolChoice(req.tool_choice);

  return {
    model: req.model,
    messages,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stop: req.stop_sequences,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
  };
}

function parseToolArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapFinishReason(finishReason: string | undefined): AnthropicResponse["stop_reason"] {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop" || finishReason === undefined || finishReason === null) return "end_turn";
  return "end_turn";
}

function mapChoiceToBlocks(choice: OpenAIChatMessage): { content: ContentBlock[]; hasToolUse: boolean } {
  const blocks: ContentBlock[] = [];
  let hasToolUse = false;

  if (typeof choice.content === "string" && choice.content.length > 0) {
    blocks.push({ type: "text", text: choice.content });
  }

  if (Array.isArray(choice.tool_calls) && choice.tool_calls.length > 0) {
    for (const call of choice.tool_calls) {
      const args =
        call.function.arguments && call.function.arguments.length > 0
          ? parseToolArgs(call.function.arguments)
          : {};
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: args,
      });
      hasToolUse = true;
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }

  return { content: blocks, hasToolUse };
}

export function transformOpenAIChatToAnthropic(
  res: OpenAIChatCompletionResponse,
  requestedModel: string,
): AnthropicResponse {
  const choice = (res.choices?.[0] as unknown) as Record<string, unknown>;
  const message = isStringRecord(choice?.message)
    ? ((choice.message as unknown) as OpenAIChatMessage)
    : undefined;

  const fallback = { content: [{ type: "text", text: "" }] as ContentBlock[], hasToolUse: false };
  const { content, hasToolUse } = message ? mapChoiceToBlocks(message) : fallback;

  return {
    id: res.id ?? "chatcmpl-unknown",
    type: "message",
    role: "assistant",
    content,
    model: res.model ?? requestedModel,
    stop_reason: mapFinishReason((choice?.finish_reason as string | undefined) ?? undefined),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}
