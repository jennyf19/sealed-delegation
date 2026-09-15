import http from "node:http";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  ChatSession,
  FoundryLocalManager,
  Item,
  Request,
} from "foundry-local-sdk";

const debugEnabled = process.env.FOUNDRY_ADAPTER_DEBUG === "1";
const receiptPath = process.env.FOUNDRY_ADAPTER_RECEIPT_PATH;

function debug(event, details) {
  if (debugEnabled) {
    console.error(JSON.stringify({ event, ...details }));
  }
}

function recordProviderEvent(event) {
  if (!receiptPath) return;
  appendFileSync(
    receiptPath,
    `${JSON.stringify({ recorded_at: new Date().toISOString(), ...event })}\n`,
  );
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function addOpenAiMessages(request, messages) {
  for (const message of messages ?? []) {
    const content = textContent(message.content);
    if (message.role === "tool") {
      request.addItem(
        Item.toolResult(message.tool_call_id ?? "", content),
      );
    } else {
      if (content) {
        request.addItem(Item.message(message.role, content));
      }
    }

    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        request.addItem(
          Item.toolCall(
            call.id,
            call.function?.name ?? "",
            call.function?.arguments ?? "{}",
          ),
        );
      }
    }
  }
  return request;
}

export function selectedOpenAiTools(tools, toolChoice) {
  if (!toolChoice || typeof toolChoice === "string") return tools ?? [];
  const requestedName = toolChoice.function?.name;
  if (!requestedName) {
    throw new Error("Named tool_choice must include function.name.");
  }
  const selected = (tools ?? []).filter(
    (tool) => tool?.type === "function" && tool.function?.name === requestedName,
  );
  if (selected.length !== 1) {
    throw new Error(`Named tool_choice '${requestedName}' is not uniquely defined.`);
  }
  return selected;
}

export function addOpenAiTools(session, tools, toolChoice) {
  for (const tool of selectedOpenAiTools(tools, toolChoice)) {
    if (tool?.type !== "function" || !tool.function?.name) continue;
    session.addToolDefinition({
      name: tool.function.name,
      description: tool.function.description ?? "",
      jsonSchema: JSON.stringify(
        tool.function.parameters ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      ),
    });
  }
  return session;
}

export function toRequestOptions(body) {
  const requestedToolChoice =
    typeof body.tool_choice === "string"
      ? body.tool_choice
      : body.tool_choice
        ? "required"
        : "auto";
  const options = {
    search: {
      maxOutputTokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
    },
    toolChoice: requestedToolChoice,
  };
  if (typeof body.temperature === "number") {
    options.search.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") {
    options.search.topP = body.top_p;
  }
  return options;
}

export function stripToolCallMarkup(text) {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();
}

export function unwrapNonToolCallEnvelope(text) {
  const match = text.trim().match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/);
  if (!match) return text;
  try {
    const value = JSON.parse(match[1]);
    const entries = Array.isArray(value) ? value : [value];
    const isToolPayload =
      entries.length > 0 &&
      entries.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.name === "string" &&
          ("arguments" in entry || "parameters" in entry),
      );
    return isToolPayload ? text : match[1].trim();
  } catch {
    return text;
  }
}

export function toOpenAiFinishReason(finishReason) {
  switch (finishReason) {
    case "toolCalls":
      return "tool_calls";
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "error": {
      const error = new Error("Foundry Local ended generation with an error.");
      error.foundryFinishReason = finishReason;
      throw error;
    }
    case "none": {
      const error = new Error("Foundry Local ended generation without a terminal reason.");
      error.foundryFinishReason = finishReason;
      throw error;
    }
    default: {
      const error = new Error(`Unsupported Foundry Local finish reason: ${finishReason}`);
      error.foundryFinishReason = finishReason;
      throw error;
    }
  }
}

function completionId() {
  return `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function itemDelta(item, toolIndex) {
  if (item.type === "text") {
    return { content: item.text };
  }
  if (item.type === "message") {
    return { content: textContent(item.content ?? item.parts) };
  }
  if (item.type === "toolCall") {
    return {
      tool_calls: [
        {
          index: toolIndex,
          id: item.callId,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        },
      ],
    };
  }
  return null;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) {
      throw new Error("Request body exceeds 4 MiB.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleCompletion(
  res,
  model,
  body,
  {
    requestId,
    createSession = (selectedModel) => new ChatSession(selectedModel),
    createRequest = () => new Request(),
    recordEvent = recordProviderEvent,
  } = {},
) {
  const session = createSession(model);
  try {
    debug("request", {
      stream: Boolean(body.stream),
      messageRoles: (body.messages ?? []).map((message) => message.role),
      toolCount: body.tools?.length ?? 0,
      toolChoice: body.tool_choice ?? "auto",
    });
    addOpenAiTools(session, body.tools, body.tool_choice);
    const request = addOpenAiMessages(createRequest(), body.messages);
    request.setOptions(toRequestOptions(body));

    const id = completionId();
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: model.id,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });

      const stream = session.processStreamingRequest(request);
      let toolIndex = 0;
      const outputTypes = [];
      let streamedText = "";
      const emittedToolCallIds = new Set();
      for await (const item of stream) {
        outputTypes.push(item.type);
        const delta = itemDelta(item, toolIndex);
        if (!delta) continue;
        if (item.type === "toolCall") {
          emittedToolCallIds.add(item.callId);
          toolIndex += 1;
        } else if (delta.content) {
          streamedText += delta.content;
          continue;
        }
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: model.id,
          choices: [{ index: 0, delta, finish_reason: null }],
        });
      }
      const response = await stream.response;
      const finishReason = toOpenAiFinishReason(response.finishReason);
      for (const item of response.output) {
        if (
          item.type === "toolCall" &&
          !emittedToolCallIds.has(item.callId)
        ) {
          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [
              { index: 0, delta: itemDelta(item, toolIndex), finish_reason: null },
            ],
          });
          emittedToolCallIds.add(item.callId);
          toolIndex += 1;
        }
      }
      const terminalText = response.output
        .map((item) => itemDelta(item, toolIndex)?.content ?? "")
        .join("");
      const combinedText = streamedText || terminalText;
      const content =
        emittedToolCallIds.size > 0
          ? stripToolCallMarkup(combinedText)
          : unwrapNonToolCallEnvelope(combinedText);
      if (content) {
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: model.id,
          choices: [
            { index: 0, delta: { content }, finish_reason: null },
          ],
        });
      }
      debug("response", {
        stream: true,
        finishReason: response.finishReason,
        outputTypes,
        terminalOutputTypes: response.output.map((item) => item.type),
      });
      recordEvent({
        event: "request_completed",
        request_id: requestId,
        requested_model: body.model,
        resolved_model: model.id,
        stream: true,
        finish_reason: response.finishReason,
        usage: {
          prompt_tokens: response.usage.promptTokens,
          completion_tokens: response.usage.completionTokens,
          total_tokens: response.usage.totalTokens,
        },
      });
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: model.id,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: response.usage.promptTokens,
          completion_tokens: response.usage.completionTokens,
          total_tokens: response.usage.totalTokens,
        },
      });
      res.end("data: [DONE]\n\n");
      return;
    }

    const response = await session.processRequest(request);
    const finishReason = toOpenAiFinishReason(response.finishReason);
    debug("response", {
      stream: false,
      finishReason: response.finishReason,
      outputTypes: response.output.map((item) => item.type),
    });
    recordEvent({
      event: "request_completed",
      request_id: requestId,
      requested_model: body.model,
      resolved_model: model.id,
      stream: false,
      finish_reason: response.finishReason,
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
      },
    });
    const toolCalls = response.output
      .filter((item) => item.type === "toolCall")
      .map((item) => ({
        id: item.callId,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      }));
    const rawText = response.output
      .map((item) => itemDelta(item, 0)?.content ?? "")
      .join("");
    const text =
      toolCalls.length > 0
        ? stripToolCallMarkup(rawText)
        : unwrapNonToolCallEnvelope(rawText);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: model.id,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text,
              tool_calls: toolCalls,
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: response.usage.promptTokens,
          completion_tokens: response.usage.completionTokens,
          total_tokens: response.usage.totalTokens,
        },
      }),
    );
  } finally {
    session.dispose();
  }
}

export async function startAdapterServer({
  host = "127.0.0.1",
  port = 0,
  model,
  acceptedModelIds = [],
  createSession = (selectedModel) => new ChatSession(selectedModel),
  createRequest = () => new Request(),
  recordEvent = recordProviderEvent,
  onClose = async () => {},
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("The Session adapter must bind to a loopback host.");
  }
  if (!model?.id) throw new Error("The Session adapter requires a resolved model.");

  const acceptedModels = new Set([
    ...acceptedModelIds,
    model.id,
    model.id.split(":")[0],
  ]);
  const server = http.createServer(async (req, res) => {
    const requestId = completionId();
    try {
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: model.id, object: "model", owned_by: "foundry-local" }],
          }),
        );
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = await readJson(req);
        if (!acceptedModels.has(body.model)) {
          recordEvent({
            event: "request_rejected",
            request_id: requestId,
            requested_model: body.model,
            resolved_model: model.id,
            reason: "unrecognized_model",
          });
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unrecognized model." } }));
          return;
        }
        recordEvent({
          event: "request_started",
          request_id: requestId,
          requested_model: body.model,
          resolved_model: model.id,
          stream: Boolean(body.stream),
        });
        await handleCompletion(res, model, body, {
          requestId,
          createSession,
          createRequest,
          recordEvent,
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found." } }));
    } catch (error) {
      recordEvent({
        event: "request_failed",
        request_id: requestId,
        resolved_model: model.id,
        finish_reason: error?.foundryFinishReason ?? null,
        headers_sent: res.headersSent,
        error: error instanceof Error ? error.message : String(error),
      });
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const baseUrl = `http://${host}:${address.port}/v1`;
  return {
    baseUrl,
    model,
    async close() {
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => {
        const forceTimer = setTimeout(() => {
          server.closeAllConnections?.();
        }, 2000);
        server.close((error) => {
          clearTimeout(forceTimer);
          if (error) reject(error);
          else resolve();
        });
      });
      await onClose();
    },
  };
}

export async function startAdapter({
  host = "127.0.0.1",
  port = 0,
  modelAlias = "qwen2.5-7b",
  modelCacheDir,
  libraryPath,
  recordEvent = recordProviderEvent,
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("The Session adapter must bind to a loopback host.");
  }
  const manager = FoundryLocalManager.create({
    appName: "sealed-delegation-session-adapter",
    disableNonessentialTelemetry: true,
    ...(modelCacheDir ? { modelCacheDir } : {}),
    ...(libraryPath ? { libraryPath } : {}),
  });
  try {
    await manager.downloadAndRegisterEps();
    const model = await manager.catalog.getModel(modelAlias);
    if (!model.isCached) await model.download();
    await model.load();
    return await startAdapterServer({
      host,
      port,
      model,
      acceptedModelIds: [modelAlias],
      recordEvent,
      onClose: async () => {
        try {
          if (await model.isLoaded()) await model.unload();
        } finally {
          manager.dispose();
        }
      },
    });
  } catch (error) {
    manager.dispose();
    throw error;
  }
}

async function main() {
  const adapter = await startAdapter({
    host: process.env.FOUNDRY_ADAPTER_HOST ?? "127.0.0.1",
    port: Number(process.env.FOUNDRY_ADAPTER_PORT ?? 0),
    modelAlias: process.env.FOUNDRY_MODEL ?? "qwen2.5-7b",
    modelCacheDir: process.env.FOUNDRY_MODEL_CACHE,
    libraryPath: process.env.FOUNDRY_LIBRARY_PATH,
  });
  console.log(
    JSON.stringify({
      status: "READY",
      baseUrl: adapter.baseUrl,
      model: adapter.model.id,
    }),
  );

  const shutdown = async () => {
    await adapter.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
