import test from "node:test";
import assert from "node:assert/strict";

import { transformAnthropicToCodex } from "../src/transformers/request.js";
import type { AnthropicRequest } from "../src/types/anthropic.js";

function buildRequest(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "test" }],
    parallel_tool_calls: true,
    ...overrides,
  };
}

test("keeps parallel_tool_calls for non-mutating tools", () => {
  const request = buildRequest({
    tools: [
      {
        name: "Read",
        description: "Read file",
        input_schema: { type: "object", properties: { filePath: { type: "string" } } },
      },
      {
        name: "Grep",
        description: "Search content",
        input_schema: { type: "object", properties: { pattern: { type: "string" } } },
      },
    ],
  });

  const codex = transformAnthropicToCodex(request);
  assert.equal(codex.parallel_tool_calls, true);
});

test("omits parallel_tool_calls when mutating tool is present", () => {
  const request = buildRequest({
    tools: [
      {
        name: "Read",
        description: "Read file",
        input_schema: { type: "object", properties: { filePath: { type: "string" } } },
      },
      {
        name: "Update",
        description: "Update file",
        input_schema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            oldString: { type: "string" },
            newString: { type: "string" },
          },
        },
      },
    ],
  });

  const codex = transformAnthropicToCodex(request);
  assert.equal(codex.parallel_tool_calls, undefined);
});

test("omits parallel_tool_calls when mutating tool is chosen directly", () => {
  const request = buildRequest({
    tools: [
      {
        name: "Update",
        description: "Update file",
        input_schema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            oldString: { type: "string" },
            newString: { type: "string" },
          },
        },
      },
    ],
    tool_choice: { type: "tool", name: "Update" },
  });

  const codex = transformAnthropicToCodex(request);
  assert.equal(codex.parallel_tool_calls, undefined);
});

test("folds system-role messages into codex instructions", () => {
  const request = buildRequest({
    system: "Top-level system prompt.",
    messages: [
      { role: "system", content: "Hook-provided context." },
      { role: "user", content: "Hello" },
    ],
  });

  const codex = transformAnthropicToCodex(request);

  assert.equal(codex.instructions, "Top-level system prompt.\n\nHook-provided context.");
  assert.deepEqual(codex.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    },
  ]);
});

test("normalizes schema-object additionalProperties for Codex tools", () => {
  const request = buildRequest({
    tools: [
      {
        name: "ExitPlanMode",
        description: "Request plan approval",
        input_schema: {
          type: "object",
          properties: {
            allowedPrompts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tool: { type: "string", enum: ["Bash"] },
                  prompt: { type: "string" },
                },
                required: ["tool", "prompt"],
                additionalProperties: {},
              },
            },
          },
          additionalProperties: {},
        },
      },
    ],
  });

  const codex = transformAnthropicToCodex(request);

  assert.equal(codex.tools?.[0]?.parameters.additionalProperties, true);
  const allowedPrompts = codex.tools?.[0]?.parameters.properties as Record<string, unknown>;
  const schema = allowedPrompts.allowedPrompts as { items?: { additionalProperties?: unknown } };
  assert.equal(schema.items?.additionalProperties, true);
});

test("drops Claude-specific tools that Codex silently empty-completes", () => {
  const request = buildRequest({
    tools: [
      {
        name: "Read",
        description: "Read file",
        input_schema: { type: "object", properties: { filePath: { type: "string" } } },
      },
      {
        name: "WebFetch",
        description: "Fetch a URL",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            prompt: { type: "string" },
          },
          required: ["url", "prompt"],
          additionalProperties: false,
        },
      },
      {
        name: "Workflow",
        description: "Run workflow",
        input_schema: {
          type: "object",
          properties: {
            args: {
              description: "Any JSON value.",
            },
            emptyItems: {
              type: "array",
              items: {},
            },
          },
          additionalProperties: false,
        },
      },
    ],
  });

  const codex = transformAnthropicToCodex(request);

  assert.deepEqual(codex.tools?.map((tool) => tool.name), ["Read"]);
});
