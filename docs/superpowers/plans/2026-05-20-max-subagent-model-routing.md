# Max Subagent Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install `qwen3-coder:30b-a3b-q8_0` on `max.local` and expose it through `chatgpt-codex-proxy` as the forced-model route key `max-subagent` for Claude/Orchestrel subagent use.

**Architecture:** Keep `max.local` simple: it only runs Ollama and serves models on `http://max.local:11434`. Add route-level model override support in `chatgpt-codex-proxy` so the proxy can map an API key (`max-subagent`) to an Ollama backend plus a fixed model (`qwen3-coder:30b-a3b-q8_0`) regardless of the client-requested Anthropic model. Preserve existing `max` and default Codex behavior.

**Tech Stack:** Node.js/TypeScript, Express, Ollama native API, Ollama OpenAI-compatible `/v1/chat/completions`, systemd, Node test runner (`tsx --test`).

---

## File Structure

- Modify `src/routing/routes.ts`
  - Add optional `model` to `OllamaBackendRoute`.
  - Add fallback route `max-subagent` pointing at the same Ollama base URL as `max` with forced model `qwen3-coder:30b-a3b-q8_0`.
  - Parse optional string `model` from `PROXY_ROUTES_JSON` for Ollama routes.
- Modify `src/ollama/client.ts`
  - Add one small helper to apply the route model override before transforming/sending upstream requests.
  - Use the effective model for non-streaming and streaming upstream requests.
  - Return/stream the effective model in Anthropic responses.
- Modify `test/routing.test.ts`
  - Cover default `max-subagent` route and JSON-config model parsing.
- Modify `test/ollama-client.test.ts`
  - Cover forced model override for `createMessage` and `streamMessage`.
- Operational actions only, no repo file changes:
  - Pull `qwen3-coder:30b-a3b-q8_0` on `max.local` through Ollama.
  - Build, restart `chatgpt-codex-proxy.service`, verify direct and proxy chat.

---

### Task 1: Install and verify the subagent model on Max

**Files:**
- No repo files changed.

- [ ] **Step 1: Pull the model on max.local**

Run from the home machine against Ollama on Max:

```bash
set -ex
curl -sS http://max.local:11434/api/pull \
  -H 'content-type: application/json' \
  -d '{"name":"qwen3-coder:30b-a3b-q8_0","stream":false}'
```

Expected: JSON response ending with success, or equivalent Ollama pull output showing the model is available.

- [ ] **Step 2: Confirm the model appears in Ollama tags**

Run:

```bash
set -ex
curl -sS http://max.local:11434/api/tags | python3 -m json.tool
```

Expected: output includes both installed models:

```txt
qwen3-coder-next:latest
qwen3-coder:30b-a3b-q8_0
```

- [ ] **Step 3: Verify native Ollama chat works directly**

Run:

```bash
set -ex
curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://max.local:11434/api/chat \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-coder:30b-a3b-q8_0","stream":false,"messages":[{"role":"user","content":"Reply with exactly DIRECT_MAX_SUBAGENT_OK and nothing else."}]}'
```

Expected: HTTP 200 and response message content exactly:

```txt
DIRECT_MAX_SUBAGENT_OK
```

- [ ] **Step 4: Verify OpenAI-compatible chat works directly**

Run:

```bash
set -ex
curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://max.local:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-coder:30b-a3b-q8_0","stream":false,"messages":[{"role":"user","content":"Reply with exactly DIRECT_MAX_SUBAGENT_OPENAI_OK and nothing else."}]}'
```

Expected: HTTP 200 and response choice message content exactly:

```txt
DIRECT_MAX_SUBAGENT_OPENAI_OK
```

---

### Task 2: Add route-level forced model support

**Files:**
- Modify: `src/routing/routes.ts`
- Test: `test/routing.test.ts`

- [ ] **Step 1: Add failing routing tests**

Append these tests to `test/routing.test.ts`:

```ts
test("loadRoutingConfigFromEnv includes max-subagent fallback route with forced model", () => {
  const config = loadRoutingConfigFromEnv({
    MAX_OLLAMA_BASE_URL: "http://custom.max/",
  });

  assert.equal(config.routes["max-subagent"].kind, "ollama");
  if (config.routes["max-subagent"].kind !== "ollama") {
    throw new Error("max-subagent route should be ollama");
  }

  assert.equal(config.routes["max-subagent"].baseUrl, "http://custom.max");
  assert.equal(config.routes["max-subagent"].model, "qwen3-coder:30b-a3b-q8_0");
});

test("loadRoutingConfigFromEnv parses optional ollama route model override", () => {
  const config = loadRoutingConfigFromEnv({
    PROXY_ROUTES_JSON:
      '{"defaultRoute":"codex","routes":{"codex":{"kind":"codex"},"worker":{"kind":"ollama","baseUrl":"http://max.local/","model":"qwen3-coder:30b-a3b-q8_0"}}}',
  });

  const route = config.routes.worker;
  assert.equal(route.kind, "ollama");
  if (route.kind !== "ollama") {
    throw new Error("worker route should be ollama");
  }

  assert.equal(route.baseUrl, "http://max.local");
  assert.equal(route.model, "qwen3-coder:30b-a3b-q8_0");
});
```

- [ ] **Step 2: Run routing tests and verify they fail**

Run:

```bash
cd /home/ryan/Code/chatgpt-codex-proxy && npm test -- test/routing.test.ts
```

Expected: FAIL because `model` and `max-subagent` do not exist yet.

- [ ] **Step 3: Add optional model to route types and fallback config**

Update `src/routing/routes.ts` so the Ollama route type and fallback config look like this:

```ts
export interface OllamaBackendRoute {
  kind: "ollama";
  baseUrl: string;
  model?: string;
}

const FALLBACK_BASE_URL = "http://max.local:11434";
const FALLBACK_SUBAGENT_MODEL = "qwen3-coder:30b-a3b-q8_0";

function fallbackRoutingConfig(env: NodeJS.ProcessEnv): RoutingConfig {
  const baseUrl = (env.MAX_OLLAMA_BASE_URL ?? FALLBACK_BASE_URL).replace(/\/+$/, "");

  return {
    defaultRoute: "codex",
    routes: {
      codex: { kind: "codex" },
      max: {
        kind: "ollama",
        baseUrl,
      },
      "max-subagent": {
        kind: "ollama",
        baseUrl,
        model: FALLBACK_SUBAGENT_MODEL,
      },
    },
  };
}
```

- [ ] **Step 4: Parse optional model from JSON config**

In the `typedRoute.kind === "ollama"` branch of `loadRoutingConfigFromEnv`, replace route assignment with:

```ts
const model = typeof typedRoute.model === "string" && typedRoute.model.trim() !== ""
  ? typedRoute.model.trim()
  : undefined;

routes[routeKey] = {
  kind: "ollama",
  baseUrl: typedRoute.baseUrl.replace(/\/+$/, ""),
  ...(model ? { model } : {}),
};
```

Also update the `typedRoute` declaration from:

```ts
const typedRoute = routeValue as { kind?: unknown; baseUrl?: unknown };
```

to:

```ts
const typedRoute = routeValue as { kind?: unknown; baseUrl?: unknown; model?: unknown };
```

- [ ] **Step 5: Run routing tests and verify they pass**

Run:

```bash
cd /home/ryan/Code/chatgpt-codex-proxy && npm test -- test/routing.test.ts
```

Expected: PASS for all routing tests.

- [ ] **Step 6: Commit route model support**

Run:

```bash
git -C /home/ryan/Code/chatgpt-codex-proxy add src/routing/routes.ts test/routing.test.ts
git -C /home/ryan/Code/chatgpt-codex-proxy commit -m "$(cat <<'EOF'
feat: add max subagent route model override
EOF
)"
```

---

### Task 3: Apply forced route model in Ollama client

**Files:**
- Modify: `src/ollama/client.ts`
- Test: `test/ollama-client.test.ts`

- [ ] **Step 1: Add failing non-streaming model override test**

Append this test to `test/ollama-client.test.ts`:

```ts
test("createMessage uses route model override for upstream ollama request", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });

    return new Response(
      JSON.stringify({
        id: "chatcmpl-forced-model",
        model: "qwen3-coder:30b-a3b-q8_0",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "forced model ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new OllamaClient();
    const response = await client.createMessage(
      {
        kind: "ollama",
        baseUrl: "http://max.local:11434",
        model: "qwen3-coder:30b-a3b-q8_0",
      },
      {
        model: "claude-subagent-placeholder",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicRequest,
    );

    assert.equal(calls.length, 1);
    assert.equal((calls[0].body as { model: string }).model, "qwen3-coder:30b-a3b-q8_0");
    assert.equal(response.model, "qwen3-coder:30b-a3b-q8_0");
    assert.deepEqual(response.content, [{ type: "text", text: "forced model ok" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Add failing streaming model override test**

Append this test to `test/ollama-client.test.ts`:

```ts
test("streamMessage uses route model override for upstream ollama request", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"id":"chatcmpl-stream-forced","model":"qwen3-coder:30b-a3b-q8_0","choices":[{"delta":{"content":"SUBAGENT_STREAM_OK"}}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    const client = new OllamaClient();
    const chunks: string[] = [];
    const res = {
      setHeader() {},
      write(chunk: string) {
        chunks.push(chunk);
      },
      end() {},
    } as unknown as ExpressResponse;

    await client.streamMessage(
      {
        kind: "ollama",
        baseUrl: "http://max.local:11434",
        model: "qwen3-coder:30b-a3b-q8_0",
      },
      {
        model: "claude-subagent-placeholder",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicRequest,
      res,
    );

    assert.equal(calls.length, 1);
    assert.equal((calls[0].body as { model: string }).model, "qwen3-coder:30b-a3b-q8_0");
    assert.match(chunks.join(""), /qwen3-coder:30b-a3b-q8_0/);
    assert.match(chunks.join(""), /SUBAGENT_STREAM_OK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

If `ExpressResponse` is not already imported in `test/ollama-client.test.ts`, add:

```ts
import type { Response as ExpressResponse } from "express";
```

- [ ] **Step 3: Run Ollama client tests and verify they fail**

Run:

```bash
cd /home/ryan/Code/chatgpt-codex-proxy && npm test -- test/ollama-client.test.ts
```

Expected: FAIL because route model override is not applied yet.

- [ ] **Step 4: Add effective request helper**

In `src/ollama/client.ts`, inside the file but outside the class, add:

```ts
function applyRouteModel(route: OllamaBackendRoute, body: AnthropicRequest): AnthropicRequest {
  if (!route.model) {
    return body;
  }

  return {
    ...body,
    model: route.model,
  };
}
```

- [ ] **Step 5: Use effective body in createMessage**

Change `createMessage` to use an effective body:

```ts
async createMessage(route: OllamaBackendRoute, body: AnthropicRequest): Promise<AnthropicResponse> {
  const effectiveBody = applyRouteModel(route, body);
  const res = await fetch(`${route.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(transformAnthropicToOllamaChat({ ...effectiveBody, stream: false })),
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
  return transformOllamaChatToAnthropic(json, effectiveBody.model);
}
```

- [ ] **Step 6: Use effective body in streamMessage**

At the top of `streamMessage`, add:

```ts
const effectiveBody = applyRouteModel(route, body);
```

Then change the upstream request body from:

```ts
body: JSON.stringify(transformAnthropicToOllamaChat({ ...body, stream: true })),
```

to:

```ts
body: JSON.stringify(transformAnthropicToOllamaChat({ ...effectiveBody, stream: true })),
```

And change:

```ts
let responseModel = body.model;
```

to:

```ts
let responseModel = effectiveBody.model;
```

- [ ] **Step 7: Run Ollama client tests and verify they pass**

Run:

```bash
cd /home/ryan/Code/chatgpt-codex-proxy && npm test -- test/ollama-client.test.ts
```

Expected: PASS for all Ollama client tests.

- [ ] **Step 8: Commit forced model application**

Run:

```bash
git -C /home/ryan/Code/chatgpt-codex-proxy add src/ollama/client.ts test/ollama-client.test.ts
git -C /home/ryan/Code/chatgpt-codex-proxy commit -m "$(cat <<'EOF'
feat: force ollama model by route
EOF
)"
```

---

### Task 4: Verify full suite, build, restart, and production smoke

**Files:**
- No source changes expected unless verification exposes a bug.

- [ ] **Step 1: Run full test suite**

Run:

```bash
cd /home/ryan/Code/chatgpt-codex-proxy && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Build TypeScript**

Run:

```bash
cd /home/ryan/Code/chatgpt-codex-proxy && npm run build
```

Expected: `tsc` exits 0.

- [ ] **Step 3: Restart production service**

Run:

```bash
set -ex
sudo systemctl restart chatgpt-codex-proxy.service
systemctl status chatgpt-codex-proxy.service --no-pager
```

Expected: service is active/running and uses `/home/ryan/Code/chatgpt-codex-proxy/dist/index.js`.

- [ ] **Step 4: Verify production non-streaming subagent route forces model**

Run:

```bash
set -ex
curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:3459/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: max-subagent' \
  -d '{"model":"claude-subagent-placeholder","max_tokens":128,"stream":false,"messages":[{"role":"user","content":"Reply with exactly PROD_MAX_SUBAGENT_OK and nothing else."}]}'
```

Expected: HTTP 200, response `model` is `qwen3-coder:30b-a3b-q8_0`, and text is exactly:

```txt
PROD_MAX_SUBAGENT_OK
```

- [ ] **Step 5: Verify production streaming subagent route forces model**

Run:

```bash
set -ex
curl -sS -N -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:3459/v1/messages \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer max-subagent' \
  -d '{"model":"claude-subagent-placeholder","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Reply with exactly PROD_MAX_SUBAGENT_STREAM_OK and nothing else."}]}'
```

Expected: HTTP 200, Anthropic SSE `message_start` includes model `qwen3-coder:30b-a3b-q8_0`, and streamed text composes exactly:

```txt
PROD_MAX_SUBAGENT_STREAM_OK
```

- [ ] **Step 6: Verify existing max route still works**

Run:

```bash
set -ex
curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:3459/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: max' \
  -d '{"model":"qwen3-coder-next:latest","max_tokens":128,"stream":false,"messages":[{"role":"user","content":"Reply with exactly PROD_MAX_STILL_OK and nothing else."}]}'
```

Expected: HTTP 200 and text exactly:

```txt
PROD_MAX_STILL_OK
```

- [ ] **Step 7: Verify default Codex route still works**

Run:

```bash
set -ex
curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:3459/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-mini","max_tokens":64,"stream":false,"messages":[{"role":"user","content":"Reply with exactly PROD_CODEX_STILL_OK and nothing else."}]}'
```

Expected: HTTP 200 and text exactly:

```txt
PROD_CODEX_STILL_OK
```

- [ ] **Step 8: Inspect route logs**

Run:

```bash
journalctl -u chatgpt-codex-proxy.service --since '5 minutes ago' --no-pager | grep -E 'route key=max-subagent|route key=max|route key=codex'
```

Expected: logs include:

```txt
route key=max-subagent kind=ollama model=claude-subagent-placeholder
route key=max kind=ollama model=qwen3-coder-next:latest
route key=codex kind=codex model=gpt-5.4-mini
```

Note: the log prints inbound model, not necessarily effective forced model. The response bodies prove forced model behavior.

---

### Task 5: Push and store memory

**Files:**
- No source changes expected unless verification exposes a bug.

- [ ] **Step 1: Confirm git status and recent commits**

Run:

```bash
git -C /home/ryan/Code/chatgpt-codex-proxy status --short --branch
git -C /home/ryan/Code/chatgpt-codex-proxy log --oneline -5
```

Expected: branch `main` tracks `origin/main`, with local commits from Tasks 2 and 3 ahead until pushed.

- [ ] **Step 2: Push main to Ryan's fork**

Run:

```bash
git -C /home/ryan/Code/chatgpt-codex-proxy push origin main
```

Expected: push succeeds to:

```txt
https://github.com/rbrcurtis/chatgpt-codex-proxy.git
```

- [ ] **Step 3: Store/update memory**

Use shared memory to update the existing max.local routing memory and recommended subagent model memory with:

```txt
Installed qwen3-coder:30b-a3b-q8_0 on max.local. Added max-subagent route to chatgpt-codex-proxy with forced model qwen3-coder:30b-a3b-q8_0. Verified direct Ollama native chat, direct OpenAI-compatible chat, production proxy non-streaming, production proxy streaming, existing max route, and default Codex route.
```

---

## Self-Review

- Spec coverage: installs the model, adds route key, forces model, preserves `max` and `codex`, verifies direct Max and production proxy paths, commits/pushes, updates memory.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `OllamaBackendRoute.model?: string` is used consistently in routing config and `OllamaClient`.
- Scope: single implementation plan; no independent subsystem split needed.
