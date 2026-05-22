import test from "node:test";
import assert from "node:assert/strict";

import {
  extractRouteKey,
  loadRoutingConfigFromEnv,
  resolveBackendRoute,
  type HeaderBag,
} from "../src/routing/routes.js";
import { ProxyError } from "../src/utils/errors.js";

test("extractRouteKey prefers x-api-key over Authorization", () => {
  const headers: HeaderBag = {
    "x-api-key": "max-key",
    Authorization: "Bearer other",
  };

  assert.equal(extractRouteKey(headers), "max-key");
});

test("extractRouteKey reads bearer token when x-api-key is absent", () => {
  const headers: HeaderBag = {
    authorization: "  Bearer  token-123  ",
    "x-api-key": undefined,
  };

  assert.equal(extractRouteKey(headers), "token-123");
});

test("extractRouteKey ignores dummy bearer placeholder", () => {
  const headers: HeaderBag = {
    authorization: "Bearer dummy",
  };

  assert.equal(extractRouteKey(headers), undefined);
});

test("extractRouteKey returns undefined for missing or empty credentials", () => {
  assert.equal(extractRouteKey({}), undefined);
  assert.equal(
    extractRouteKey({ Authorization: "", "x-api-key": ["", "ignored"] }),
    undefined,
  );
  assert.equal(extractRouteKey({ authorization: "Token abc" }), undefined);
});

test("loadRoutingConfigFromEnv parses PROXY_ROUTES_JSON", () => {
  const env = {
    PROXY_ROUTES_JSON:
      '{"defaultRoute":"max","routes":{"codex":{"kind":"codex"},"max":{"kind":"openai-compatible","baseUrl":"http://example.local/","apiKey":"test-key"}}}',
  };

  const config = loadRoutingConfigFromEnv(env);

  assert.equal(config.defaultRoute, "max");
  assert.equal(config.routes.codex.kind, "codex");
  assert.equal(config.routes.max.kind, "openai-compatible");
  assert.equal(config.routes.max.baseUrl, "http://example.local");
  assert.equal(config.routes.max.apiKey, "test-key");
});

test("loadRoutingConfigFromEnv falls back to default config when env is empty", () => {
  const env = {
    MAX_MLX_BASE_URL: "http://custom.max/",
    MAX_MLX_API_KEY: "local-key",
  };

  const config = loadRoutingConfigFromEnv(env);

  assert.equal(config.defaultRoute, "codex");
  assert.equal(config.routes.codex.kind, "codex");
  assert.equal(config.routes.max.kind, "openai-compatible");
  assert.equal(config.routes.max.baseUrl, "http://custom.max");
  assert.equal(config.routes.max.apiKey, "local-key");
});

test("loadRoutingConfigFromEnv uses default Max MLX base URL when MAX_MLX_BASE_URL is missing", () => {
  const config = loadRoutingConfigFromEnv({});

  assert.equal(config.routes.max.baseUrl, "http://max.local:8000");
});

test("resolveBackendRoute resolves explicit route key and default route", () => {
  const config = loadRoutingConfigFromEnv({
    PROXY_ROUTES_JSON:
      '{"defaultRoute":"codex","routes":{"codex":{"kind":"codex"},"max":{"kind":"openai-compatible","baseUrl":"http://max.local"}}}',
  });

  const explicit = resolveBackendRoute("max", config);
  assert.equal(explicit.routeKey, "max");
  assert.equal(explicit.route.kind, "openai-compatible");

  const fallback = resolveBackendRoute(undefined, config);
  assert.equal(fallback.routeKey, "codex");
  assert.equal(fallback.route.kind, "codex");
});

test("resolveBackendRoute rejects unknown keys", () => {
  const config = loadRoutingConfigFromEnv({});

  assert.throws(
    () => resolveBackendRoute("unknown", config),
    (err: unknown) =>
      err instanceof ProxyError &&
      err.statusCode === 400 &&
      err.errorType === "invalid_request_error" &&
      err.message === 'Unknown proxy route key "unknown"',
  );
});

test("loadRoutingConfigFromEnv fallback only includes ChatGPT and Max MLX routes", () => {
  const config = loadRoutingConfigFromEnv({});

  assert.deepEqual(Object.keys(config.routes).sort(), ["codex", "max"]);
});

test("loadRoutingConfigFromEnv parses optional OpenAI-compatible route settings", () => {
  const config = loadRoutingConfigFromEnv({
    PROXY_ROUTES_JSON:
      '{"defaultRoute":"codex","routes":{"codex":{"kind":"codex"},"worker":{"kind":"openai-compatible","baseUrl":"http://max.local/","model":"qwen3-coder:30b-a3b-q8_0","apiKey":"local-key"}}}',
  });

  const route = config.routes.worker;
  assert.equal(route.kind, "openai-compatible");
  if (route.kind !== "openai-compatible") {
    throw new Error("worker route should be openai-compatible");
  }

  assert.equal(route.baseUrl, "http://max.local");
  assert.equal(route.model, "qwen3-coder:30b-a3b-q8_0");
  assert.equal(route.apiKey, "local-key");
});
