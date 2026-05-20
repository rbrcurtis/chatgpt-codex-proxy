import test from "node:test";
import assert from "node:assert/strict";

import { OllamaClient } from "../src/ollama/client.js";
import type { Response as ExpressResponse } from "express";
import type { AnthropicRequest } from "../src/types/anthropic.js";
import type { OllamaBackendRoute } from "../src/routing/routes.js";
import type { OpenAIChatCompletionResponse } from "../src/ollama/types.js";
import { ProxyError } from "../src/utils/errors.js";

const route: OllamaBackendRoute = {
  kind: "ollama",
  baseUrl: "http://max.local:11434",
};

function request(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "qwen3-coder-next",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

test("createMessage posts transformed anthropic request and maps the response", async () => {
  const originalFetch = globalThis.fetch;
  const seen: { url?: string; init?: RequestInit } = {};

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;

    const json: OpenAIChatCompletionResponse = {
      id: "chatcmpl-1",
      model: "max-model",
      choices: [
        {
          message: {
            role: "assistant",
            content: "done",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 9,
      },
    };

    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new OllamaClient();
    const result = await client.createMessage(route, request({ stream: true }));

    assert.equal(seen.url, "http://max.local:11434/v1/chat/completions");
    assert.equal(seen.init?.method, "POST");
    assert.equal(
      (seen.init?.headers as Record<string, string | undefined>)["content-type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(String(seen.init?.body)), {
      model: "qwen3-coder-next",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      max_tokens: 256,
    });
    assert.deepEqual(result, {
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      model: "max-model",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 7,
        output_tokens: 9,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createMessage throws a proxy error for non-ok upstream responses", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response("nope", {
      status: 401,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const client = new OllamaClient();

    await assert.rejects(
      () => client.createMessage(route, request()),
      (err: unknown) => {
        assert.ok(err instanceof ProxyError);
        assert.equal(err.message, "Ollama upstream 401: nope");
        assert.equal(err.statusCode, 401);
        assert.equal(err.errorType, "authentication_error");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamMessage forwards stream=true and emits Anthropic SSE", async () => {
  const originalFetch = globalThis.fetch;

  const seen: { url?: string; body?: unknown } = {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const events = [
        `data: ${JSON.stringify({
          id: "chatcmpl-stream",
          model: "qwen3-coder-next",
          choices: [{ delta: { content: "Hel" } }],
        })}\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: "lo",
              },
            },
          ],
        })}\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-1",
                    function: {
                      name: "my_tool",
                      arguments: "{\"x\":",
                    },
                  },
                ],
              },
            },
          ],
        })}\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: "1}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 5,
          },
        })}\n`,
        `data: [DONE]\n`,
      ];

      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(url);
    if (init?.body && typeof init.body === "string") {
      seen.body = JSON.parse(init.body);
    }

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const writer: string[] = [];
  const response = {
    getHeader: () => undefined as unknown,
    headersSent: false,
    setHeader: () => undefined,
    write: (chunk: string) => {
      writer.push(chunk);
      return true;
    },
    end: () => {
      writer.push("__end__");
    },
  };

  try {
    const client = new OllamaClient();
    await client.streamMessage(route, request({ stream: true }), response as unknown as ExpressResponse);

    assert.equal(seen.url, "http://max.local:11434/v1/chat/completions");
    const forwardedBody = seen.body as { stream?: boolean };
    assert.equal(forwardedBody.stream, true);

    const events = writer
      .join("")
      .split("\n\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry !== "__end__");

    assert.deepEqual(events[0],
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "chatcmpl-stream",
          type: "message",
          role: "assistant",
          model: "qwen3-coder-next",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}`
    );

    assert.equal(events[1],
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`);

    assert.equal(events[2],
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      })}`);

    assert.equal(events[3],
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      })}`);

    assert.equal(events[4], `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`);

    const toolStart = `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "my_tool",
        input: {},
      },
    })}`;

    const toolDelta = `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ x: 1 }),
      },
    })}`;

    const toolStop = `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`;

    assert.equal(events[5], toolStart);
    assert.equal(events[6], toolDelta);
    assert.equal(events[7], toolStop);

    const messageDelta = `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 3,
        output_tokens: 5,
      },
    })}`;

    const messageStop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`;
    assert.equal(events[8], messageDelta);
    assert.equal(events[9], messageStop);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

