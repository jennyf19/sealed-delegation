import assert from "node:assert/strict";
import test from "node:test";

import {
  addOpenAiMessages,
  addOpenAiTools,
  selectedOpenAiTools,
  startAdapter,
  startAdapterServer,
  stripToolCallMarkup,
  toOpenAiFinishReason,
  toRequestOptions,
  unwrapNonToolCallEnvelope,
} from "./adapter.mjs";

const MODEL_ID = "qwen2.5-7b-instruct-generic-gpu:4";
const PERSISTENCE = Object.freeze({
  enabled: true,
  contextLimitTokens: 32768,
  reservedContextTokens: 512,
  charactersPerToken: 3,
});

function fakeSession(response) {
  return {
    addToolDefinition() {},
    processStreamingRequest() {
      const stream = (async function* () {
        for (const item of response.streamItems ?? []) yield item;
      })();
      stream.response = Promise.resolve(response);
      return stream;
    },
    dispose() {},
  };
}

function responseFixture(finishReason) {
  return {
    finishReason,
    streamItems: [],
    output: [],
    usage: {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    },
  };
}

function completionFixture(text = "ok", usage) {
  return {
    finishReason: "stop",
    output: [{ type: "text", text }],
    usage: usage ?? { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  };
}

function createRecordingRequest() {
  return {
    items: [],
    options: null,
    addItem(item) {
      this.items.push(item);
      return this;
    },
    setOptions(options) {
      this.options = options;
    },
  };
}

function recordingSessions({ beforeResponse } = {}) {
  const created = [];
  const createSession = (selectedModel) => {
    const session = {
      model: selectedModel,
      toolDefinitions: [],
      submittedItems: [],
      submittedOptions: [],
      disposeCount: 0,
      responses: [],
      addToolDefinition(definition) {
        session.toolDefinitions.push(definition);
        return session;
      },
      async processRequest(request) {
        session.submittedItems.push(request.items);
        session.submittedOptions.push(request.options);
        if (beforeResponse) await beforeResponse(session);
        return session.responses.shift() ?? completionFixture();
      },
      dispose() {
        session.disposeCount += 1;
      },
    };
    created.push(session);
    return session;
  };
  return { created, createSession };
}

function postCompletion(adapter, messages, { headers = {}, ...overrides } = {}) {
  return fetch(`${adapter.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: MODEL_ID, messages, ...overrides }),
  });
}

function submittedRoles(session, turnIndex) {
  return session.submittedItems[turnIndex].map((item) => item.role ?? item.type);
}

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

test("records an SDK length terminal reason for fail-closed grading", async () => {
  const events = [];
  const adapter = await startAdapterServer({
    model: { id: "qwen2.5-7b-instruct-generic-gpu:4" },
    createSession: () => fakeSession(responseFixture("length")),
    createRequest: () => ({ setOptions() {} }),
    recordEvent: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${adapter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5-7b-instruct-generic-gpu:4",
        stream: true,
        messages: [],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /"finish_reason":"length"/);
    assert.equal(events.at(-1).event, "request_completed");
    assert.equal(events.at(-1).finish_reason, "length");
  } finally {
    await adapter.close();
  }
});

test("records and terminates an SDK error response", async () => {
  const events = [];
  const adapter = await startAdapterServer({
    model: { id: "qwen2.5-7b-instruct-generic-gpu:4" },
    createSession: () => fakeSession(responseFixture("error")),
    createRequest: () => ({ setOptions() {} }),
    recordEvent: (event) => events.push(event),
  });
  try {
    await assert.rejects(async () => {
      const response = await fetch(`${adapter.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen2.5-7b-instruct-generic-gpu:4",
          stream: true,
          messages: [],
        }),
      });
      await response.text();
    });
    assert.equal(events.at(-1).event, "request_failed");
    assert.equal(events.at(-1).finish_reason, "error");
  } finally {
    await adapter.close();
  }
});

test("rejects and records a wrong model id", async () => {
  const events = [];
  const adapter = await startAdapterServer({
    model: { id: "qwen2.5-7b-instruct-generic-gpu:4" },
    createSession: () => {
      throw new Error("session should not be created");
    },
    recordEvent: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${adapter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "wrong-model",
        stream: true,
        messages: [],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(events.at(-1).event, "request_rejected");
    assert.equal(events.at(-1).reason, "unrecognized_model");
  } finally {
    await adapter.close();
  }
});

test("keeps one session per request when persistence is not enabled", async () => {
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: () => {},
  });
  try {
    const first = [{ role: "user", content: "Read the file." }];
    const second = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "More." }];
    assert.equal(
      (await postCompletion(adapter, first, { headers: { "x-sealed-conversation-id": "child-1" } })).status,
      200,
    );
    assert.equal(
      (await postCompletion(adapter, second, { headers: { "x-sealed-conversation-id": "child-1" } })).status,
      200,
    );

    assert.equal(created.length, 2, "default mode builds one session per request");
    assert.deepEqual(submittedRoles(created[1], 0), ["user", "assistant", "user"]);
    assert.equal(adapter.persistentSessionCount(), 0);
    assert.ok(created.every((session) => session.disposeCount === 1));
  } finally {
    await adapter.close();
  }
});

test("rejects a persistent task request without a conversation identity", async () => {
  const events = [];
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: (event) => events.push(event),
    persistence: PERSISTENCE,
  });
  try {
    const response = await postCompletion(adapter, [{ role: "user", content: "Read." }]);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "missing_conversation_id");
    assert.equal(created.length, 0, "no session may be created without an identity");
    assert.equal(events.at(-1).event, "request_rejected");
    assert.equal(events.at(-1).reason, "missing_conversation_id");
  } finally {
    await adapter.close();
  }
});

test("submits only the replayed delta to a retained session", async () => {
  const events = [];
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: (event) => events.push(event),
    persistence: PERSISTENCE,
  });
  const headers = { "x-sealed-conversation-id": "child-1" };
  try {
    const first = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Read the file." },
    ];
    const firstResponse = await postCompletion(adapter, first, { headers });
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("x-sealed-usage-trust"), "untrusted-cumulative");

    const second = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "Summarize." }];
    assert.equal((await postCompletion(adapter, second, { headers })).status, 200);

    assert.equal(created.length, 1, "one identity keeps one session");
    assert.deepEqual(submittedRoles(created[0], 0), ["system", "user"]);
    assert.deepEqual(submittedRoles(created[0], 1), ["user"]);

    const [firstOptions, secondOptions] = created[0].submittedOptions;
    assert.ok(
      secondOptions.search.maxOutputTokens > firstOptions.search.maxOutputTokens,
      "later ceilings must clear the cumulative session position",
    );

    const completed = events.filter((event) => event.event === "request_completed");
    assert.equal(completed.at(-1).conversation_id, "child-1");
    assert.equal(completed.at(-1).request_purpose, "task");
    assert.equal(completed.at(-1).session_mode, "persistent");
    assert.equal(completed.at(-1).usage_trust, "untrusted-cumulative");
    assert.equal(completed.at(-1).session_turn, 2);
    assert.ok(
      events.every((event) => !JSON.stringify(event).includes("Summarize")),
      "receipts must not record prompt content",
    );
  } finally {
    await adapter.close();
  }
});

test("rejects a diverged replay without resetting the retained session", async () => {
  const events = [];
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: (event) => events.push(event),
    persistence: PERSISTENCE,
  });
  const headers = { "x-sealed-conversation-id": "child-1" };
  try {
    const first = [{ role: "user", content: "Read the file." }];
    assert.equal((await postCompletion(adapter, first, { headers })).status, 200);

    const diverged = [
      { role: "user", content: "Read a different file." },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Summarize." },
    ];
    const response = await postCompletion(adapter, diverged, { headers });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "replay_prefix_mismatch");
    assert.equal(created[0].submittedItems.length, 1, "a rejected replay must not be submitted");
    assert.equal(events.at(-1).event, "request_rejected");
    assert.equal(events.at(-1).reason, "replay_prefix_mismatch");
    assert.equal(events.at(-1).conversation_id, "child-1");
  } finally {
    await adapter.close();
  }
});

test("serializes concurrent turns for one conversation", async () => {
  const order = [];
  let releaseFirstTurn;
  const firstTurnStarted = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });
  const { created, createSession } = recordingSessions({
    beforeResponse: async (session) => {
      const turn = session.submittedItems.length;
      order.push(`start-${turn}`);
      if (turn === 1) {
        releaseFirstTurn();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      order.push(`end-${turn}`);
    },
  });
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: () => {},
    persistence: PERSISTENCE,
  });
  const headers = { "x-sealed-conversation-id": "child-1" };
  try {
    const first = [{ role: "user", content: "Read the file." }];
    const second = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "Summarize." }];

    const firstRequest = postCompletion(adapter, first, { headers });
    await firstTurnStarted;
    const secondRequest = postCompletion(adapter, second, { headers });
    const responses = await Promise.all([firstRequest, secondRequest]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
    assert.equal(created.length, 1);
  } finally {
    await adapter.close();
  }
});

test("runs a health probe on an ephemeral session without touching task state", async () => {
  const events = [];
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: (event) => events.push(event),
    persistence: PERSISTENCE,
  });
  const headers = { "x-sealed-conversation-id": "child-1" };
  try {
    const first = [{ role: "user", content: "Read the file." }];
    assert.equal((await postCompletion(adapter, first, { headers })).status, 200);

    const health = await postCompletion(adapter, [{ role: "user", content: "Reply exactly READY" }], {
      headers: { "x-sealed-request-purpose": "health" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-sealed-usage-trust"), null);
    assert.equal(adapter.persistentSessionCount(), 1, "health must not create a retained session");
    assert.equal(created.length, 2);
    assert.equal(created[1].disposeCount, 1, "the health session is disposed immediately");

    const second = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "Summarize." }];
    assert.equal((await postCompletion(adapter, second, { headers })).status, 200);
    assert.deepEqual(submittedRoles(created[0], 1), ["user"]);

    const healthEvent = events.find(
      (event) => event.event === "request_started" && event.request_purpose === "health",
    );
    assert.equal(healthEvent.session_mode, "ephemeral");
    assert.equal(healthEvent.conversation_id, null);
  } finally {
    await adapter.close();
  }
});

test("rejects a changed tool definition inside a retained session", async () => {
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: () => {},
    persistence: PERSISTENCE,
  });
  const headers = { "x-sealed-conversation-id": "child-1" };
  const viewTool = (parameters) => ({
    type: "function",
    function: { name: "view", description: "Read a file.", parameters },
  });
  const globTool = {
    type: "function",
    function: { name: "glob", description: "Find files.", parameters: { type: "object" } },
  };
  try {
    const first = [{ role: "user", content: "Read the file." }];
    assert.equal(
      (await postCompletion(adapter, first, { headers, tools: [viewTool({ type: "object" })] })).status,
      200,
    );

    const second = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "Summarize." }];
    const drifted = await postCompletion(adapter, second, {
      headers,
      tools: [viewTool({ type: "object", properties: { path: { type: "string" } } })],
    });
    assert.equal(drifted.status, 409);
    assert.equal((await drifted.json()).error.code, "tool_definition_conflict");
    assert.equal(created[0].submittedItems.length, 1);

    // A non-conflicting new tool is still allowed on the unchanged session.
    const retried = await postCompletion(adapter, second, {
      headers,
      tools: [viewTool({ type: "object" }), globTool],
    });
    assert.equal(retried.status, 200);
    assert.deepEqual(
      created[0].toolDefinitions.map((definition) => definition.name),
      ["view", "glob"],
    );

    const third = [
      ...second,
      { role: "assistant", content: "ok" },
      { role: "user", content: "Use only view." },
    ];
    const narrowed = await postCompletion(adapter, third, {
      headers,
      tools: [viewTool({ type: "object" }), globTool],
      tool_choice: { type: "function", function: { name: "view" } },
    });
    assert.equal(narrowed.status, 409);
    assert.equal(
      (await narrowed.json()).error.code,
      "tool_scope_narrowing_unsupported",
    );
  } finally {
    await adapter.close();
  }
});

test("isolates retained history across conversation identities", async () => {
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: () => {},
    persistence: PERSISTENCE,
  });
  try {
    const firstChild = [{ role: "user", content: "Child one secret." }];
    assert.equal(
      (await postCompletion(adapter, firstChild, { headers: { "x-sealed-conversation-id": "child-1" } })).status,
      200,
    );

    const secondChild = [{ role: "user", content: "Child two task." }];
    assert.equal(
      (await postCompletion(adapter, secondChild, { headers: { "x-sealed-conversation-id": "child-2" } })).status,
      200,
    );

    assert.equal(created.length, 2);
    assert.equal(adapter.persistentSessionCount(), 2);
    assert.deepEqual(
      created[1].submittedItems.flat().map((item) => item.content),
      ["Child two task."],
    );

    // child-2 cannot continue child-1's committed history.
    const crossReplay = [...firstChild, { role: "assistant", content: "ok" }, { role: "user", content: "More." }];
    const response = await postCompletion(adapter, crossReplay, {
      headers: { "x-sealed-conversation-id": "child-2" },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "replay_prefix_mismatch");
  } finally {
    await adapter.close();
  }
});

test("releases one retained session and disposes the rest on close", async () => {
  const events = [];
  const { created, createSession } = recordingSessions();
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession,
    createRequest: createRecordingRequest,
    recordEvent: (event) => events.push(event),
    persistence: PERSISTENCE,
  });
  let closed = false;
  try {
    for (const conversationId of ["child-1", "child-2"]) {
      assert.equal(
        (await postCompletion(adapter, [{ role: "user", content: "Read." }], {
          headers: { "x-sealed-conversation-id": conversationId },
        })).status,
        200,
      );
    }

    const released = await fetch(`${adapter.baseUrl}/sessions/release`, {
      method: "POST",
      headers: { "x-sealed-conversation-id": "child-1" },
    });
    assert.equal(released.status, 200);
    assert.deepEqual(await released.json(), { released: true });
    assert.equal(created[0].disposeCount, 1);
    assert.equal(adapter.persistentSessionCount(), 1);

    await adapter.close();
    closed = true;
    assert.equal(created[1].disposeCount, 1);
    assert.equal(adapter.persistentSessionCount(), 0);
    assert.equal(events.at(-1).event, "persistent_sessions_disposed");
    assert.equal(events.at(-1).released, 1);
  } finally {
    if (!closed) await adapter.close();
  }
});

test("does not expose the release endpoint when persistence is disabled", async () => {
  const adapter = await startAdapterServer({
    model: { id: MODEL_ID },
    createSession: recordingSessions().createSession,
    createRequest: createRecordingRequest,
    recordEvent: () => {},
  });
  try {
    const response = await fetch(`${adapter.baseUrl}/sessions/release`, {
      method: "POST",
      headers: { "x-sealed-conversation-id": "child-1" },
    });
    assert.equal(response.status, 404);
  } finally {
    await adapter.close();
  }
});
