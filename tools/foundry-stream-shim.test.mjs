import assert from "node:assert/strict";
import test from "node:test";

import { startShim, StreamRepairer } from "./foundry-stream-shim.mjs";

function toolCalls(chunks) {
  return chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || []);
}

test("rejects a non-loopback upstream", () => {
  assert.throws(
    () => startShim({ port: 0, upstream: "https://example.com" }),
    /loopback/,
  );
});

test("repairs a leaked tool call", () => {
  const repairer = new StreamRepairer({ model: "fixture" });
  const raw = `<tool_call>${JSON.stringify({
    name: "view",
    arguments: JSON.stringify({ path: "C:\\workspace\\canary.txt" }),
  })}</tool_call>`;

  const chunks = [
    ...repairer.push({ content: raw }),
    ...repairer.finish("stop"),
  ];

  assert.equal(toolCalls(chunks).length, 1);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("does not duplicate a native tool call also leaked as markup", () => {
  const repairer = new StreamRepairer({ model: "fixture" });
  const args = JSON.stringify({ path: "C:\\workspace\\canary.txt" });
  const native = {
    index: 0,
    id: "call_native",
    type: "function",
    function: { name: "view", arguments: args },
  };
  const raw = `<tool_call>${JSON.stringify({
    name: "view",
    arguments: args,
  })}</tool_call>`;

  const chunks = [
    ...repairer.push({ tool_calls: [native] }),
    ...repairer.push({ content: raw }),
    ...repairer.finish("tool_calls"),
  ];

  assert.deepEqual(toolCalls(chunks), [native]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("de-duplicates leaked markup that arrives before fragmented native arguments", () => {
  const repairer = new StreamRepairer({ model: "fixture" });
  const args = JSON.stringify({
    path: "C:\\workspace\\canary.txt",
    view_range: null,
  });
  const raw = `<tool_call>${JSON.stringify({
    name: "view",
    arguments: args,
  })}</tool_call>`;

  const chunks = [
    ...repairer.push({ content: raw }),
    ...repairer.push({
      tool_calls: [{
        index: 0,
        id: "call_native",
        type: "function",
        function: { name: "view", arguments: args.slice(0, 20) },
      }],
    }),
    ...repairer.push({
      tool_calls: [{
        index: 0,
        function: { arguments: args.slice(20) },
      }],
    }),
    ...repairer.finish("tool_calls"),
  ];

  const calls = toolCalls(chunks);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    path: "C:\\workspace\\canary.txt",
  });
});

test("drops nameless placeholder calls from a final content response", () => {
  const repairer = new StreamRepairer({ model: "fixture" });
  const chunks = [
    ...repairer.push({
      tool_calls: [
        { index: 0, id: "placeholder", function: { name: "", arguments: "null" } },
        { index: 1, id: "placeholder-2", function: { name: "", arguments: "{}" } },
      ],
    }),
    ...repairer.push({ content: '{"status":"blocked"}' }),
    ...repairer.finish("stop"),
  ];

  assert.equal(toolCalls(chunks).length, 0);
  assert.equal(
    chunks.map((chunk) => chunk.choices[0].delta.content || "").join(""),
    '{"status":"blocked"}',
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});
