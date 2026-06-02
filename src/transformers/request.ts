/*
[파일 목적]
Anthropic Messages API 요청(AnthropicRequest)을 Codex Responses API 요청(CodexRequest)으로 변환한다.

[주요 흐름]
1. 모델명 매핑(Anthropic → Codex) 및 reasoning effort 산정
2. system/messages/tools/tool_choice 등 입력을 Codex 스키마에 맞게 정규화
3. Anthropic tool 사용/결과 블록을 Codex function_call/function_call_output으로 변환

[외부 연결]
- codex/models(mapAnthropicModelToCodex, getEffortForModel)
- types/anthropic(AnthropicRequest 등)

[수정시 주의]
- tools/tool_choice/parallel_tool_calls 정규화는 모델의 도구 호출 행동에 직접 영향
- message/tool_result/tool_use 변환 규칙을 바꾸면 대화/툴 실행 연결(call_id)이 깨질 수 있음
- 이 프록시는 대화 기록/툴 목록을 줄이지 않는다. compaction/선택 정책은 호출 harness 책임이다.
*/
import { mapAnthropicModelToCodex, getEffortForModel } from "../codex/models.js";
import type {
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  ContentBlock,
} from "../types/anthropic.js";

export interface CodexTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type CodexToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

export interface CodexInputMessage {
  type: "message";
  role: "user" | "assistant";
  content: string | CodexInputContentPart[];
}

export interface CodexInputTextPart {
  type: "input_text" | "output_text";
  text: string;
}

export interface CodexInputImagePart {
  type: "input_image";
  image_url: string;
}

export type CodexInputContentPart = CodexInputTextPart | CodexInputImagePart;

export interface CodexFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface CodexFunctionCallInput {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export type CodexInputItem = CodexInputMessage | CodexFunctionCallOutput | CodexFunctionCallInput;

export interface CodexRequest {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  stream: boolean;
  store: boolean;
  reasoning: { effort: string; summary: string };
  text: { verbosity: string };
  tools?: CodexTool[];
  tool_choice?: CodexToolChoice;
  parallel_tool_calls?: boolean;
}

const MUTATING_TOOL_NAME_PATTERNS = [
  /(^|[_-])edit($|[_-])/i,
  /(^|[_-])update($|[_-])/i,
  /(^|[_-])write($|[_-])/i,
  /(^|[_-])replace($|[_-])/i,
  /(^|[_-])delete($|[_-])/i,
  /(^|[_-])create($|[_-])/i,
  /(^|[_-])insert($|[_-])/i,
  /(^|[_-])move($|[_-])/i,
  /(^|[_-])rename($|[_-])/i,
];

/*
[목적]
도구 이름만 보고(휴리스틱) "상태를 바꾸는(mutating)" 성격의 도구인지 판단한다.
Codex에서 parallel_tool_calls를 그대로 허용하면, 이런 도구들이 동시에 실행되어
의도치 않은 순서 문제/경쟁 조건이 생길 수 있어 방어적으로 감지한다.

[입력]
- name: 툴 이름 문자열(예: "Edit", "write_file", "db-update")

[출력]
- true: 이름 패턴상 변경/생성/삭제/이동 등 변형 가능성이 큰 도구로 판단
- false: 그 외

[연결]
- MUTATING_TOOL_NAME_PATTERNS: 변경성 도구 이름 패턴 목록
- shouldDisableParallelToolCalls: parallel 허용 여부 결정에서 사용

[주의]
- 이름 기반 휴리스틱이라 오탐/미탐 가능(정확한 권한 모델이 아님)

[수정시 영향]
- parallel_tool_calls 비활성화 조건이 바뀌며, 툴 실행 순서/동시성에 영향
*/
function isMutatingToolName(name: string): boolean {
  return MUTATING_TOOL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/*
[목적]
Anthropic 요청의 parallel_tool_calls 설정을 그대로 전달할지 판단한다.
특히 "변경성(mutating)" 도구가 포함되면 병렬 실행은 순서 의존 버그를 만들 수 있어
parallel_tool_calls를 비활성화한다.

[입력]
- anthropic: 원본 AnthropicRequest

[출력]
- true: 병렬 툴 호출을 비활성화해야 함(안전 우선)
- false: 원본 설정을 유지해도 됨

[연결]
- isMutatingToolName: 변경성 도구 판단
- transformAnthropicToCodex: parallel_tool_calls 최종값 계산에 사용

[주의]
- 이 로직은 "안전한 기본값"을 목표로 한 휴리스틱이며, 최적 성능을 보장하지 않음

[수정시 영향]
- parallel_tool_calls 전달 여부가 바뀌며, 도구 호출 동시성/응답 시간/행동이 달라질 수 있음
*/
function shouldDisableParallelToolCalls(anthropic: AnthropicRequest): boolean {
  if (!anthropic.parallel_tool_calls) return false;

  const mutatingTools = (anthropic.tools ?? []).filter((tool) => isMutatingToolName(tool.name));
  if (mutatingTools.length > 0) return true;

  if (anthropic.tool_choice?.type === "tool") {
    return isMutatingToolName(anthropic.tool_choice.name);
  }

  return false;
}

function flattenContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";

  if (typeof content === "string") return content;

  return content
    .map((block) => {
      if (block.type === "text" && block.text) return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!isPlainObject(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeJsonSchema(child);
  }

  if (typeof normalized.additionalProperties !== "undefined" && typeof normalized.additionalProperties !== "boolean") {
    normalized.additionalProperties = true;
  }

  if (normalized.type === "object") {
    if (!isPlainObject(normalized.properties)) {
      normalized.properties = {};
    }
    if (!Array.isArray(normalized.required)) {
      delete normalized.required;
    }
    if (typeof normalized.additionalProperties === "undefined") {
      normalized.additionalProperties = true;
    }
  }

  return normalized;
}

function normalizeToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalizedValue = normalizeJsonSchema(schema);
  const normalized: Record<string, unknown> = isPlainObject(normalizedValue) ? normalizedValue : {};

  if (typeof normalized.type !== "string") {
    normalized.type = "object";
  }

  if (normalized.type === "object") {
    if (!isPlainObject(normalized.properties)) {
      normalized.properties = {};
    }
    if (!Array.isArray(normalized.required)) {
      delete normalized.required;
    }
    if (typeof normalized.additionalProperties === "undefined") {
      normalized.additionalProperties = true;
    }
  }

  return normalized;
}

function mapAnthropicToolToCodexTool(tool: AnthropicTool): CodexTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParameters(tool.input_schema),
  };
}

function mapToolChoice(choice: AnthropicToolChoice | undefined, hasTools: boolean): CodexToolChoice | undefined {
  if (!choice) {
    // If no tool_choice is specified but we have tools, default to "auto"
    return hasTools ? "auto" : undefined;
  }
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", name: choice.name };
  return "auto";
}

/*
[목적]
Anthropic의 message content(텍스트/툴 사용/툴 결과/이미지 등)를 Codex input item들의 시퀀스로 변환한다.
메시지 텍스트는 message item으로, tool_use/tool_result는 function_call/function_call_output으로 매핑한다.

[입력]
- role: 메시지 발화자("user" | "assistant")
- content: Anthropic의 content(문자열 또는 ContentBlock 배열)

[출력]
- CodexInputItem[]: Codex가 이해할 수 있는 입력 아이템 목록
  - message: 텍스트/이미지 파트 묶음
  - function_call: tool_use에 대응(call_id로 이후 tool_result와 연결)
  - function_call_output: tool_result에 대응(call_id로 tool_use와 연결)

[연결]
- flattenContent: tool_result의 복합 content를 문자열로 평탄화
- serializeUnknown: tool_use input을 JSON 문자열로 직렬화
- transformAnthropicToCodex: messages를 input으로 변환할 때 사용

[주의]
- tool_use/tool_result의 call_id(tool_use_id)는 대화/도구 실행 연결의 핵심 키
- 텍스트 파트는 연속 구간을 하나의 message로 묶어 불필요한 메시지 분할을 줄임

[수정시 영향]
- 도구 호출 연쇄(툴 사용 ↔ 툴 결과) 연결이 깨질 수 있으므로 통합 스모크 테스트 필수
*/
function contentToInputItems(role: "user" | "assistant", content: string | ContentBlock[]): CodexInputItem[] {
  const textPartType: CodexInputTextPart["type"] = role === "assistant" ? "output_text" : "input_text";

  if (typeof content === "string") {
    const text = content.trim();
    return text.length > 0 ? [{ type: "message", role, content: [{ type: textPartType, text }] }] : [];
  }

  const items: CodexInputItem[] = [];
  const blocks: ContentBlock[] = content;
  const messageParts: CodexInputContentPart[] = [];

  const flushMessageParts = () => {
    if (messageParts.length === 0) return;
    items.push({
      type: "message",
      role,
      content: [...messageParts],
    });
    messageParts.length = 0;
  };

  for (const block of blocks) {
    if (block.type === "text") {
      const text = block.text?.trim();
      if (!text) continue;
      messageParts.push({ type: textPartType, text });
      continue;
    }

    if (block.type === "tool_result") {
      flushMessageParts();
      const output =
        typeof block.content === "undefined"
          ? block.is_error
            ? "Tool execution failed"
            : ""
          : typeof block.content === "string"
            ? block.content
            : flattenContent(block.content);
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output,
      });
      continue;
    }

    if (block.type === "tool_use") {
      flushMessageParts();
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: serializeUnknown(block.input ?? {}),
      });
      continue;
    }

    if (block.type === "image") {
      const mediaType = block.source?.media_type?.trim();
      const base64Data = block.source?.data?.trim();
      if (mediaType && base64Data) {
        messageParts.push({
          type: "input_image",
          image_url: `data:${mediaType};base64,${base64Data}`,
        });
      }
    }
  }

  flushMessageParts();

  return items;
}

function extractSystemPrompt(system: string | ContentBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;

  return system
    .map((block) => {
      if (block.type === "text" && block.text) return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/*
[목적]
Anthropic Messages API 요청을 Codex Responses API 요청으로 변환한다.
프로토콜 차이(도구 스키마, tool_choice 값, 입력 아이템 구조)를 흡수한다.

[입력]
- anthropic: 클라이언트가 보낸 AnthropicRequest

[출력]
- CodexRequest: CodexClient.createResponse에 바로 전달 가능한 형태

[연결]
- mapAnthropicModelToCodex/getEffortForModel: 모델/추론 설정 매핑
- contentToInputItems: messages → input 변환
- mapAnthropicToolToCodexTool/mapToolChoice: tools/tool_choice 매핑
- shouldDisableParallelToolCalls: 안전 제약 적용

[주의]
- messages/tools 는 호출자가 보낸 값을 그대로 변환한다. compaction/선택 정책은 호출 harness 책임이다.
- tool_choice 기본값은 tools 존재 여부에 따라 달라짐("auto" 기본)

[수정시 영향]
- API 호환성(400 오류), 툴 호출 행동, 스트리밍 응답 형태까지 연쇄적으로 영향
- scripts/tool_calling_smoke.py 등 스모크 테스트 갱신 필요 가능
*/
export function transformAnthropicToCodex(anthropic: AnthropicRequest): CodexRequest {
  const codexModel = mapAnthropicModelToCodex(anthropic.model);
  const effort = getEffortForModel(codexModel);

  let systemInstruction = extractSystemPrompt(anthropic.system).trim();

  const input: CodexInputItem[] = [];
  for (const msg of anthropic.messages ?? []) {
    if (msg.role === "system") {
      const text = extractSystemPrompt(msg.content).trim();
      if (text) {
        systemInstruction = systemInstruction ? `${systemInstruction}\n\n${text}` : text;
      }
      continue;
    }

    input.push(...contentToInputItems(msg.role, msg.content));
  }

  const tools = anthropic.tools?.map(mapAnthropicToolToCodexTool);

  const hasTools = !!(tools && tools.length > 0);
  const toolChoice = mapToolChoice(anthropic.tool_choice, hasTools);

  const disableParallelToolCalls = shouldDisableParallelToolCalls(anthropic);
  const parallelToolCalls = disableParallelToolCalls ? undefined : anthropic.parallel_tool_calls;

  return {
    model: codexModel,
    instructions: systemInstruction,
    input,
    stream: Boolean(anthropic.stream),
    store: false,
    reasoning: { effort, summary: "auto" },
    text: { verbosity: "medium" },
    tools: hasTools ? tools : undefined,
    tool_choice: toolChoice,
    parallel_tool_calls: parallelToolCalls,
  };
}
