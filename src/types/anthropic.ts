/**
 * [파일 목적]
 * 이 파일은 Anthropic Messages API와 호환되는 요청/응답 타입을 정의한다.
 * 프록시의 라우트, 요청 변환기, 응답 변환기가 공통으로 참조하는 계약 계층이다.
 *
 * [주요 흐름]
 * 1. 텍스트/이미지/tool_use/tool_result content block 타입을 정의한다.
 * 2. 요청 본문(AnthropicRequest)과 응답 본문(AnthropicResponse) 구조를 고정한다.
 * 3. tool_choice, usage 등 주변 프로토콜 타입을 공유한다.
 *
 * [외부 연결]
 * - routes/messages.ts: HTTP 요청/응답 타입 사용
 * - transformers/request.ts: Anthropic → Codex 변환 입력 타입
 * - transformers/response.ts: Codex → Anthropic 변환 출력 타입
 *
 * [수정시 주의]
 * - 필드명이나 union 타입을 바꾸면 변환기와 라우트가 함께 깨질 수 있다.
 * - tool_use/tool_result 구조 변경은 도구 호출 연쇄의 호환성에 직접 영향이 있다.
 */
export type MessageRole = "user" | "assistant" | "system";

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageSource {
  type: "base64";
  media_type: string;
  data: string;
}

export interface ImageContentBlock {
  type: "image";
  source: ImageSource;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock;

export interface AnthropicMessage {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface AnthropicThinking {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | ContentBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  parallel_tool_calls?: boolean;
  thinking?: AnthropicThinking;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" | "any" | "none" }
  | { type: "tool"; name: string };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence?: string | null;
  usage: Usage;
}
