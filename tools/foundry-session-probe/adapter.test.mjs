import assert from "node:assert/strict";
import test from "node:test";

import {
  addOpenAiMessages,
  addOpenAiTools,
  selectedOpenAiTools,
  startAdapter,
  stripToolCallMarkup,
  toOpenAiFinishReason,
  toRequestOptions,
  unwrapNonToolCallEnvelope,
} from "./adapter.mjs";

test("maps OpenAI messages including tool history", () => {
  const items = [];
  const request = {
    addItem(item) {
      items.push(item);
      return this;
    },
  };

  addOpenAiMessages(request, [
    { role: "system", content: "Use tools." },
    { role: "user", content: "Read the file." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          function: { name: "view", arguments: '{"path":"a.txt"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "hello" },
  ]);

  assert.deepEqual(
    items.map((item) => item.type),
    ["message", "message", "toolCall", "toolResult"],
  );
  assert.equal(items[2].name, "view");
  assert.equal(items[3].result, "hello");
});

test("maps OpenAI function tools", () => {
  const definitions = [];
  const session = {
    addToolDefinition(definition) {
      definitions.push(definition);
      return this;
    },
  };

  addOpenAiTools(session, [
    {
      type: "function",
      function: {
        name: "view",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ]);

  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, "view");
  assert.deepEqual(JSON.parse(definitions[0].jsonSchema).required, ["path"]);
});

test("maps completion options", () => {
  assert.deepEqual(
    toRequestOptions({
      max_tokens: 64,
      temperature: 0,
      top_p: 0.9,
      tool_choice: "required",
    }),
    {
      search: { maxOutputTokens: 64, temperature: 0, topP: 0.9 },
      toolChoice: "required",
    },
  );
});

test("maps a named OpenAI tool choice to required", () => {
  assert.equal(
    toRequestOptions({
      tool_choice: { type: "function", function: { name: "view" } },
    }).toolChoice,
    "required",
  );
});

test("restricts registered tools for a named tool choice", () => {
  const tools = [
    { type: "function", function: { name: "view" } },
    { type: "function", function: { name: "glob" } },
  ];
  assert.deepEqual(
    selectedOpenAiTools(tools, {
      type: "function",
      function: { name: "view" },
    }),
    [tools[0]],
  );
  assert.throws(
    () =>
      selectedOpenAiTools(tools, {
        type: "function",
        function: { name: "missing" },
      }),
    /not uniquely defined/,
  );
});

test("preserves terminal completion reasons", () => {
  assert.equal(toOpenAiFinishReason("toolCalls"), "tool_calls");
  assert.equal(toOpenAiFinishReason("stop"), "stop");
  assert.equal(toOpenAiFinishReason("length"), "length");
  assert.throws(() => toOpenAiFinishReason("error"), /ended generation with an error/);
  assert.throws(() => toOpenAiFinishReason("none"), /without a terminal reason/);
});

test("strips duplicated tool markup from non-streaming text", () => {
  assert.equal(
    stripToolCallMarkup(
      '<tool_call>[{"name":"view","parameters":{"path":"a.txt"}}]</tool_call>',
    ),
    "",
  );
});

test("unwraps a final JSON answer mislabeled as tool markup", () => {
  assert.equal(
    unwrapNonToolCallEnvelope(
      '<tool_call>{"status":"blocked","answer":null}</tool_call>',
    ),
    '{"status":"blocked","answer":null}',
  );
});

test("preserves a real tool payload envelope", () => {
  const value =
    '<tool_call>{"name":"view","arguments":{"path":"a.txt"}}</tool_call>';
  assert.equal(unwrapNonToolCallEnvelope(value), value);
});

test("rejects a non-loopback bind", async () => {
  await assert.rejects(
    startAdapter({ host: "0.0.0.0" }),
    /must bind to a loopback host/,
  );
});
