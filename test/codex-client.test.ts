import test from "node:test";
import assert from "node:assert/strict";

import { CodexClient, type CodexResponse } from "../src/codex/client.js";
import { transformCodexToAnthropic } from "../src/transformers/response.js";

interface CodexClientWithParser {
  parseSseResponse(response: Response): Promise<CodexResponse>;
}

function sseResponse(events: unknown[], separator = "\n\n"): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}${separator}`));
        }
        controller.enqueue(encoder.encode(`data: [DONE]${separator}`));
        controller.close();
      },
    }),
  );
}

test("parseSseResponse handles a final response without output", async () => {
  const client = new CodexClient() as unknown as CodexClientWithParser;

  const response = await client.parseSseResponse(
    sseResponse([
      {
        type: "response.output_text.delta",
        delta: "OK",
      },
      {
        type: "response.done",
        response: {
          id: "resp-1",
          model: "gpt-5.4-mini",
          usage: {
            input_tokens: 4,
            output_tokens: 1,
          },
        },
      },
    ]),
  );

  assert.equal(response.id, "resp-1");
  assert.equal(response.model, "gpt-5.4-mini");
  assert.deepEqual(response.output, [
    {
      role: "assistant",
      type: "message",
      content: [{ type: "output_text", text: "OK" }],
    },
  ]);
});

test("parseSseResponse accepts CRLF event separators", async () => {
  const client = new CodexClient() as unknown as CodexClientWithParser;

  const response = await client.parseSseResponse(
    sseResponse(
      [
        {
          type: "response.output_text.delta",
          delta: "OK",
        },
        {
          type: "response.completed",
          response: {
            id: "resp-crlf",
            model: "gpt-5.6-sol",
            output: [],
            usage: {
              input_tokens: 4,
              output_tokens: 1,
            },
          },
        },
      ],
      "\r\n\r\n",
    ),
  );

  assert.equal(response.id, "resp-crlf");
  assert.equal(response.output[0]?.content?.[0]?.text, "OK");
});

test("parseSseResponse rejects a failed terminal response", async () => {
  const client = new CodexClient() as unknown as CodexClientWithParser;

  await assert.rejects(
    client.parseSseResponse(
      sseResponse([
        {
          type: "response.failed",
          response: {
            id: "resp-failed",
            model: "gpt-5.6-sol",
            output: [],
            error: {
              code: "server_error",
              message: "The upstream worker stopped.",
            },
          },
        },
      ]),
    ),
    /server_error: The upstream worker stopped/,
  );
});

test("parseSseResponse rejects an upstream error event", async () => {
  const client = new CodexClient() as unknown as CodexClientWithParser;

  await assert.rejects(
    client.parseSseResponse(
      sseResponse([
        {
          type: "error",
          error: {
            type: "service_unavailable_error",
            code: "server_is_overloaded",
            message: "Our servers are currently overloaded. Please try again later.",
          },
        },
      ]),
    ),
    /server_is_overloaded: Our servers are currently overloaded/,
  );
});

test("parseSseResponse rejects a stream without a terminal response", async () => {
  const client = new CodexClient() as unknown as CodexClientWithParser;

  await assert.rejects(
    client.parseSseResponse(
      sseResponse([
        {
          type: "response.output_text.delta",
          delta: "partial",
        },
      ]),
    ),
    /ended before a terminal response event/,
  );
});

test("parseSseResponse maps an incomplete response to max_tokens", async () => {
  const client = new CodexClient() as unknown as CodexClientWithParser;

  const response = await client.parseSseResponse(
    sseResponse([
      {
        type: "response.incomplete",
        response: {
          id: "resp-incomplete",
          model: "gpt-5.6-sol",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Partial answer" }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
          },
          incomplete_details: {
            reason: "max_output_tokens",
          },
        },
      },
    ]),
  );

  const anthropic = transformCodexToAnthropic(response, "gpt-5.6-sol");

  assert.equal(response.id, "resp-incomplete");
  assert.equal(anthropic.content[0]?.type, "text");
  assert.equal(anthropic.stop_reason, "max_tokens");
});
