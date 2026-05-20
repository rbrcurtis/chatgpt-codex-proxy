import test from "node:test";
import assert from "node:assert/strict";

import {
  transformAnthropicToOllamaChat,
  transformOllamaChatToAnthropic,
} from "../src/ollama/transformers.js";
import type { AnthropicRequest } from "../src/types/anthropic.js";
import type { OpenAIChatCompletionResponse } from "../src/ollama/types.js";

const sampleModel = "qwen3-coder-next";

function req(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: sampleModel,
    max_tokens: 512,
    messages: [],
    ...overrides,
  };
}

test("transforms basic system/user/text settings", () => {
  const request = req({
    system: "System prompt",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ],
    temperature: 0.4,
    top_p: 0.8,
    stream: true,
    max_tokens: 1024,
  });

  const transformed = transformAnthropicToOllamaChat(request);

  assert.equal(transformed.model, sampleModel);
  assert.equal(transformed.stream, true);
  assert.equal(transformed.temperature, 0.4);
  assert.equal(transformed.top_p, 0.8);
  assert.equal(transformed.max_tokens, 1024);
  assert.deepEqual(transformed.messages, [
    { role: "system", content: "System prompt" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ]);
});

test("maps anthropic tools to openai function tools", () => {
  const request = req({
    tools: [
      {
        name: "read_file",
        description: "Read from path",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "search",
        description: undefined,
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    messages: [{ role: "user", content: "run" }],
  });

  const transformed = transformAnthropicToOllamaChat(request);

  assert.deepEqual(transformed.tools, [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read from path",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description: undefined,
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
  ]);
});

test("maps tool choice any to required and tool-specific choice", () => {
  const request = req({
    tool_choice: { type: "any" },
    tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
    messages: [],
  });

  const transformed = transformAnthropicToOllamaChat(request);

  assert.equal(transformed.tool_choice, "required");

  const explicit = transformAnthropicToOllamaChat(
    req({
      tool_choice: { type: "tool", name: "read" },
      tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
      messages: [],
    }),
  );

  assert.deepEqual(explicit.tool_choice, { type: "function", function: { name: "read" } });
});

test("converts anthropic tool_use/tool_result history", () => {
  const request = req({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "/tmp/a.txt" } },
          { type: "tool_result", tool_use_id: "call-1", content: "file text" },
        ],
      },
    ],
  });

  const transformed = transformAnthropicToOllamaChat(request);

  assert.deepEqual(transformed.messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"/tmp/a.txt"}',
          },
        },
      ],
    },
    { role: "tool", content: "file text", tool_call_id: "call-1" },
  ]);
});

test("converts text response from openai to anthropic content block", () => {
  const response: OpenAIChatCompletionResponse = {
    id: "chatcmpl-1",
    model: "gpt-4o-mini",
    choices: [
      {
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [],
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 15,
      completion_tokens: 25,
    },
  };

  const anthropic = transformOllamaChatToAnthropic(response, sampleModel);

  assert.deepEqual(anthropic, {
    id: "chatcmpl-1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "gpt-4o-mini",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 15,
      output_tokens: 25,
    },
  });
});

test("converts openai tool_calls to anthropic tool_use blocks", () => {
  const response: OpenAIChatCompletionResponse = {
    id: "chatcmpl-2",
    model: "gpt-4o-mini",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool-2",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"/tmp/a.txt\"}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 22,
    },
  };

  const anthropic = transformOllamaChatToAnthropic(response, sampleModel);

  assert.deepEqual(anthropic, {
    id: "chatcmpl-2",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-2",
        name: "read_file",
        input: { path: "/tmp/a.txt" },
      },
    ],
    model: "gpt-4o-mini",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
    },
  });
});

test("maps missing response id and model fallback to requested model", () => {
  const response: OpenAIChatCompletionResponse = {
    choices: [
      {
        message: {
          role: "assistant",
          content: "hello",
        },
      },
    ],
  };

  const anthropic = transformOllamaChatToAnthropic(response, sampleModel);

  assert.equal(anthropic.id, "chatcmpl-unknown");
  assert.equal(anthropic.model, sampleModel);
});

test("invalid tool argument json becomes empty object", () => {
  const response: OpenAIChatCompletionResponse = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool-bad",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{not-valid}",
              },
            },
          ],
        },
      },
    ],
    usage: {},
  };

  const anthropic = transformOllamaChatToAnthropic(response, sampleModel);

  assert.deepEqual(anthropic.content, [
    {
      type: "tool_use",
      id: "tool-bad",
      name: "read_file",
      input: {},
    },
  ]);
});
