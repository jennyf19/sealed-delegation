import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startAdapterServer } from "../foundry-session-probe/adapter.mjs";
import { executeLauncherAttempt } from "./attempt-execution.mjs";
import {
  classifyFailureInjection,
  failureInjectionSpecifications,
} from "./failure-injection-lib.mjs";
import {
  TARGET_ROUTE,
  findCorpusFileReceipt,
  loadCorpus,
  validateCorpus,
  validateEnvironmentReceipt,
  writeJson,
} from "./qualification-lib.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function fakeRequest() {
  return {
    addItem() { return this; },
    setOptions() { return this; },
    cancel() {},
  };
}

function fakeSession({ finishReason = "stop", text = "" }) {
  const response = {
    finishReason,
    output: text ? [{ type: "text", text }] : [],
    usage: {
      promptTokens: 1,
      completionTokens: text ? 1 : 0,
      totalTokens: text ? 2 : 1,
    },
  };
  return {
    addToolDefinition() {},
    processStreamingRequest() {
      const stream = (async function* () {})();
      stream.response = Promise.resolve(response);
      return stream;
    },
    dispose() {},
  };
}

async function unavailableEndpoint() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {},
  };
}

async function transportEndpoint({ midStream = false, hang = false, recordEvent }) {
  let resolveTerminal;
  const terminal = new Promise((resolvePromise) => {
    resolveTerminal = resolvePromise;
  });
  const server = createServer((request, response) => {
    const requestId = `injection-${crypto.randomUUID()}`;
    let terminalRecorded = false;
    recordEvent({
      event: "request_started",
      request_id: requestId,
      requested_model: TARGET_ROUTE.model,
      resolved_model: TARGET_ROUTE.model,
      stream: true,
    });
    response.on("close", () => {
      if (hang && !terminalRecorded) {
        terminalRecorded = true;
        recordEvent({
          event: "request_failed",
          request_id: requestId,
          resolved_model: TARGET_ROUTE.model,
          finish_reason: null,
          headers_sent: response.headersSent,
          error: "client disconnected during injected timeout",
        });
        resolveTerminal();
      }
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (hang) return;
    if (midStream) {
      response.write(
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      );
    }
    recordEvent({
      event: "request_failed",
      request_id: requestId,
      resolved_model: TARGET_ROUTE.model,
      finish_reason: null,
      headers_sent: true,
      error: midStream
        ? "transport terminated mid-stream"
        : "transport terminated after headers",
    });
    terminalRecorded = true;
    resolveTerminal();
    response.socket.destroy();
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close() {
      await closeServer(server);
      let terminalTimer;
      const terminalResult = await Promise.race([
        terminal.then(() => "recorded"),
        new Promise((resolvePromise) => {
          terminalTimer = setTimeout(() => resolvePromise("timeout"), 1000);
        }),
      ]).finally(() => clearTimeout(terminalTimer));
      if (terminalResult !== "recorded") {
        throw new Error("Injected transport did not record a terminal event.");
      }
    },
  };
}

async function adapterEndpoint({
  text = "",
  finishReason = "stop",
  modelId = TARGET_ROUTE.model,
  recordEvent,
}) {
  const adapter = await startAdapterServer({
    model: { id: modelId },
    createSession: () => fakeSession({ finishReason, text }),
    createRequest: fakeRequest,
    recordEvent,
  });
  return {
    baseUrl: adapter.baseUrl,
    close: () => adapter.close(),
  };
}

async function withHealthProbe(endpoint) {
  const upstreamRequests = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      // Forward malformed payloads unchanged.
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: TARGET_ROUTE.model, object: "model", owned_by: "fault-adapter" }],
      }));
      return;
    }
    const messages = parsed?.messages;
    const isHealthProbe =
      request.method === "POST" &&
      request.url === "/v1/chat/completions" &&
      Array.isArray(messages) &&
      messages.length === 1 &&
      messages[0]?.role === "user" &&
      messages[0]?.content === "Reply exactly READY";
    if (isHealthProbe) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "health-probe",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: TARGET_ROUTE.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "READY" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }

    const upstreamUrl = new URL(request.url, endpoint.baseUrl);
    const upstream = httpRequest(upstreamUrl, {
      method: request.method,
      headers: {
        ...request.headers,
        host: upstreamUrl.host,
      },
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.on("error", (error) => response.destroy(error));
      upstreamResponse.pipe(response);
    });
    upstreamRequests.add(upstream);
    upstream.once("close", () => upstreamRequests.delete(upstream));
    upstream.once("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: error.message } }));
      } else {
        response.destroy(error);
      }
    });
    upstream.end(body);
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close() {
      for (const request of upstreamRequests) request.destroy();
      await closeServer(server);
      await endpoint.close();
    },
  };
}

async function startFailureEndpoint(testCase, recordEvent) {
  let endpoint;
  switch (testCase.mode) {
    case "unavailable":
      endpoint = await unavailableEndpoint();
      break;
    case "transport":
      endpoint = await transportEndpoint({
        midStream: testCase.midStream,
        hang: testCase.hang,
        recordEvent,
      });
      break;
    case "adapter":
      endpoint = await adapterEndpoint({
        text: testCase.text,
        finishReason: testCase.finishReason,
        modelId: testCase.modelId,
        recordEvent,
      });
      break;
    default:
      throw new Error(`Unsupported failure-injection mode: ${testCase.mode}`);
  }
  return withHealthProbe(endpoint);
}

export async function runFailureInjection({
  manifestPath,
  outputRoot,
  environmentPath,
  pinnedCopilot,
  repoRoot,
  selectedCaseIds = [],
}) {
  const { manifest, promptTemplate } = loadCorpus(manifestPath);
  const corpus = validateCorpus(manifestPath);
  if (!corpus.valid) {
    throw new Error(`Corpus validation failed: ${corpus.errors.join("; ")}`);
  }
  const environment = JSON.parse(readFileSync(environmentPath, "utf8"));
  const environmentValidation = validateEnvironmentReceipt(environment, corpus);
  if (!environmentValidation.valid) {
    throw new Error(
      `Failure injection environment is invalid: ${environmentValidation.errors.join("; ")}`,
    );
  }
  const fixture = manifest.fixtures[0];
  const approvedSource = findCorpusFileReceipt(environment.corpus, fixture.source);
  if (!approvedSource) throw new Error("Approved source receipt is missing.");
  const sourcePath = resolve(dirname(manifestPath), fixture.source);
  const launcherPath = join(
    repoRoot,
    ".github/skills/local-agent-delegation/scripts/invoke_local_agent.ps1",
  );
  mkdirSync(outputRoot, { recursive: true });
  const results = [];
  const selectedCases = new Set(selectedCaseIds);
  const cases = failureInjectionSpecifications(fixture).filter((testCase) =>
    selectedCases.size === 0 || selectedCases.has(testCase.id));
  if (selectedCases.size > 0 && cases.length !== selectedCases.size) {
    throw new Error("One or more requested failure-injection cases are unknown.");
  }

  for (const testCase of cases) {
    const caseRoot = join(outputRoot, testCase.id);
    if (existsSync(caseRoot)) {
      throw new Error(
        `${testCase.id}: result already exists; failure injections never overwrite evidence.`,
      );
    }
    mkdirSync(caseRoot);
    const attemptRoot = join(caseRoot, "attempt-001");
    const providerPath = join(attemptRoot, "provider-events.jsonl");
    const recordEvent = (event) => {
      appendFileSync(providerPath, `${JSON.stringify({
        recorded_at: new Date().toISOString(),
        fixture_id: fixture.id,
        attempt_number: 1,
        ...event,
      })}\n`);
    };
    const endpoint = await startFailureEndpoint(testCase, recordEvent);
    let endpointClosed = false;
    try {
      const execution = await executeLauncherAttempt({
        attemptRoot,
        fixture,
        attemptNumber: 1,
        retryReason: `failure_injection:${testCase.id}`,
        sourcePath,
        approvedSource,
        promptTemplate,
        repoRoot,
        launcherPath,
        baseUrl: endpoint.baseUrl,
        modelAlias: environment.model_cache.alias,
        pinnedCopilot,
        timeoutSeconds: testCase.timeoutSeconds ?? 30,
        environment,
        approvedCorpus: environment.corpus,
        beforeGrade: async () => {
          await endpoint.close();
          endpointClosed = true;
        },
      });
      const result = classifyFailureInjection(testCase, execution);
      writeJson(join(caseRoot, "result.json"), result);
      results.push(result);
    } finally {
      if (!endpointClosed) await endpoint.close();
    }
  }

  const summary = {
    schema_version: "sealed-delegation/session-failure-injection/v3",
    generated_at: new Date().toISOString(),
    execution_path: "runner-launcher-adapter-receipt",
    complete_suite: selectedCases.size === 0,
    case_count: results.length,
    passed_count: results.filter((result) => result.passed).length,
    passed: results.every((result) => result.passed),
    authority_advanced: false,
    cases: results,
  };
  assert.equal(summary.case_count, selectedCases.size === 0 ? 13 : selectedCases.size);
  writeJson(join(outputRoot, "summary.json"), summary);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const manifestPath = resolve(
    valueAfter("--manifest") ?? join(here, "corpus/manifest.json"),
  );
  const outputRoot = resolve(
    valueAfter("--output") ?? join(here, "results/failure-injection"),
  );
  const environmentPath = resolve(valueAfter("--environment") ?? "");
  if (!valueAfter("--environment")) {
    throw new Error("--environment is required for sealed failure injection.");
  }
  const environment = JSON.parse(readFileSync(environmentPath, "utf8"));
  const pinnedCopilot = resolve(
    valueAfter("--copilot-executable") ?? environment.copilot?.executable ?? "",
  );
  if (!existsSync(pinnedCopilot)) {
    throw new Error("Pinned Copilot executable is missing.");
  }
  const repoRoot = resolve(valueAfter("--repository-root") ?? join(here, "../.."));
  const summary = await runFailureInjection({
    manifestPath,
    outputRoot,
    environmentPath,
    pinnedCopilot,
    repoRoot,
    selectedCaseIds: valuesAfter("--case"),
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.passed ? 0 : 1;
}
