import test from "node:test";
import assert from "node:assert/strict";

import { OllamaClient } from "../src/ollama/client.js";
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
