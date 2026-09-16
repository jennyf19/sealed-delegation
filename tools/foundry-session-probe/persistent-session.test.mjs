import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHARACTERS_PER_TOKEN,
  PersistentSessionError,
  PersistentSessionStore,
  estimateMessageTokens,
  extractReplayDelta,
  nextPersistentOutputCeiling,
  nextSessionPosition,
  normalizeReplayMessages,
  parseConversationId,
  parseRequestPurpose,
  persistenceOptionsFromEnv,
  planPersistentTurn,
  reconcileToolDefinitions,
} from "./persistent-session.mjs";

const model = { id: "qwen2.5-7b-instruct-generic-gpu:4" };

function fakeSession() {
  return {
    toolDefinitions: [],
    disposeCount: 0,
    addToolDefinition(definition) {
      this.toolDefinitions.push(definition);
      return this;
    },
    dispose() {
      this.disposeCount += 1;
    },
  };
}

function toolDefinition(name, schema = '{"type":"object"}') {
  return { name, description: `${name} tool`, jsonSchema: schema };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function thrownError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "Expected the call to throw." });
}

test("persistence stays disabled unless explicitly enabled", () => {
  assert.equal(persistenceOptionsFromEnv({}).enabled, false);
  assert.equal(
    persistenceOptionsFromEnv({ FOUNDRY_ADAPTER_PERSISTENT_SESSIONS: "0" }).enabled,
    false,
  );
  const enabled = persistenceOptionsFromEnv({
    FOUNDRY_ADAPTER_PERSISTENT_SESSIONS: "1",
    FOUNDRY_ADAPTER_CONTEXT_LIMIT_TOKENS: "8192",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.contextLimitTokens, 8192);
  assert.throws(
    () =>
      persistenceOptionsFromEnv({
        FOUNDRY_ADAPTER_CONTEXT_LIMIT_TOKENS: "not-a-number",
      }),
    /must be a positive integer/,
  );
});

test("parses request purpose and conversation identity", () => {
  assert.equal(parseRequestPurpose({}), "task");
  assert.equal(parseRequestPurpose({ "x-sealed-request-purpose": "Health" }), "health");
  assert.throws(
    () => parseRequestPurpose({ "x-sealed-request-purpose": "grading" }),
    /must be one of/,
  );

  assert.equal(parseConversationId({}), null);
  assert.equal(
    parseConversationId({ "x-sealed-conversation-id": " child-1 " }),
    "child-1",
  );
  assert.throws(
    () => parseConversationId({}, { required: true }),
    /requires the x-sealed-conversation-id header/,
  );
  assert.throws(
    () => parseConversationId({ "x-sealed-conversation-id": "child 1\n" }, {}),
    /must be 1-128 characters/,
  );
});

test("extracts only the newly replayed messages", () => {
  const committed = normalizeReplayMessages([
    { role: "system", content: "Use tools." },
    { role: "user", content: "Read the file." },
    { role: "assistant", content: "done", tool_calls: [] },
  ]);
  const incoming = normalizeReplayMessages([
    { role: "system", content: "Use tools." },
    { role: "user", content: "Read the file." },
    { role: "assistant", content: "done" },
    { role: "user", content: "Now summarize." },
  ]);

  const { deltaStart, delta } = extractReplayDelta(committed, incoming);
  assert.equal(deltaStart, 3);
  assert.deepEqual(
    delta.map((message) => message.role),
    ["user"],
  );
});

test("normalizes tool call history for replay comparison", () => {
  const committed = normalizeReplayMessages([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", function: { name: "view", arguments: '{"path":"a.txt"}' } },
      ],
    },
  ]);
  const incoming = normalizeReplayMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "view", arguments: '{"path":"a.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "hello" },
  ]);

  assert.equal(extractReplayDelta(committed, incoming).deltaStart, 1);
});

test("rejects a diverged replay instead of silently resetting", () => {
  const committed = normalizeReplayMessages([
    { role: "system", content: "Use tools." },
    { role: "user", content: "Read the file." },
  ]);
  const diverged = normalizeReplayMessages([
    { role: "system", content: "Use tools." },
    { role: "user", content: "Read a different file." },
    { role: "user", content: "Now summarize." },
  ]);

  const error = thrownError(() => extractReplayDelta(committed, diverged));
  assert.ok(error instanceof PersistentSessionError);
  assert.equal(error.code, "replay_prefix_mismatch");
  assert.equal(error.status, 409);
});

test("rejects a truncated replay and a delta-free replay", () => {
  const committed = normalizeReplayMessages([
    { role: "system", content: "Use tools." },
    { role: "user", content: "Read the file." },
  ]);

  assert.equal(
    thrownError(() => extractReplayDelta(committed, committed.slice(0, 1))).code,
    "replay_prefix_mismatch",
  );
  assert.equal(
    thrownError(() => extractReplayDelta(committed, committed)).code,
    "empty_replay_delta",
  );
});

test("registers each tool once and rejects a changed definition", () => {
  const registered = new Map([["view", toolDefinition("view")]]);

  assert.deepEqual(reconcileToolDefinitions(registered, [toolDefinition("view")]), []);
  assert.deepEqual(
    reconcileToolDefinitions(registered, [
      toolDefinition("view"),
      toolDefinition("glob"),
    ]).map((definition) => definition.name),
    ["glob"],
  );

  const error = thrownError(() =>
    reconcileToolDefinitions(registered, [
      toolDefinition("view", '{"type":"object","properties":{"path":{}}}'),
    ]),
  );
  assert.ok(error instanceof PersistentSessionError);
  assert.equal(error.code, "tool_definition_conflict");
  assert.equal(error.status, 409);
});

test("rejects removing or narrowing previously registered tools", () => {
  const registered = new Map([
    ["view", toolDefinition("view")],
    ["glob", toolDefinition("glob")],
  ]);
  const error = thrownError(() =>
    reconcileToolDefinitions(registered, [toolDefinition("view")]),
  );
  assert.equal(error.code, "tool_scope_narrowing_unsupported");
  assert.equal(error.status, 409);
  assert.match(error.message, /glob/);
});

test("keeps ordinary per-request output budget on the first persistent turn", () => {
  assert.equal(
    nextPersistentOutputCeiling({
      isFirstTurn: true,
      sessionPositionTokens: 0,
      previousCeilingTokens: 0,
      promptDeltaTokens: 100,
      requestedOutputTokens: 1024,
      contextLimitTokens: 32768,
      reservedContextTokens: 512,
    }),
    1024,
  );
  assert.equal(
    thrownError(() =>
      nextPersistentOutputCeiling({
        isFirstTurn: true,
        sessionPositionTokens: 0,
        previousCeilingTokens: 0,
        promptDeltaTokens: 18050,
        requestedOutputTokens: 32768,
        contextLimitTokens: 32768,
        reservedContextTokens: 512,
      }),
    ).code,
    "output_ceiling_exhausted",
  );
});

test("raises later ceilings above the cumulative session position", () => {
  const second = nextPersistentOutputCeiling({
    isFirstTurn: false,
    sessionPositionTokens: 18052,
    previousCeilingTokens: 14000,
    promptDeltaTokens: 16,
    requestedOutputTokens: 64,
    contextLimitTokens: 32768,
    reservedContextTokens: 512,
  });
  // The recorded turn-two persistent run ended at session position 18,054.
  assert.equal(second, 18132);
  assert.ok(second > 18054);

  const third = nextPersistentOutputCeiling({
    isFirstTurn: false,
    sessionPositionTokens: 18087,
    previousCeilingTokens: second,
    promptDeltaTokens: 16,
    requestedOutputTokens: 64,
    contextLimitTokens: 32768,
    reservedContextTokens: 512,
  });
  assert.ok(third > second, "ceilings must increase monotonically");
});

test("uses the previous ceiling as the floor when reported position lags", () => {
  assert.equal(
    nextPersistentOutputCeiling({
      isFirstTurn: false,
      sessionPositionTokens: 10,
      previousCeilingTokens: 5000,
      promptDeltaTokens: 20,
      requestedOutputTokens: 30,
      contextLimitTokens: 32768,
      reservedContextTokens: 512,
    }),
    5050,
  );
});

test("fails before inference when no safe headroom remains", () => {
  const error = thrownError(() =>
    nextPersistentOutputCeiling({
      isFirstTurn: false,
      sessionPositionTokens: 32000,
      previousCeilingTokens: 32000,
      promptDeltaTokens: 100,
      requestedOutputTokens: 512,
      contextLimitTokens: 32768,
      reservedContextTokens: 512,
    }),
  );
  assert.ok(error instanceof PersistentSessionError);
  assert.equal(error.code, "output_ceiling_exhausted");
  assert.match(error.message, /32256-token usable context/);
});

test("rejects unusable ceiling inputs", () => {
  assert.throws(
    () =>
      nextPersistentOutputCeiling({
        isFirstTurn: true,
        sessionPositionTokens: 0,
        previousCeilingTokens: 0,
        promptDeltaTokens: 0,
        requestedOutputTokens: 0,
        contextLimitTokens: 32768,
        reservedContextTokens: 512,
      }),
    /requestedOutputTokens must be a positive integer/,
  );
  assert.throws(
    () =>
      nextPersistentOutputCeiling({
        isFirstTurn: false,
        sessionPositionTokens: -1,
        previousCeilingTokens: 0,
        promptDeltaTokens: 0,
        requestedOutputTokens: 16,
        contextLimitTokens: 32768,
        reservedContextTokens: 512,
      }),
    /sessionPositionTokens must be a non-negative integer/,
  );
});

test("over-estimates delta prompt tokens rather than under-estimating", () => {
  const delta = normalizeReplayMessages([{ role: "user", content: "x".repeat(300) }]);
  const tokens = estimateMessageTokens(delta, DEFAULT_CHARACTERS_PER_TOKEN);
  assert.ok(tokens > 300 / 4, "estimate must exceed a 4-characters-per-token reading");
});

test("tracks the highest plausible session position", () => {
  assert.equal(
    nextSessionPosition(100, { promptTokens: 33, completionTokens: 18054, totalTokens: 18087 }),
    18087,
  );
  assert.equal(nextSessionPosition(18087, { totalTokens: 12 }), 18087);
});

test("plans a turn from committed state", () => {
  const plan = planPersistentTurn({
    committedMessages: normalizeReplayMessages([{ role: "system", content: "Use tools." }]),
    registeredToolDefinitions: new Map([["view", toolDefinition("view")]]),
    sessionPositionTokens: 2000,
    previousCeilingTokens: 1024,
    turnCount: 1,
    incomingMessages: [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Read the file." },
    ],
    incomingToolDefinitions: [toolDefinition("view"), toolDefinition("glob")],
    requestedOutputTokens: 256,
  });

  assert.deepEqual(
    plan.deltaMessages.map((message) => message.content),
    ["Read the file."],
  );
  assert.deepEqual(
    plan.toolAdditions.map((definition) => definition.name),
    ["glob"],
  );
  assert.equal(plan.maxOutputTokens, 2000 + plan.promptDeltaTokens + 256);
  assert.equal(plan.normalizedIncoming.length, 2);
});

test("serializes turns within one conversation", async () => {
  const store = new PersistentSessionStore({ createSession: fakeSession });
  const order = [];

  const first = store.run("child-1", model, async () => {
    order.push("start-1");
    await delay(25);
    order.push("end-1");
  });
  const second = store.run("child-1", model, async () => {
    order.push("start-2");
    await delay(1);
    order.push("end-2");
  });

  await Promise.all([first, second]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
  assert.equal(store.size, 1);
});

test("keeps one session per conversation identity", async () => {
  const sessions = [];
  const store = new PersistentSessionStore({
    createSession: () => {
      const session = fakeSession();
      sessions.push(session);
      return session;
    },
  });

  const seen = [];
  await store.run("child-1", model, (entry) => seen.push(entry.session));
  await store.run("child-1", model, (entry) => seen.push(entry.session));
  await store.run("child-2", model, (entry) => seen.push(entry.session));

  assert.equal(sessions.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.notEqual(seen[0], seen[2]);
  assert.equal(store.size, 2);
});

test("retires a session after a failed submitted turn", async () => {
  const store = new PersistentSessionStore({ createSession: fakeSession });

  await assert.rejects(
    store.run("child-1", model, (entry) => {
      store.markUnusable(entry, "a failed submitted turn");
      throw new Error("submission failed");
    }),
    /submission failed/,
  );

  const error = await store
    .run("child-1", model, () => "should not run")
    .catch((caught) => caught);
  assert.equal(error.code, "session_unusable");
  assert.equal(error.status, 409);
});

test("commits replayed history plus the adapter's own answer", async () => {
  const store = new PersistentSessionStore({ createSession: fakeSession });
  await store.run("child-1", model, (entry) => {
    store.commitTurn(entry, {
      normalizedIncoming: normalizeReplayMessages([{ role: "user", content: "hi" }]),
      assistantMessage: { role: "assistant", content: "hello", tool_calls: [] },
      maxOutputTokens: 1024,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    });
    assert.deepEqual(
      entry.committedMessages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(entry.sessionPositionTokens, 12);
    assert.equal(entry.previousCeilingTokens, 1024);
    assert.equal(entry.turnCount, 1);
  });
});

test("disposes released and remaining sessions", async () => {
  const sessions = [];
  const store = new PersistentSessionStore({
    createSession: () => {
      const session = fakeSession();
      sessions.push(session);
      return session;
    },
  });

  await store.run("child-1", model, () => undefined);
  await store.run("child-2", model, () => undefined);

  assert.equal(await store.release("child-1"), true);
  assert.equal(await store.release("child-1"), false);
  assert.equal(sessions[0].disposeCount, 1);
  assert.equal(store.size, 1);

  assert.equal(store.disposeAll(), 1);
  assert.equal(sessions[1].disposeCount, 1);
  assert.equal(store.size, 0);
});

test("releases a session only after its in-flight turn finishes", async () => {
  const sessions = [];
  const store = new PersistentSessionStore({
    createSession: () => {
      const session = fakeSession();
      sessions.push(session);
      return session;
    },
  });

  let turnStarted;
  const turnHasStarted = new Promise((resolve) => {
    turnStarted = resolve;
  });
  let turnFinished = false;
  const inFlight = store.run("child-1", model, async () => {
    turnStarted();
    await delay(25);
    turnFinished = true;
  });

  await turnHasStarted;
  const release = store.release("child-1");
  assert.equal(sessions[0].disposeCount, 0, "disposal must wait for the in-flight turn");

  await inFlight;
  assert.equal(await release, true);
  assert.equal(turnFinished, true);
  assert.equal(sessions[0].disposeCount, 1);

  // A later request for the same identity gets a brand new session.
  await store.run("child-1", model, () => undefined);
  assert.equal(sessions.length, 2);
});

test("surfaces release disposal failures", async () => {
  const store = new PersistentSessionStore({
    createSession: () => ({
      addToolDefinition() {},
      dispose() {
        throw new Error("native dispose failed");
      },
    }),
  });
  await store.run("child-1", model, async () => {});

  await assert.rejects(
    store.release("child-1"),
    (error) =>
      error instanceof PersistentSessionError &&
      error.code === "session_disposal_failed" &&
      /native dispose failed/.test(error.message),
  );
});
