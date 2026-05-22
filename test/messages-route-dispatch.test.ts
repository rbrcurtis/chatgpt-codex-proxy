import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import app from "../src/server.js";

function collectResponseBody(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}

test("POST /v1/messages dispatches to openai-compatible when routed by api key", async () => {
  const originalFetch = globalThis.fetch;
  const originalProxyRoutesJson = process.env.PROXY_ROUTES_JSON;

  let calledUrl: string | undefined;
  let calledBody: { stream?: boolean } | undefined;

  process.env.PROXY_ROUTES_JSON =
    '{"defaultRoute":"codex","routes":{"codex":{"kind":"codex"},"max":{"kind":"openai-compatible","baseUrl":"http://max.internal:8000"}}}';

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    // Skip intercepting the client request that calls the local test server
    if (target.includes("127.0.0.1")) {
      return originalFetch(url, init);
    }

    calledUrl = target;
    if (init?.body && typeof init.body === "string") {
      calledBody = JSON.parse(init.body);
    }

    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "qwen3-coder-next",
        choices: [
          {
            message: {
              role: "assistant",
              content: "routed to openai-compatible",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const server = http.createServer(app);

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(0, () => resolve());
      server.once("error", reject);
    });

    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "max",
      },
      body: JSON.stringify({
        model: "qwen3-coder-next",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const body = await collectResponseBody(response);

    assert.equal(response.status, 200);
    assert.equal(calledUrl, "http://max.internal:8000/v1/chat/completions");
    assert.equal(calledBody?.stream, false);
    assert.deepEqual((body as { content?: unknown[] }).content?.[0], {
      type: "text",
      text: "routed to openai-compatible",
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    globalThis.fetch = originalFetch;
    if (originalProxyRoutesJson === undefined) {
      delete process.env.PROXY_ROUTES_JSON;
    } else {
      process.env.PROXY_ROUTES_JSON = originalProxyRoutesJson;
    }
  }
});
