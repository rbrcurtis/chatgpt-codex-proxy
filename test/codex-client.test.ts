import test from "node:test";
import assert from "node:assert/strict";

import { CodexClient, type CodexResponse } from "../src/codex/client.js";

interface CodexClientWithParser {
  parseSseResponse(response: Response): Promise<CodexResponse>;
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
