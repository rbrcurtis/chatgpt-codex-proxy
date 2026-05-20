export type HeaderValue = string | string[] | undefined;
export type HeaderBag = Record<string, HeaderValue>;

export interface CodexBackendRoute {
  kind: "codex";
}

export interface OllamaBackendRoute {
  kind: "ollama";
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

function getHeaderValue(headers: HeaderBag, key: string): HeaderValue {
  const normalized = key.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
}

function pickFirstString(value: HeaderValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}

export function extractRouteKey(headers: HeaderBag): string | undefined {
  const xApiKey = pickFirstString(getHeaderValue(headers, "x-api-key"))?.trim();
  if (xApiKey) {
    return xApiKey;
  }

  const authorization = pickFirstString(getHeaderValue(headers, "authorization"))?.trim();
  if (!authorization) {
    return undefined;
  }

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }

  const token = authorization.slice(7).trim();
  if (token.toLowerCase() === "dummy") {
    return undefined;
  }

  return token || undefined;
}

const FALLBACK_BASE_URL = "http://max.local:11434";

function fallbackRoutingConfig(env: NodeJS.ProcessEnv): RoutingConfig {
  return {
    defaultRoute: "codex",
    routes: {
      codex: { kind: "codex" },
      max: {
        kind: "ollama",
        baseUrl: (env.MAX_OLLAMA_BASE_URL ?? FALLBACK_BASE_URL).replace(/\/+$/, ""),
      },
    },
  };
}

export function loadRoutingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const rawConfig = env.PROXY_ROUTES_JSON;
  if (!rawConfig) {
    return fallbackRoutingConfig(env);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (err) {
    throw new Error("Invalid PROXY_ROUTES_JSON: expected valid JSON", { cause: err });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid PROXY_ROUTES_JSON: must be an object with defaultRoute and routes");
  }

  const config = parsed as Partial<{
    defaultRoute: unknown;
    routes: unknown;
  }>;

  if (typeof config.defaultRoute !== "string" || config.defaultRoute.trim() === "") {
    throw new Error("Invalid PROXY_ROUTES_JSON: defaultRoute must be a non-empty string");
  }

  if (typeof config.routes !== "object" || config.routes === null || Array.isArray(config.routes)) {
    throw new Error("Invalid PROXY_ROUTES_JSON: routes must be an object");
  }

  const routes: Record<string, BackendRoute> = {};

  for (const [routeKey, routeValue] of Object.entries(config.routes)) {
    if (typeof routeValue !== "object" || routeValue === null || Array.isArray(routeValue)) {
      throw new Error(`Invalid PROXY_ROUTES_JSON: route "${routeKey}" must be an object`);
    }

    const typedRoute = routeValue as { kind?: unknown; baseUrl?: unknown };
    if (typedRoute.kind === "codex") {
      routes[routeKey] = { kind: "codex" };
      continue;
    }

    if (typedRoute.kind === "ollama") {
      if (typeof typedRoute.baseUrl !== "string" || typedRoute.baseUrl.trim() === "") {
        throw new Error(
          `Invalid PROXY_ROUTES_JSON: route "${routeKey}" has invalid baseUrl for ollama`
        );
      }
      routes[routeKey] = {
        kind: "ollama",
        baseUrl: typedRoute.baseUrl.replace(/\/+$/, ""),
      };
      continue;
    }

    throw new Error(
      `Invalid PROXY_ROUTES_JSON: route "${routeKey}" has unsupported kind "${String(
        typedRoute.kind,
      )}"`
    );
  }

  if (!(config.defaultRoute in routes)) {
    throw new Error("Invalid PROXY_ROUTES_JSON: defaultRoute must exist in routes");
  }

  return {
    defaultRoute: config.defaultRoute,
    routes,
  };
}

export function resolveBackendRoute(
  routeKey: string | undefined,
  config: RoutingConfig,
): ResolvedBackendRoute {
  const resolvedKey = routeKey ?? config.defaultRoute;
  const route = config.routes[resolvedKey];

  if (!route) {
    throw new Error(`Unknown proxy route key "${resolvedKey}"`);
  }

  return {
    routeKey: resolvedKey,
    route,
  };
}
