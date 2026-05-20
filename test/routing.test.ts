import test from "node:test";
import assert from "node:assert/strict";

import {
  extractRouteKey,
  loadRoutingConfigFromEnv,
  resolveBackendRoute,
  type HeaderBag,
} from "../src/routing/routes.js";

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
      '{"defaultRoute":"max","routes":{"codex":{"kind":"codex"},"max":{"kind":"ollama","baseUrl":"http://example.local/"}}}',
  };

  const config = loadRoutingConfigFromEnv(env);

  assert.equal(config.defaultRoute, "max");
  assert.equal(config.routes.codex.kind, "codex");
  assert.equal(config.routes.max.kind, "ollama");
  assert.equal(config.routes.max.baseUrl, "http://example.local");
});

test("loadRoutingConfigFromEnv falls back to default config when env is empty", () => {
  const env = {
    MAX_OLLAMA_BASE_URL: "http://custom.max/",
  };

  const config = loadRoutingConfigFromEnv(env);

  assert.equal(config.defaultRoute, "codex");
  assert.equal(config.routes.codex.kind, "codex");
  assert.equal(config.routes.max.kind, "ollama");
  assert.equal(config.routes.max.baseUrl, "http://custom.max");
});

test("loadRoutingConfigFromEnv uses default max base URL when MAX_OLLAMA_BASE_URL is missing", () => {
  const config = loadRoutingConfigFromEnv({});

  assert.equal(config.routes.max.baseUrl, "http://max.local:11434");
});

test("resolveBackendRoute resolves explicit route key and default route", () => {
  const config = loadRoutingConfigFromEnv({
    PROXY_ROUTES_JSON:
      '{"defaultRoute":"codex","routes":{"codex":{"kind":"codex"},"max":{"kind":"ollama","baseUrl":"http://max.local"}}}',
  });

  const explicit = resolveBackendRoute("max", config);
  assert.equal(explicit.routeKey, "max");
  assert.equal(explicit.route.kind, "ollama");

  const fallback = resolveBackendRoute(undefined, config);
  assert.equal(fallback.routeKey, "codex");
  assert.equal(fallback.route.kind, "codex");
});

test("resolveBackendRoute rejects unknown keys", () => {
  const config = loadRoutingConfigFromEnv({});

  assert.throws(
    () => resolveBackendRoute("unknown", config),
    /Unknown proxy route key "unknown"/,
  );
});
