// Unqualified experiment for issue #10: retain one Foundry Local `ChatSession` per child
// conversation instead of building a fresh session for every OpenAI completion request.
//
// Everything here is opt-in. When persistence is disabled the adapter keeps its qualified
// behaviour of one session per request, so this module must never be reached by the default path.

export const CONVERSATION_ID_HEADER = "x-sealed-conversation-id";
export const REQUEST_PURPOSE_HEADER = "x-sealed-request-purpose";
export const USAGE_TRUST_HEADER = "x-sealed-usage-trust";

export const TASK_PURPOSE = "task";
export const HEALTH_PURPOSE = "health";
export const REQUEST_PURPOSES = Object.freeze([TASK_PURPOSE, HEALTH_PURPOSE]);

/** Persistent turns report cumulative-looking usage; see README "Untrusted telemetry". */
export const UNTRUSTED_CUMULATIVE_USAGE = "untrusted-cumulative";
export const TRUSTED_PER_REQUEST_USAGE = "per-request";

export const DEFAULT_CONTEXT_LIMIT_TOKENS = 32768;
export const DEFAULT_RESERVED_CONTEXT_TOKENS = 512;
export const DEFAULT_CHARACTERS_PER_TOKEN = 3;
export const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 8;

// Conversation ids land in provider receipts, so they stay in a narrow printable alphabet.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class PersistentSessionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PersistentSessionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Flattens OpenAI message or SDK item content into plain text. Replay normalization and SDK
 * submission share this helper so a committed prefix is compared exactly as it was submitted.
 */
export function flattenOpenAiContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function positiveIntegerFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new PersistentSessionError(
      "invalid_persistence_configuration",
      `${name} must be a positive integer.`,
      500,
    );
  }
  return value;
}

export function persistenceOptionsFromEnv(env = process.env) {
  return {
    enabled: env.FOUNDRY_ADAPTER_PERSISTENT_SESSIONS === "1",
    contextLimitTokens: positiveIntegerFromEnv(
      env,
      "FOUNDRY_ADAPTER_CONTEXT_LIMIT_TOKENS",
      DEFAULT_CONTEXT_LIMIT_TOKENS,
    ),
    reservedContextTokens: positiveIntegerFromEnv(
      env,
      "FOUNDRY_ADAPTER_RESERVED_CONTEXT_TOKENS",
      DEFAULT_RESERVED_CONTEXT_TOKENS,
    ),
    charactersPerToken: positiveIntegerFromEnv(
      env,
      "FOUNDRY_ADAPTER_CHARACTERS_PER_TOKEN",
      DEFAULT_CHARACTERS_PER_TOKEN,
    ),
  };
}

export function parseRequestPurpose(headers = {}) {
  const raw = headers[REQUEST_PURPOSE_HEADER];
  if (raw === undefined || raw === "") return TASK_PURPOSE;
  const value = String(raw).trim().toLowerCase();
  if (!REQUEST_PURPOSES.includes(value)) {
    throw new PersistentSessionError(
      "invalid_request_purpose",
      `${REQUEST_PURPOSE_HEADER} must be one of: ${REQUEST_PURPOSES.join(", ")}.`,
      400,
    );
  }
  return value;
}

export function parseConversationId(headers = {}, { required = false } = {}) {
  const raw = headers[CONVERSATION_ID_HEADER];
  const value = raw === undefined ? "" : String(raw).trim();
  if (!value) {
    if (!required) return null;
    throw new PersistentSessionError(
      "missing_conversation_id",
      `Persistent session mode requires the ${CONVERSATION_ID_HEADER} header.`,
      400,
    );
  }
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new PersistentSessionError(
      "invalid_conversation_id",
      `${CONVERSATION_ID_HEADER} must be 1-128 characters of [A-Za-z0-9._:-].`,
      400,
    );
  }
  return value;
}

function normalizedToolCalls(message) {
  return (message?.tool_calls ?? []).map((call) => ({
    id: call?.id ?? "",
    name: call?.function?.name ?? "",
    arguments: call?.function?.arguments ?? "",
  }));
}

/**
 * Projects OpenAI messages onto the subset of fields the adapter actually submits to the SDK.
 * Fields the adapter drops must not participate in prefix comparison.
 */
export function normalizeReplayMessages(messages) {
  return (messages ?? []).map((message) => ({
    role: message?.role ?? "",
    content: flattenOpenAiContent(message?.content),
    toolCallId: message?.tool_call_id ?? "",
    toolCalls: normalizedToolCalls(message),
  }));
}

function sameMessage(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * OpenAI-compatible clients resend the whole conversation, but a retained `ChatSession` already
 * holds everything previously accepted. Returns the index where the new messages begin, or throws
 * when the replay diverges from committed history. Divergence is never repaired silently: the
 * retained SDK history cannot be rewound, so duplicating or dropping turns would corrupt grading.
 */
export function extractReplayDelta(committedMessages, incomingMessages) {
  const committed = committedMessages ?? [];
  const incoming = incomingMessages ?? [];
  if (incoming.length < committed.length) {
    throw new PersistentSessionError(
      "replay_prefix_mismatch",
      `Replayed history has ${incoming.length} messages but ${committed.length} are already committed to this session.`,
      409,
    );
  }
  for (let index = 0; index < committed.length; index += 1) {
    if (!sameMessage(committed[index], incoming[index])) {
      throw new PersistentSessionError(
        "replay_prefix_mismatch",
        `Replayed message ${index} does not match the message already committed to this session.`,
        409,
      );
    }
  }
  if (incoming.length === committed.length) {
    throw new PersistentSessionError(
      "empty_replay_delta",
      "Replayed history adds no new message to this session.",
      409,
    );
  }
  return { deltaStart: committed.length, delta: incoming.slice(committed.length) };
}

/**
 * Deliberately coarse upper-bound estimate: the ceiling helper needs the delta to be over-counted
 * rather than under-counted, because an under-counted position produces a fail-closed `length`.
 */
export function estimateMessageTokens(
  normalizedMessages,
  charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN,
  messageOverheadTokens = DEFAULT_MESSAGE_OVERHEAD_TOKENS,
) {
  if (!Number.isInteger(charactersPerToken) || charactersPerToken <= 0) {
    throw new PersistentSessionError(
      "invalid_persistence_configuration",
      "charactersPerToken must be a positive integer.",
      500,
    );
  }
  let tokens = 0;
  for (const message of normalizedMessages ?? []) {
    const characters =
      (message.role?.length ?? 0) +
      (message.content?.length ?? 0) +
      (message.toolCallId?.length ?? 0) +
      (message.toolCalls ?? []).reduce(
        (sum, call) => sum + call.id.length + call.name.length + call.arguments.length,
        0,
      );
    tokens += Math.ceil(characters / charactersPerToken) + messageOverheadTokens;
  }
  return tokens;
}

function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new PersistentSessionError(
      "invalid_output_ceiling_input",
      `${name} must be a non-negative integer.`,
      500,
    );
  }
}

/**
 * Foundry Local SDK 2.0.1 treated `maxOutputTokens` on a retained session as an absolute
 * session-position ceiling rather than a per-turn output budget: a static value that worked on turn
 * one produced immediate `length` terminals on later turns. Later turns therefore need a ceiling
 * above the cumulative session position plus the new prompt delta.
 *
 * The first turn keeps ordinary per-request semantics, which is also what the default one-session-
 * per-request mode uses. Every input is explicit so the rule stays testable without a live model.
 */
export function nextPersistentOutputCeiling({
  isFirstTurn,
  sessionPositionTokens,
  previousCeilingTokens,
  promptDeltaTokens,
  requestedOutputTokens,
  contextLimitTokens,
  reservedContextTokens,
}) {
  assertNonNegativeInteger("sessionPositionTokens", sessionPositionTokens);
  assertNonNegativeInteger("previousCeilingTokens", previousCeilingTokens);
  assertNonNegativeInteger("promptDeltaTokens", promptDeltaTokens);
  assertNonNegativeInteger("contextLimitTokens", contextLimitTokens);
  assertNonNegativeInteger("reservedContextTokens", reservedContextTokens);
  if (!Number.isInteger(requestedOutputTokens) || requestedOutputTokens <= 0) {
    throw new PersistentSessionError(
      "invalid_output_ceiling_input",
      "requestedOutputTokens must be a positive integer.",
      400,
    );
  }

  const usableContextTokens = contextLimitTokens - reservedContextTokens;
  // Turn one behaved like an ordinary per-request output budget: a 14,000-token ceiling completed
  // cleanly behind an 18,050-token prompt. Only later turns behaved like an absolute ceiling.
  const positionTokens = isFirstTurn
    ? 0
    : Math.max(sessionPositionTokens, previousCeilingTokens);
  const projectedPositionTokens = positionTokens + promptDeltaTokens + requestedOutputTokens;
  if (projectedPositionTokens > usableContextTokens) {
    throw new PersistentSessionError(
      "output_ceiling_exhausted",
      `Session position ${positionTokens} plus ${promptDeltaTokens} prompt and ${requestedOutputTokens} output tokens exceeds the ${usableContextTokens}-token usable context.`,
      409,
    );
  }
  return isFirstTurn ? requestedOutputTokens : projectedPositionTokens;
}

/**
 * Tool definitions live in the `ChatSession`, so a name may be registered only once. A changed
 * definition for an existing name is rejected rather than shadowed; newly named tools are allowed.
 */
export function reconcileToolDefinitions(registeredDefinitions, incomingDefinitions) {
  const registered = registeredDefinitions ?? new Map();
  const incomingNames = new Set(
    (incomingDefinitions ?? []).map((definition) => definition.name),
  );
  const omittedNames = [...registered.keys()].filter(
    (name) => !incomingNames.has(name),
  );
  if (omittedNames.length > 0) {
    throw new PersistentSessionError(
      "tool_scope_narrowing_unsupported",
      `Persistent sessions cannot remove or narrow previously registered tools: ${omittedNames.join(", ")}.`,
      409,
    );
  }
  const additions = [];
  for (const definition of incomingDefinitions ?? []) {
    const existing = registered.get(definition.name);
    if (!existing) {
      additions.push(definition);
      continue;
    }
    if (
      existing.description !== definition.description ||
      existing.jsonSchema !== definition.jsonSchema
    ) {
      throw new PersistentSessionError(
        "tool_definition_conflict",
        `Tool '${definition.name}' is already registered in this session with a different definition.`,
        409,
      );
    }
  }
  return additions;
}

/**
 * Pure turn planner. Validates the replay, selects the delta, reconciles tool definitions, and
 * computes the output ceiling before any inference happens, so every rejection is fail-closed.
 */
export function planPersistentTurn({
  committedMessages,
  registeredToolDefinitions,
  sessionPositionTokens,
  previousCeilingTokens,
  turnCount,
  incomingMessages,
  incomingToolDefinitions,
  requestedOutputTokens,
  contextLimitTokens = DEFAULT_CONTEXT_LIMIT_TOKENS,
  reservedContextTokens = DEFAULT_RESERVED_CONTEXT_TOKENS,
  charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN,
}) {
  const normalizedIncoming = normalizeReplayMessages(incomingMessages);
  const { deltaStart, delta } = extractReplayDelta(committedMessages, normalizedIncoming);
  const toolAdditions = reconcileToolDefinitions(
    registeredToolDefinitions,
    incomingToolDefinitions,
  );
  const promptDeltaTokens = estimateMessageTokens(delta, charactersPerToken);
  const maxOutputTokens = nextPersistentOutputCeiling({
    isFirstTurn: turnCount === 0,
    sessionPositionTokens,
    previousCeilingTokens,
    promptDeltaTokens,
    requestedOutputTokens,
    contextLimitTokens,
    reservedContextTokens,
  });
  return {
    deltaStart,
    deltaMessages: (incomingMessages ?? []).slice(deltaStart),
    normalizedIncoming,
    toolAdditions,
    promptDeltaTokens,
    maxOutputTokens,
  };
}

/**
 * Reported usage is not trusted for cost, but it is the only session-position signal available, so
 * the largest plausible reading is kept as the position floor for the next ceiling.
 */
export function nextSessionPosition(currentPositionTokens, usage) {
  const promptTokens = Number(usage?.promptTokens ?? 0);
  const completionTokens = Number(usage?.completionTokens ?? 0);
  const totalTokens = Number(usage?.totalTokens ?? 0);
  const candidates = [currentPositionTokens, totalTokens, promptTokens + completionTokens].filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  return Math.max(0, ...candidates);
}

/**
 * Owns one retained `ChatSession` per conversation identity, serializes that conversation's
 * requests, and disposes every session on adapter close.
 */
export class PersistentSessionStore {
  #createSession;
  #options;
  #entries = new Map();

  constructor({
    createSession,
    contextLimitTokens = DEFAULT_CONTEXT_LIMIT_TOKENS,
    reservedContextTokens = DEFAULT_RESERVED_CONTEXT_TOKENS,
    charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN,
  }) {
    if (typeof createSession !== "function") {
      throw new PersistentSessionError(
        "invalid_persistence_configuration",
        "PersistentSessionStore requires a createSession factory.",
        500,
      );
    }
    this.#createSession = createSession;
    this.#options = { contextLimitTokens, reservedContextTokens, charactersPerToken };
  }

  get options() {
    return { ...this.#options };
  }

  get size() {
    return this.#entries.size;
  }

  has(conversationId) {
    return this.#entries.has(conversationId);
  }

  #entry(conversationId, model) {
    let entry = this.#entries.get(conversationId);
    if (!entry) {
      entry = {
        conversationId,
        session: this.#createSession(model),
        committedMessages: [],
        toolDefinitions: new Map(),
        sessionPositionTokens: 0,
        previousCeilingTokens: 0,
        turnCount: 0,
        unusableReason: null,
        queue: Promise.resolve(),
      };
      this.#entries.set(conversationId, entry);
    }
    return entry;
  }

  /**
   * Runs `task` with exclusive access to the conversation's session. Turns are serialized because
   * a retained session has a single mutable position; concurrent turns would interleave history.
   */
  run(conversationId, model, task) {
    const entry = this.#entry(conversationId, model);
    const run = entry.queue.then(() => {
      if (entry.unusableReason) {
        throw new PersistentSessionError(
          "session_unusable",
          `This session was retired after ${entry.unusableReason}; release the conversation and start a new one.`,
          409,
        );
      }
      return task(entry, this.#options);
    });
    entry.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A turn that failed after submission may have mutated SDK history in an unknown way. */
  markUnusable(entry, reason) {
    entry.unusableReason = reason;
  }

  commitTurn(entry, { normalizedIncoming, assistantMessage, maxOutputTokens, usage }) {
    entry.committedMessages = [
      ...normalizedIncoming,
      ...normalizeReplayMessages([assistantMessage]),
    ];
    entry.sessionPositionTokens = nextSessionPosition(entry.sessionPositionTokens, usage);
    entry.previousCeilingTokens = maxOutputTokens;
    entry.turnCount += 1;
    return entry;
  }

  registerToolDefinitions(entry, definitions) {
    for (const definition of definitions) {
      entry.session.addToolDefinition(definition);
      entry.toolDefinitions.set(definition.name, definition);
    }
    return entry;
  }

  async release(conversationId) {
    const entry = this.#entries.get(conversationId);
    if (!entry) return false;
    this.#entries.delete(conversationId);
    // A later request for the same identity starts a new session; anything already queued for this
    // one must fail closed rather than run against a session that is about to be disposed.
    entry.unusableReason = "an explicit release";
    await entry.queue;
    try {
      entry.session.dispose();
    } catch (error) {
      throw new PersistentSessionError(
        "session_disposal_failed",
        `Failed to dispose persistent session '${conversationId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        500,
      );
    }
    return true;
  }

  disposeAll() {
    const errors = [];
    for (const [conversationId, entry] of this.#entries) {
      try {
        entry.session.dispose();
      } catch (error) {
        errors.push(`${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const released = this.#entries.size;
    this.#entries.clear();
    if (errors.length > 0) {
      throw new PersistentSessionError(
        "session_disposal_failed",
        `Failed to dispose ${errors.length} persistent session(s): ${errors.join("; ")}`,
        500,
      );
    }
    return released;
  }
}
