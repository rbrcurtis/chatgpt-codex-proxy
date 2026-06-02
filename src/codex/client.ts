/**
 * [파일 목적]
 * 이 파일은 Codex Responses API와 직접 통신하는 클라이언트 계층이다.
 * 인증 토큰을 읽어 요청을 보내고, SSE 응답을 최종 CodexResponse 형태로 복원한다.
 *
 * [주요 흐름]
 * 1. getValidTokens로 access token과 account id를 확보한다.
 * 2. Anthropic 변환 결과(CodexRequest)를 Codex backend 형식으로 전송한다.
 * 3. 에러 응답은 상태 코드별로 CodexApiError로 정규화한다.
 * 4. SSE 스트림에서 delta/final event를 읽어 최종 응답 객체를 만든다.
 *
 * [외부 연결]
 * - ../auth.ts: 저장 토큰 조회/자동 갱신
 * - ../transformers/request.ts: CodexRequest 타입
 * - chatgpt.com/backend-api/codex/responses: 실제 호출 대상
 *
 * [수정시 주의]
 * - 헤더 이름(chatgpt-account-id, Authorization 등)을 바꾸면 인증이 실패할 수 있다.
 * - SSE 파싱 규칙을 바꾸면 정상 응답도 빈 응답이나 파싱 실패로 처리될 수 있다.
 * - 에러 매핑을 바꾸면 상위 라우트의 Anthropic 호환 에러 변환 결과가 달라진다.
 */
import { randomUUID } from "node:crypto";
import type { CodexRequest } from "../transformers/request.js";
import { getValidTokens } from "../auth.js";

const CODEX_BASE_URL = process.env.CODEX_BASE_URL ?? "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";

export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface CodexOutputContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface CodexOutputItem {
  id?: string;
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: CodexOutputContent[];
  [key: string]: unknown;
}

export interface CodexResponse {
  id: string;
  model: string;
  output: CodexOutputItem[];
  usage?: CodexUsage;
  stop_reason?: string;
  [key: string]: unknown;
}

interface SseEvent {
  event: string;
  data: string;
}

export class CodexApiError extends Error {
  public readonly status: number;
  public readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "CodexApiError";
    this.status = status;
    this.details = details;
  }
}

function parseErrorMessage(status: number, body: unknown): string {
  const bodyObj = body as { error?: { message?: string }; message?: string };
  const apiMsg = bodyObj?.error?.message ?? bodyObj?.message;
  if (typeof apiMsg === "string" && apiMsg.length > 0) return apiMsg;

  if (status === 401) return "Invalid or expired Codex token.";
  if (status === 429) return "Codex rate limit exceeded.";
  if (status === 400) return "Invalid request for Codex API.";

  return "Codex API request failed.";
}

async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;

      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = rawEvent.split("\n");
      let event = "message";
      const dataParts: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataParts.push(line.slice(5).trim());
        }
      }

      const data = dataParts.join("\n");
      if (data.length === 0) continue;

      yield { event, data };
    }
  }

  if (buffer.trim()) {
    const lines = buffer.split("\n");
    let event = "message";
    const dataParts: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
    }

    if (dataParts.length > 0) {
      yield { event, data: dataParts.join("\n") };
    }
  }
}

export class CodexClient {
  async createResponse(request: CodexRequest): Promise<CodexResponse> {
    const tokens = await getValidTokens();

    if (!tokens) {
      throw new CodexApiError("Not authenticated. Please run 'npm run login' first.", 401);
    }

    if (!tokens.chatgpt_account_id) {
      throw new CodexApiError("Could not extract ChatGPT account ID from token.", 401);
    }

    console.log(`[chatgpt-codex-proxy] Calling ${request.model} with effort=${request.reasoning.effort}`);

    const codexRequest: CodexRequest = {
      ...request,
      stream: true,
    };

    const response = await fetch(`${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokens.access_token}`,
        "chatgpt-account-id": tokens.chatgpt_account_id,
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
      },
      body: JSON.stringify(codexRequest),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }

      if (response.status === 401) {
        throw new CodexApiError("Authentication expired. Please run 'npm run login' again.", 401, parsedBody);
      }
      if (response.status === 429) {
        throw new CodexApiError("Rate limited. Please wait and try again.", 429, parsedBody);
      }
      if (response.status === 400) {
        throw new CodexApiError(`Bad request: ${body}`, 400, parsedBody);
      }

      throw new CodexApiError(parseErrorMessage(response.status, parsedBody), response.status, parsedBody);
    }

    // The backend responds as SSE here regardless of Anthropic stream mode.
    // Use one parser path so text extracted from SSE item events is preserved.
    return await this.parseSseResponse(response);
  }

  private async parseSseResponse(response: Response): Promise<CodexResponse> {
    if (!response.body) {
      throw new CodexApiError("Missing SSE response body from Codex API.", 502);
    }

    const outputTextParts: string[] = [];
    const outputTextDoneParts = new Map<string, string>();
    const contentPartTexts = new Map<string, string>();
    const outputItemTexts: string[] = [];
    const fallbackOutputItems = new Map<string, CodexOutputItem>();
    let finalResponse: CodexResponse | null = null;

    const appendUniqueText = (bucket: string[], text: unknown) => {
      if (typeof text !== "string" || text.length === 0) return;
      if (!bucket.includes(text)) bucket.push(text);
    };

    const extractMessageText = (
      content: Array<{ type?: string; text?: string; refusal?: string }> | undefined
    ): string => {
      if (!Array.isArray(content)) return "";
      return content
        .map((part) => {
          if (part.type === "output_text" && typeof part.text === "string") return part.text;
          if (part.type === "refusal" && typeof part.refusal === "string") return part.refusal;
          return "";
        })
        .filter(Boolean)
        .join("");
    };

    const getOutputItemKey = (item: {
      id?: string;
      type?: string;
      call_id?: string;
      name?: string;
    }): string => {
      if (typeof item.id === "string" && item.id.length > 0) return item.id;
      if (typeof item.call_id === "string" && item.call_id.length > 0) return `${item.type ?? "item"}:${item.call_id}`;
      if (typeof item.name === "string" && item.name.length > 0) return `${item.type ?? "item"}:${item.name}`;
      return randomUUID();
    };

    const upsertFallbackItem = (item: CodexOutputItem) => {
      const key = getOutputItemKey(item);
      const prev = fallbackOutputItems.get(key);
      fallbackOutputItems.set(key, prev ? { ...prev, ...item } : item);
    };

    for await (const event of parseSseStream(response.body)) {
      if (event.data === "[DONE]") break;

      let parsed: {
        type?: string;
        delta?: string;
        text?: string;
        item_id?: string;
        content_index?: number;
        response?: CodexResponse;
        item?: {
          id?: string;
          type?: string;
          role?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
          content?: Array<{ type?: string; text?: string; refusal?: string }>;
        };
        part?: { type?: string; text?: string; refusal?: string };
      };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }

      // Accumulate text deltas
      if (
        (parsed.type === "response.output_text.delta" || parsed.type === "response.refusal.delta") &&
        typeof parsed.delta === "string"
      ) {
        outputTextParts.push(parsed.delta);
      }

      if (
        parsed.type === "response.output_text.done" &&
        typeof parsed.text === "string" &&
        typeof parsed.item_id === "string"
      ) {
        const key = `${parsed.item_id}:${parsed.content_index ?? 0}`;
        outputTextDoneParts.set(key, parsed.text);
      }

      if (
        (parsed.type === "response.content_part.added" || parsed.type === "response.content_part.done") &&
        typeof parsed.item_id === "string"
      ) {
        const key = `${parsed.item_id}:${parsed.content_index ?? 0}`;
        const text =
          parsed.part?.type === "output_text"
            ? parsed.part.text
            : parsed.part?.type === "refusal"
              ? parsed.part.refusal
              : undefined;
        if (typeof text === "string" && text.length > 0) {
          contentPartTexts.set(key, text);
        }
      }

      if (
        (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") &&
        parsed.item?.type === "message"
      ) {
        appendUniqueText(outputItemTexts, extractMessageText(parsed.item.content));
        upsertFallbackItem({
          id: parsed.item.id,
          type: "message",
          role: parsed.item.role ?? "assistant",
          content:
            parsed.item.content
              ?.filter((part): part is { type: string; text?: string; refusal?: string } => typeof part.type === "string")
              .map((part) => ({ ...part })) ?? [],
        });
      }

      if (
        (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") &&
        parsed.item?.type === "function_call"
      ) {
        upsertFallbackItem({
          id: parsed.item.id,
          type: "function_call",
          call_id: parsed.item.call_id,
          name: parsed.item.name,
          arguments: parsed.item.arguments,
        });
      }

      // Capture final response
      if ((parsed.type === "response.done" || parsed.type === "response.completed") && parsed.response) {
        finalResponse = parsed.response;
      }
    }

    const fallbackText =
      outputItemTexts.find((text) => text.length > 0) ??
      [...outputTextDoneParts.values()].find((text) => text.length > 0) ??
      [...contentPartTexts.values()].find((text) => text.length > 0) ??
      outputTextParts.join("");
    const fallbackItems = [...fallbackOutputItems.values()];

    if (finalResponse) {
      finalResponse.output = Array.isArray(finalResponse.output) ? finalResponse.output : [];

      if (finalResponse.output.length === 0 && fallbackItems.length > 0) {
        finalResponse.output = fallbackItems;
      } else if (fallbackItems.length > 0) {
        const existingKeys = new Set(finalResponse.output.map((item) => getOutputItemKey(item)));
        for (const item of fallbackItems) {
          const key = getOutputItemKey(item);
          if (!existingKeys.has(key)) {
            finalResponse.output.push(item);
          }
        }
      }

      const messageItem = finalResponse.output.find((item) => item.type === "message");
      if (fallbackText && !messageItem) {
        finalResponse.output = [
          ...finalResponse.output,
          {
            role: "assistant",
            type: "message",
            content: [{ type: "output_text", text: fallbackText }],
          },
        ];
        return finalResponse;
      }

      if (fallbackText && messageItem) {
        messageItem.content ??= [];
        const outputTextContent = messageItem.content.find((part) => part.type === "output_text");
        if (!outputTextContent) {
          messageItem.content.push({ type: "output_text", text: fallbackText });
        } else if (typeof outputTextContent.text !== "string" || outputTextContent.text.length === 0) {
          outputTextContent.text = fallbackText;
        }
      }

      return finalResponse;
    }

    // Fallback: construct response from accumulated text
    return {
      id: randomUUID(),
      model: "codex",
      output: fallbackItems.length > 0
        ? fallbackItems
        : [
            {
              role: "assistant",
              type: "message",
              content: [{ type: "output_text", text: fallbackText }],
            },
          ],
      stop_reason: "end_turn",
    };
  }
}
