# max.local API-Key Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API-key-based routing to `chatgpt-codex-proxy` so existing Orchestrel provider config can route some Anthropic `/v1/messages` requests to `max.local` Ollama while preserving the current Codex behavior.

**Architecture:** `chatgpt-codex-proxy` remains the Anthropic-compatible facade. `/v1/messages` extracts the Agent SDK API key from `x-api-key` or `Authorization: Bearer ...`, resolves it against proxy-local route config, and dispatches to either the existing Codex path or a new Ollama/OpenAI-compatible backend. Orchestrel config is not modified; routing is owned entirely by proxy config/code.

**Tech Stack:** TypeScript, Express, Node built-in `fetch`, Anthropic Messages API compatibility, Ollama OpenAI-compatible `/v1/chat/completions`, Node test runner via `tsx --test`.

---

## Non-Negotiable Requirements

- Do **not** modify `/home/ryan/Code/orchestrel/config.yaml`, `config.example.yaml`, or Orchestrel code.
- Keep existing Codex behavior working for current users/routes.
- Route selection must be based on the Agent SDK API key field:
  - Prefer `x-api-key` when present.
  - Otherwise use `Authorization: Bearer <key>`.
  - If no API key is present, use the configured default route.
- Model names pass through bare. Do not add model prefixes.
- `max.local` remains unchanged. The proxy calls `http://max.local:11434/v1/chat/completions`.
- Tests come first for every new module.

---

## File Map

### New files

| File | Responsibility |
|------|----------------|
| `src/routing/routes.ts` | Parse proxy-local route config from env and resolve API keys to backend routes. |
| `src/ollama/types.ts` | Minimal OpenAI/Ollama request and response types used by the new backend. |
| `src/ollama/transformers.ts` | Convert Anthropic Messages requests/responses to and from OpenAI-compatible chat completions. |
| `src/ollama/client.ts` | Call Ollama `/v1/chat/completions`, normalize upstream errors, and return JSON/stream responses. |
| `test/routing.test.ts` | Unit tests for API-key extraction and route resolution. |
| `test/ollama-transformers.test.ts` | Unit tests for Anthropic ↔ Ollama/OpenAI conversion. |

### Modified files

| File | Changes |
|------|---------|
| `src/routes/messages.ts` | Route `/v1/messages` to Codex or Ollama based on resolved backend route. Keep existing Codex logic intact as `handleCodexMessages`. |
| `src/server.ts` | No functional change expected unless health output needs route diagnostics; do not modify unless a task explicitly says so. |
| `package.json` | No change expected; existing `npm test` already runs `tsx --test test/**/*.test.ts`. |

---

## Route Config Contract

Routes are configured by environment variables inside the proxy service, not Orchestrel.

Supported env var:

```bash
PROXY_ROUTES_JSON='{"routes":{"max":{"kind":"ollama","baseUrl":"http://max.local:11434"},"codex":{"kind":"codex"}},"defaultRoute":"codex"}'
```

Fallback when `PROXY_ROUTES_JSON` is absent:

```ts
{
  routes: {
    codex: { kind: 'codex' },
    max: { kind: 'ollama', baseUrl: process.env.MAX_OLLAMA_BASE_URL ?? 'http://max.local:11434' },
  },
  defaultRoute: 'codex',
}
```

This fallback lets implementation proceed without changing service config first. Final deployment can add explicit `PROXY_ROUTES_JSON` if desired.

---

## Task 1: Route Resolution

**Files:**
- Create: `src/routing/routes.ts`
- Test: `test/routing.test.ts`

- [ ] **Step 1: Write the failing route resolution tests**

Create `test/routing.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractRouteKey,
  loadRoutingConfigFromEnv,
  resolveBackendRoute,
  type HeaderBag,
} from '../src/routing/routes.js';

test('extractRouteKey prefers x-api-key over Authorization bearer token', () => {
  const headers: HeaderBag = {
    'x-api-key': 'max',
    authorization: 'Bearer codex',
  };

  assert.equal(extractRouteKey(headers), 'max');
});

test('extractRouteKey reads Authorization bearer token when x-api-key is absent', () => {
  const headers: HeaderBag = {
    authorization: 'Bearer max',
  };

  assert.equal(extractRouteKey(headers), 'max');
});

test('extractRouteKey returns undefined for missing or empty auth headers', () => {
  assert.equal(extractRouteKey({}), undefined);
  assert.equal(extractRouteKey({ authorization: 'Bearer   ' }), undefined);
  assert.equal(extractRouteKey({ authorization: 'Basic abc' }), undefined);
});

test('loadRoutingConfigFromEnv parses explicit JSON route config', () => {
  const config = loadRoutingConfigFromEnv({
    PROXY_ROUTES_JSON: JSON.stringify({
      defaultRoute: 'codex',
      routes: {
        codex: { kind: 'codex' },
        max: { kind: 'ollama', baseUrl: 'http://max.local:11434' },
      },
    }),
  });

  assert.deepEqual(config, {
    defaultRoute: 'codex',
    routes: {
      codex: { kind: 'codex' },
      max: { kind: 'ollama', baseUrl: 'http://max.local:11434' },
    },
  });
});

test('loadRoutingConfigFromEnv provides codex and max fallback routes', () => {
  const config = loadRoutingConfigFromEnv({
    MAX_OLLAMA_BASE_URL: 'http://max.local:11434',
  });

  assert.deepEqual(config, {
    defaultRoute: 'codex',
    routes: {
      codex: { kind: 'codex' },
      max: { kind: 'ollama', baseUrl: 'http://max.local:11434' },
    },
  });
});

test('resolveBackendRoute resolves API key route and falls back to default route', () => {
  const config = {
    defaultRoute: 'codex',
    routes: {
      codex: { kind: 'codex' as const },
      max: { kind: 'ollama' as const, baseUrl: 'http://max.local:11434' },
    },
  };

  assert.deepEqual(resolveBackendRoute('max', config), {
    routeKey: 'max',
    route: { kind: 'ollama', baseUrl: 'http://max.local:11434' },
  });
  assert.deepEqual(resolveBackendRoute(undefined, config), {
    routeKey: 'codex',
    route: { kind: 'codex' },
  });
});

test('resolveBackendRoute rejects unknown API key route', () => {
  const config = {
    defaultRoute: 'codex',
    routes: {
      codex: { kind: 'codex' as const },
    },
  };

  assert.throws(
    () => resolveBackendRoute('unknown', config),
    /Unknown proxy route key "unknown"/,
  );
});
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run:

```bash
npm test -- test/routing.test.ts
```

Expected: FAIL with a module-not-found error for `src/routing/routes.ts`.

- [ ] **Step 3: Implement route resolution**

Create `src/routing/routes.ts`:

```ts
export type HeaderValue = string | string[] | undefined;

export type HeaderBag = Record<string, HeaderValue>;

export interface CodexBackendRoute {
  kind: 'codex';
}

export interface OllamaBackendRoute {
  kind: 'ollama';
  baseUrl: string;
}

export type BackendRoute = CodexBackendRoute | OllamaBackendRoute;

export interface RoutingConfig {
  defaultRoute: string;
  routes: Record<string, BackendRoute>;
}

export interface ResolvedBackendRoute {
  routeKey: string;
  route: BackendRoute;
}

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  const direct = firstHeaderValue(headers[name]);
  if (direct) return direct;

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    return firstHeaderValue(value);
  }

  return undefined;
}

export function extractRouteKey(headers: HeaderBag): string | undefined {
  const apiKey = readHeader(headers, 'x-api-key')?.trim();
  if (apiKey) return apiKey;

  const auth = readHeader(headers, 'authorization')?.trim();
  if (!auth) return undefined;

  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBackendRoute(key: string, value: unknown): BackendRoute {
  if (!isRecord(value)) {
    throw new Error(`Route "${key}" must be an object`);
  }

  if (value.kind === 'codex') return { kind: 'codex' };

  if (value.kind === 'ollama') {
    if (typeof value.baseUrl !== 'string' || value.baseUrl.trim().length === 0) {
      throw new Error(`Ollama route "${key}" requires baseUrl`);
    }
    return { kind: 'ollama', baseUrl: value.baseUrl.replace(/\/+$/, '') };
  }

  throw new Error(`Route "${key}" has unsupported kind: ${String(value.kind)}`);
}

export function loadRoutingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  if (env.PROXY_ROUTES_JSON?.trim()) {
    const raw: unknown = JSON.parse(env.PROXY_ROUTES_JSON);
    if (!isRecord(raw)) throw new Error('PROXY_ROUTES_JSON must be an object');
    if (!isRecord(raw.routes)) throw new Error('PROXY_ROUTES_JSON.routes must be an object');

    const routes: Record<string, BackendRoute> = {};
    for (const [key, value] of Object.entries(raw.routes)) {
      routes[key] = parseBackendRoute(key, value);
    }

    const defaultRoute = typeof raw.defaultRoute === 'string' && raw.defaultRoute.trim()
      ? raw.defaultRoute.trim()
      : 'codex';

    if (!routes[defaultRoute]) {
      throw new Error(`Default proxy route "${defaultRoute}" is not configured`);
    }

    return { defaultRoute, routes };
  }

  return {
    defaultRoute: 'codex',
    routes: {
      codex: { kind: 'codex' },
      max: {
        kind: 'ollama',
        baseUrl: (env.MAX_OLLAMA_BASE_URL ?? 'http://max.local:11434').replace(/\/+$/, ''),
      },
    },
  };
}

export function resolveBackendRoute(routeKey: string | undefined, config: RoutingConfig): ResolvedBackendRoute {
  const effectiveKey = routeKey ?? config.defaultRoute;
  const route = config.routes[effectiveKey];

  if (!route) {
    const available = Object.keys(config.routes).sort().join(', ');
    throw new Error(`Unknown proxy route key "${effectiveKey}". Available routes: ${available}`);
  }

  return { routeKey: effectiveKey, route };
}
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run:

```bash
npm test -- test/routing.test.ts
```

Expected: PASS for all route tests.

- [ ] **Step 5: Commit route resolution**

```bash
git add src/routing/routes.ts test/routing.test.ts
git commit -m "feat: add api-key proxy route resolution"
```

---

## Task 2: Anthropic ↔ Ollama/OpenAI Transformers

**Files:**
- Create: `src/ollama/types.ts`
- Create: `src/ollama/transformers.ts`
- Test: `test/ollama-transformers.test.ts`

- [ ] **Step 1: Write the failing transformer tests**

Create `test/ollama-transformers.test.ts` with tests for:

1. system/message/model/stream/temperature/max token conversion
2. Anthropic tools to OpenAI function tools
3. `tool_use` and `tool_result` history conversion
4. text response conversion back to Anthropic
5. OpenAI `tool_calls` conversion back to Anthropic `tool_use`

Use exact expected objects from Task 2 implementation below.

- [ ] **Step 2: Run transformer tests to verify they fail**

Run:

```bash
npm test -- test/ollama-transformers.test.ts
```

Expected: FAIL with a module-not-found error for `src/ollama/transformers.ts`.

- [ ] **Step 3: Add Ollama/OpenAI types**

Create `src/ollama/types.ts`:

```ts
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIChatToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  tools?: OpenAIChatTool[];
  tool_choice?: OpenAIChatToolChoice;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
```

- [ ] **Step 4: Implement transformers**

Create `src/ollama/transformers.ts` using these required exported functions:

```ts
export function transformAnthropicToOllamaChat(req: AnthropicRequest): OpenAIChatCompletionRequest
export function transformOllamaChatToAnthropic(res: OpenAIChatCompletionResponse, requestedModel: string): AnthropicResponse
```

Implementation requirements:

- First message is `{ role: 'system', content: <system text> }` when `req.system` is present.
- Anthropic text blocks become OpenAI text message content.
- Anthropic `tool_use` becomes assistant `tool_calls` with JSON string `function.arguments`.
- Anthropic `tool_result` becomes `{ role: 'tool', tool_call_id, content }`.
- Anthropic tools become OpenAI `{ type: 'function', function: { name, description, parameters } }` tools.
- Anthropic `tool_choice` mapping:
  - `auto` → `'auto'`
  - `none` → `'none'`
  - `any` → `'required'`
  - `tool` → `{ type: 'function', function: { name } }`
- OpenAI finish reason mapping:
  - `tool_calls` → `tool_use`
  - `length` → `max_tokens`
  - `stop` or missing → `end_turn`

- [ ] **Step 5: Run transformer tests to verify they pass**

Run:

```bash
npm test -- test/ollama-transformers.test.ts
```

Expected: PASS for all transformer tests.

- [ ] **Step 6: Commit transformers**

```bash
git add src/ollama/types.ts src/ollama/transformers.ts test/ollama-transformers.test.ts
git commit -m "feat: add anthropic ollama transformers"
```

---

## Task 3: Ollama Client

**Files:**
- Create: `src/ollama/client.ts`

- [ ] **Step 1: Create the Ollama client**

Create `src/ollama/client.ts` with:

- `OllamaClient.createMessage(route, body)` for non-streaming calls.
- It calls `${route.baseUrl}/v1/chat/completions`.
- It sends `Content-Type: application/json`.
- It uses `transformAnthropicToOllamaChat({ ...body, stream: false })`.
- It throws `ProxyError` for non-OK upstream responses.
- It returns `transformOllamaChatToAnthropic(json, body.model)`.

- [ ] **Step 2: Run TypeScript compilation**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit Ollama client**

```bash
git add src/ollama/client.ts
git commit -m "feat: add ollama backend client"
```

---

## Task 4: Dispatch `/v1/messages` by API Key

**Files:**
- Modify: `src/routes/messages.ts`

- [ ] **Step 1: Add dispatch imports and client**

Add imports:

```ts
import { OllamaClient } from '../ollama/client.js';
import { extractRouteKey, loadRoutingConfigFromEnv, resolveBackendRoute } from '../routing/routes.js';
```

After `const codexClient = new CodexClient();`, add:

```ts
const ollamaClient = new OllamaClient();
```

- [ ] **Step 2: Move existing Codex transformation/call/logging into `handleCodexMessages(body)`**

The helper returns `Promise<AnthropicResponse>` and contains the current route logic from:

```ts
const inboundThinking = ...
```

through:

```ts
return anthropicResponse;
```

Do not change the Codex request or response mapping while moving it.

- [ ] **Step 3: Add route dispatch after request validation**

Add:

```ts
const routeKey = extractRouteKey(req.headers);
const routingConfig = loadRoutingConfigFromEnv();
const backend = resolveBackendRoute(routeKey, routingConfig);
console.log(`[chatgpt-codex-proxy] route key=${backend.routeKey} kind=${backend.route.kind} model=${body.model}`);

const anthropicResponse = backend.route.kind === 'ollama'
  ? await ollamaClient.createMessage(backend.route, body)
  : await handleCodexMessages(body);
```

Then keep the existing response writer unchanged.

- [ ] **Step 4: Map route errors through existing Anthropic error responses**

In the route `catch` block, before the `CodexApiError` branch, add:

```ts
if (error instanceof ProxyError) {
  return next(error);
}
```

- [ ] **Step 5: Run tests and build**

Run:

```bash
npm test && npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit API-key dispatch**

```bash
git add src/routes/messages.ts
git commit -m "feat: route messages by proxy api key"
```

---

## Task 5: Add Ollama Streaming Support

**Files:**
- Modify: `src/ollama/client.ts`
- Modify: `src/routes/messages.ts`

- [ ] **Step 1: Add `OllamaClient.streamMessage(route, body, res)`**

Implementation requirements:

- Calls `${route.baseUrl}/v1/chat/completions` with `stream: true`.
- Parses OpenAI-compatible SSE lines from Ollama.
- Emits Anthropic SSE events:
  - `message_start`
  - `content_block_start`
  - `content_block_delta`
  - `content_block_stop`
  - `message_delta`
  - `message_stop`
- Buffers OpenAI `tool_calls` deltas and emits Anthropic `tool_use` blocks after text completes.
- Maps stop reason using the same mapping as Task 2.
- Throws `ProxyError` before headers are written if upstream returns non-OK.

- [ ] **Step 2: Update route to use Ollama streaming directly**

In `src/routes/messages.ts`, after resolving `backend`, add:

```ts
if (backend.route.kind === 'ollama' && body.stream) {
  await ollamaClient.streamMessage(backend.route, body, res);
  return;
}
```

Leave non-streaming dispatch as:

```ts
const anthropicResponse = backend.route.kind === 'ollama'
  ? await ollamaClient.createMessage(backend.route, body)
  : await handleCodexMessages(body);
```

- [ ] **Step 3: Run build and full tests**

Run:

```bash
npm test && npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit streaming support**

```bash
git add src/ollama/client.ts src/routes/messages.ts
git commit -m "feat: stream ollama responses as anthropic sse"
```

---

## Task 6: Local Integration Smoke Tests

**Files:**
- No source changes expected.

- [ ] **Step 1: Verify max.local Ollama health**

Run:

```bash
curl -sS http://max.local:11434/api/tags | python3 -m json.tool | head -80
```

Expected: JSON output listing installed Ollama models. If this fails, do not change proxy code; fix max.local connectivity/service first.

- [ ] **Step 2: Run proxy dev server on an alternate port**

Run:

```bash
PORT=19081 MAX_OLLAMA_BASE_URL=http://max.local:11434 npm run dev
```

Expected: server logs include `chatgpt-codex-proxy listening on port 19081`.

- [ ] **Step 3: In a second terminal, test non-streaming Ollama route**

Run:

```bash
curl -sS http://127.0.0.1:19081/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: max' \
  -d '{"model":"qwen3-coder-next","max_tokens":128,"stream":false,"messages":[{"role":"user","content":"Reply with exactly: MAX_ROUTE_OK"}]}' \
  | python3 -m json.tool
```

Expected: Anthropic-shaped JSON with text containing `MAX_ROUTE_OK`.

- [ ] **Step 4: Test streaming Ollama route**

Run:

```bash
curl -N http://127.0.0.1:19081/v1/messages \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer max' \
  -d '{"model":"qwen3-coder-next","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"Reply with exactly: MAX_STREAM_OK"}]}'
```

Expected: SSE events include `message_start`, `content_block_delta`, `message_delta`, and `message_stop`; text includes `MAX_STREAM_OK`.

- [ ] **Step 5: Test default Codex route still resolves**

Run a minimal non-streaming request without `x-api-key` against the dev server:

```bash
curl -sS http://127.0.0.1:19081/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-7","max_tokens":64,"stream":false,"messages":[{"role":"user","content":"Say CODEX_ROUTE_OK"}]}' \
  | python3 -m json.tool
```

Expected: request uses Codex path. If local Codex auth is expired, expected response is Anthropic-shaped `authentication_error`, not a routing error.

---

## Task 7: Service Deployment on Home

**Files:**
- Modify only systemd environment/service config if needed. Do not change Orchestrel config.

- [ ] **Step 1: Build production JS**

Run:

```bash
npm run build
```

Expected: PASS and `dist/` updated.

- [ ] **Step 2: Inspect current systemd unit**

Run:

```bash
systemctl cat chatgpt-codex-proxy.service
```

Expected: unit points to `/home/ryan/Code/chatgpt-codex-proxy/dist/index.js` and listens on existing configured port.

- [ ] **Step 3: Add proxy-local route config only if fallback is insufficient**

If explicit service config is preferred, create a systemd override:

```bash
sudo systemctl edit chatgpt-codex-proxy.service
```

Use this exact override:

```ini
[Service]
Environment=PROXY_ROUTES_JSON={"defaultRoute":"codex","routes":{"codex":{"kind":"codex"},"max":{"kind":"ollama","baseUrl":"http://max.local:11434"}}}
```

Do not edit Orchestrel config.

- [ ] **Step 4: Restart service**

Run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart chatgpt-codex-proxy.service
systemctl status chatgpt-codex-proxy.service --no-pager
```

Expected: service is `active (running)`.

- [ ] **Step 5: Smoke test production service**

Use the service’s existing port from the unit/status output. If it is `3459`, run:

```bash
curl -sS http://127.0.0.1:3459/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: max' \
  -d '{"model":"qwen3-coder-next","max_tokens":128,"stream":false,"messages":[{"role":"user","content":"Reply with exactly: PROD_MAX_ROUTE_OK"}]}' \
  | python3 -m json.tool
```

Expected: Anthropic-shaped JSON with text containing `PROD_MAX_ROUTE_OK`.

---

## Task 8: Final Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Check git status**

Run:

```bash
git status --short
```

Expected: no unintended changes. `dist/` may be modified if tracked; include it only if this repo normally commits build output.

- [ ] **Step 4: Record memory**

Use shared memory to store the final working setup:

- title: `chatgpt-codex-proxy max.local route`
- project: `orchestrel` or `chatgpt-codex-proxy`
- content must include:
  - proxy repo path
  - route key used
  - backend URL
  - whether systemd override was needed
  - production port
  - smoke-test command that worked

---

## Self-Review

### Spec coverage

- API-key routing: Task 1 and Task 4.
- No Orchestrel config changes: Non-negotiable requirements, Task 7 explicit warning.
- Existing Codex behavior preserved: Task 4 keeps existing Codex logic and Task 6 tests default route.
- max.local Ollama backend: Task 2 transformers, Task 3 client, Task 5 streaming, Task 6 smoke tests.
- Proxy-local config: Route Config Contract and Task 7 systemd override.
- Tests first: Tasks 1 and 2 start with failing tests; Task 4/5 use build/full tests and smoke tests.

### Placeholder scan

No `TBD`, unspecified TODOs, or unsupported “handle edge cases” placeholders remain. Conditional deployment steps are explicit and command-backed.

### Type consistency

- `OllamaBackendRoute` is exported from `src/routing/routes.ts` and imported by `src/ollama/client.ts`.
- `OpenAIChatCompletionRequest`/`Response` are defined in `src/ollama/types.ts` and used by transformers/client.
- `AnthropicRequest`/`AnthropicResponse` come from existing `src/types/anthropic.ts`.
- Route dispatch uses `backend.route.kind === 'ollama'` matching the route union.
