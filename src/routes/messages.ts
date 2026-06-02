/*
[파일 목적]
Anthropic Messages API 형태의 요청을 받아 Codex Responses API로 프록시하고,
응답을 다시 Anthropic 형태로 변환해 반환한다.

[주요 흐름]
1. /health: 서비스 상태 및 환경 기반 설정 노출(진단 목적)
2. /v1/messages: 요청 유효성 최소 검증 → Anthropic→Codex 변환 → Codex 호출 → Codex→Anthropic 변환
3. stream=true인 경우 Anthropic SSE 이벤트(message_start/content_block_start|content_block_delta|content_block_stop/message_delta/message_stop)로 전송

[외부 연결]
- CodexClient(createResponse): 실제 Codex API 호출
- transformAnthropicToCodex / transformCodexToAnthropic: 프로토콜 변환
- ProxyError: Anthropic 호환 에러 포맷

[수정시 주의]
- SSE 이벤트 포맷/순서를 바꾸면 Anthropic SDK/클라이언트가 스트리밍을 해석하지 못할 수 있음
- 요청 검증/에러 매핑을 바꾸면 클라이언트에서 에러 타입이 달라질 수 있음
- 로그 필드명을 바꾸면 운영/디버깅 대시보드 쿼리가 깨질 수 있음
*/
import { Router, type Request, type Response, type NextFunction } from "express";
import { CodexApiError, CodexClient } from "../codex/client.js";
import { transformAnthropicToCodex } from "../transformers/request.js";
import { transformCodexToAnthropic } from "../transformers/response.js";
import type { AnthropicRequest, AnthropicResponse } from "../types/anthropic.js";
import type { CodexRequest } from "../transformers/request.js";
import { ProxyError } from "../utils/errors.js";
import { OpenAICompatibleClient } from "../openai-compatible/client.js";
import { extractRouteKey, loadRoutingConfigFromEnv, resolveBackendRoute } from "../routing/routes.js";

const router = Router();
const codexClient = new CodexClient();
const openAICompatibleClient = new OpenAICompatibleClient();

function latestMessageHasToolResult(body: AnthropicRequest): boolean {
  const latest = body.messages.at(-1);
  if (!latest || typeof latest.content === "string") return false;
  return latest.content.some((block) => block.type === "tool_result");
}

export function isEmptyZeroToolResultResponse(response: AnthropicResponse): boolean {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  if (inputTokens !== 0 || outputTokens !== 0) return false;

  const text = (response.content ?? [])
    .map((block) => block.type === "text" ? block.text ?? "" : "")
    .join("");
  const hasToolUse = (response.content ?? []).some((block) => block.type === "tool_use");
  return !hasToolUse && text.trim().length === 0;
}

export function createToolResultRetryRequest(request: CodexRequest): CodexRequest | null {
  if (!request.tools || request.tools.length === 0) return null;

  const calledToolNames = new Set<string>();
  for (const item of request.input) {
    if (item.type === "function_call" && item.name) {
      calledToolNames.add(item.name);
    }
  }

  if (calledToolNames.size === 0) return null;

  const retryTools = request.tools.filter((tool) => calledToolNames.has(tool.name));
  if (retryTools.length === request.tools.length) return null;

  return {
    ...request,
    tools: retryTools.length > 0 ? retryTools : undefined,
    tool_choice: retryTools.length > 0 ? "auto" : undefined,
    parallel_tool_calls: retryTools.length > 1 ? request.parallel_tool_calls : undefined,
  };
}

function countCodexFunctionCalls(response: { output?: Array<{ type?: string }> }): number {
  return (response.output ?? []).filter((item) => item.type === "function_call").length;
}

function countCodexOutputTextBlocks(response: { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }): number {
  return (response.output ?? []).reduce((acc, item) => {
    const parts = item.content ?? [];
    return (
      acc +
      parts.filter((part) => part.type === "output_text" && typeof part.text === "string" && part.text.length > 0).length
    );
  }, 0);
}

function countAnthropicBlocks(response: AnthropicResponse): { toolUse: number; text: number } {
  return {
    toolUse: (response.content ?? []).filter((block) => block.type === "tool_use").length,
    text: (response.content ?? []).filter((block) => block.type === "text").length,
  };
}

async function handleCodexMessages(body: AnthropicRequest): Promise<AnthropicResponse> {
  const inboundThinking = body.thinking?.type === "enabled"
    ? `enabled(budget=${body.thinking.budget_tokens ?? "?"})`
    : "disabled";
  console.log(
    `[chatgpt-codex-proxy] inbound messages model=${body.model} stream=${Boolean(body.stream)} messages=${body.messages.length} thinking=${inboundThinking}`,
  );

  // Transform and call Codex
  const codexRequest = transformAnthropicToCodex(body);

  const inboundParallel = body.parallel_tool_calls;
  const inboundToolCount = body.tools?.length ?? 0;
  const inboundToolChoice = body.tool_choice?.type ?? "none";
  const inboundToolNames = (body.tools ?? []).map((tool) => tool.name).join(",");

  console.log(
    `[chatgpt-codex-proxy] tool_plan inbound_parallel=${String(inboundParallel)} effective_parallel=${String(
      codexRequest.parallel_tool_calls,
    )} tool_count=${inboundToolCount} inbound_tool_choice=${inboundToolChoice} codex_tool_choice=${String(codexRequest.tool_choice)} tool_names=[${inboundToolNames}]`,
  );

  let codexResponse = await codexClient.createResponse(codexRequest);
  let anthropicResponse = transformCodexToAnthropic(codexResponse, body.model);

  let codexFunctionCalls = countCodexFunctionCalls(codexResponse);
  let codexOutputText = countCodexOutputTextBlocks(codexResponse);
  let anthropicBlocks = countAnthropicBlocks(anthropicResponse);

  console.log(
    `[chatgpt-codex-proxy] tool_diag parallel=${String(codexRequest.parallel_tool_calls)} codex_fn_calls=${codexFunctionCalls} codex_text_blocks=${codexOutputText} anthropic_tool_use=${anthropicBlocks.toolUse} anthropic_text_blocks=${anthropicBlocks.text} stop_reason=${anthropicResponse.stop_reason}`,
  );

  if (latestMessageHasToolResult(body) && isEmptyZeroToolResultResponse(anthropicResponse)) {
    const retryRequest = createToolResultRetryRequest(codexRequest);
    if (retryRequest) {
      const retryToolNames = (retryRequest.tools ?? []).map((tool) => tool.name).join(",");
      console.log(
        `[chatgpt-codex-proxy] tool_retry reason=empty_zero_after_tool_result original_tools=${codexRequest.tools?.length ?? 0} retry_tools=${retryRequest.tools?.length ?? 0} retry_tool_names=[${retryToolNames}]`,
      );

      codexResponse = await codexClient.createResponse(retryRequest);
      anthropicResponse = transformCodexToAnthropic(codexResponse, body.model);
      codexFunctionCalls = countCodexFunctionCalls(codexResponse);
      codexOutputText = countCodexOutputTextBlocks(codexResponse);
      anthropicBlocks = countAnthropicBlocks(anthropicResponse);

      console.log(
        `[chatgpt-codex-proxy] tool_retry_diag parallel=${String(retryRequest.parallel_tool_calls)} codex_fn_calls=${codexFunctionCalls} codex_text_blocks=${codexOutputText} anthropic_tool_use=${anthropicBlocks.toolUse} anthropic_text_blocks=${anthropicBlocks.text} stop_reason=${anthropicResponse.stop_reason}`,
      );
    }
  }

  return anthropicResponse;
}

router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "chatgpt-codex-proxy",
    timestamp: new Date().toISOString(),
    proxy_signature: process.env.CHATGPT_CODEX_PROXY_SIGNATURE ?? null,
    model_overrides: {
      haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
      sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
      opus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
    },
  });
});

router.post(
  "/v1/messages",
  async (req: Request<unknown, AnthropicResponse, AnthropicRequest>, res: Response, next: NextFunction) => {
    const body = req.body;

    try {
      // Validate request
      if (!body || typeof body !== "object") {
        throw new ProxyError("Invalid JSON body", 400, "invalid_request_error");
      }

      if (!body.model || !Array.isArray(body.messages)) {
        throw new ProxyError(
          "Missing required fields: model, messages",
          400,
          "invalid_request_error"
        );
      }

      const routeKey = extractRouteKey(req.headers);
      const routingConfig = loadRoutingConfigFromEnv();
      const backend = resolveBackendRoute(routeKey, routingConfig);
      console.log(`[chatgpt-codex-proxy] route key=${backend.routeKey} kind=${backend.route.kind} model=${body.model}`);

      if (backend.route.kind === "openai-compatible" && body.stream) {
        await openAICompatibleClient.streamMessage(backend.route, body, res);
        return;
      }

      const anthropicResponse =
        backend.route.kind === "openai-compatible"
          ? await openAICompatibleClient.createMessage(backend.route, body)
          : await handleCodexMessages(body);

      // Handle streaming
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        // message_start
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: anthropicResponse.id,
              type: "message",
              role: "assistant",
              model: anthropicResponse.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`
        );

        let blockIndex = 0;
        for (const block of anthropicResponse.content ?? []) {
          if (block.type === "text") {
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "text", text: "" },
              })}\n\n`
            );

            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: block.text ?? "" },
              })}\n\n`
            );

            res.write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: blockIndex,
              })}\n\n`
            );
            blockIndex += 1;
            continue;
          }

          if (block.type === "tool_use") {
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIndex,
                content_block: {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: {},
                },
              })}\n\n`
            );

            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input ?? {}),
                },
              })}\n\n`
            );

            res.write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: blockIndex,
              })}\n\n`
            );
            blockIndex += 1;
          }
        }

        // message_delta
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: anthropicResponse.stop_reason, stop_sequence: anthropicResponse.stop_sequence ?? null },
            usage: anthropicResponse.usage,
          })}\n\n`
        );

        // message_stop
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
        return;
      }

      // Non-streaming response
      res.status(200).json(anthropicResponse);
    } catch (error) {
      if (error instanceof ProxyError) {
        return next(error);
      }

      if (error instanceof CodexApiError) {
        if (error.status === 401) {
          return next(new ProxyError(error.message, 401, "authentication_error"));
        }
        if (error.status === 429) {
          return next(new ProxyError(error.message, 429, "rate_limit_error"));
        }
        if (error.status === 400) {
          return next(new ProxyError(error.message, 400, "invalid_request_error"));
        }
        return next(new ProxyError(error.message, 502, "api_error"));
      }

      if (error instanceof Error) {
        return next(
          new ProxyError(
            `Unhandled proxy error: ${error.message}`,
            500,
            "internal_server_error",
            {
              name: error.name,
              stack: error.stack,
            },
          ),
        );
      }

      next(new ProxyError("Unhandled proxy error", 500, "internal_server_error", { error }));
    }
  }
);

export default router;
