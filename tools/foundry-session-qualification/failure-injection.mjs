import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TARGET_ROUTE,
  gradeAttempt,
  loadCorpus,
  sha256File,
  writeJson,
} from "./qualification-lib.mjs";

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function observeUnavailable() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  try {
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    return { observable: false, reason: null };
  } catch (error) {
    return { observable: true, reason: error.cause?.code ?? error.name };
  }
}

async function observeTerminatedStream({ midStream }) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (midStream) {
      response.write(
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      );
    }
    response.socket.destroy();
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    await response.text();
    return { observable: false, reason: null };
  } catch (error) {
    return { observable: true, reason: error.cause?.code ?? error.name };
  } finally {
    await close(server);
  }
}

function makeValidRun(stagedPath) {
  const hash = sha256File(stagedPath);
  return {
    run_id: "injection-run",
    status: "COMPLETED",
    exit_code: 0,
    runtime: TARGET_ROUTE.runtime,
    model: TARGET_ROUTE.model,
    stream: TARGET_ROUTE.stream,
    profile: TARGET_ROUTE.profile,
    task_mode: TARGET_ROUTE.task_mode,
    max_prompt_tokens: TARGET_ROUTE.max_prompt_tokens,
    tools: TARGET_ROUTE.tools,
    route_qualified: false,
    unqualified_route_override: true,
    staged_inputs: [{
      staged_path: stagedPath,
      sha256: hash,
      source_sha256: hash,
      staged_sha256: hash,
    }],
  };
}

function goodProviderEvents() {
  return [
    {
      event: "request_started",
      request_id: "request-1",
      resolved_model: TARGET_ROUTE.model,
    },
    {
      event: "request_completed",
      request_id: "request-1",
      resolved_model: TARGET_ROUTE.model,
      finish_reason: "stop",
      usage: { total_tokens: 12 },
    },
  ];
}

export async function runFailureInjection({ manifestPath, outputRoot }) {
  const { manifest } = loadCorpus(manifestPath);
  const fixture = manifest.fixtures[0];
  mkdirSync(outputRoot, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "sealed-delegation-injection-"));
  try {
    const stagedPath = join(temporary, "source.md");
    writeFileSync(stagedPath, readFileSync(
      resolve(dirname(manifestPath), fixture.source),
    ));
    const exactRaw = JSON.stringify(fixture.expected);
    const baseRun = makeValidRun(stagedPath);
    const unavailable = await observeUnavailable();
    const afterHeaders = await observeTerminatedStream({ midStream: false });
    const midStream = await observeTerminatedStream({ midStream: true });

    const cases = [
      {
        id: "adapter-unavailable",
        observation: unavailable,
        run: null,
        raw: "",
        providerEvents: [],
        expectedNonzeroExit: true,
      },
      {
        id: "terminate-after-sse-headers",
        observation: afterHeaders,
        run: { ...baseRun, status: "FAILED", exit_code: 1 },
        raw: "",
        providerEvents: [
          {
            event: "request_started",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
          },
          {
            event: "request_failed",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
            finish_reason: null,
            headers_sent: true,
            error: "transport terminated after headers",
          },
        ],
        expectedNonzeroExit: true,
      },
      {
        id: "terminate-mid-stream",
        observation: midStream,
        run: { ...baseRun, status: "FAILED", exit_code: 1 },
        raw: "partial",
        providerEvents: [
          {
            event: "request_started",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
          },
          {
            event: "request_failed",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
            finish_reason: null,
            headers_sent: true,
            error: "transport terminated mid-stream",
          },
        ],
        expectedNonzeroExit: true,
      },
      {
        id: "sdk-finish-length",
        observation: { observable: true, reason: "provider_finish_length" },
        run: baseRun,
        raw: exactRaw,
        providerEvents: [
          {
            event: "request_started",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
          },
          {
            event: "request_completed",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
            finish_reason: "length",
          },
        ],
        expectedNonzeroExit: false,
      },
      {
        id: "sdk-finish-error",
        observation: { observable: true, reason: "provider_finish_error" },
        run: { ...baseRun, status: "FAILED", exit_code: 1 },
        raw: "",
        providerEvents: [
          {
            event: "request_started",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
          },
          {
            event: "request_failed",
            request_id: "request-1",
            resolved_model: TARGET_ROUTE.model,
            finish_reason: "error",
            error: "Foundry Local ended generation with an error.",
          },
        ],
        expectedNonzeroExit: true,
      },
      {
        id: "empty-output",
        observation: { observable: true, reason: "empty_output" },
        run: baseRun,
        raw: "",
        providerEvents: goodProviderEvents(),
        expectedNonzeroExit: false,
      },
      {
        id: "malformed-json-output",
        observation: { observable: true, reason: "malformed_json_output" },
        run: baseRun,
        raw: '{"status":"blocked"',
        providerEvents: goodProviderEvents(),
        expectedNonzeroExit: false,
      },
      {
        id: "raw-tool-call-markup",
        observation: { observable: true, reason: "raw_tool_markup" },
        run: baseRun,
        raw: '<tool_call>{"name":"view","arguments":{}}</tool_call>',
        providerEvents: goodProviderEvents(),
        expectedNonzeroExit: false,
      },
      {
        id: "wrong-model-id",
        observation: { observable: true, reason: "model_mismatch" },
        run: { ...baseRun, model: "qwen2.5-7b-instruct-generic-gpu" },
        raw: exactRaw,
        providerEvents: [{
          event: "request_rejected",
          request_id: "request-1",
          resolved_model: "qwen2.5-7b-instruct-generic-gpu",
          reason: "unrecognized_model",
        }],
        expectedNonzeroExit: false,
      },
      {
        id: "child-timeout",
        observation: { observable: true, reason: "launcher_status_timeout" },
        run: { ...baseRun, status: "TIMEOUT", exit_code: 124 },
        raw: "",
        providerEvents: [{
          event: "request_started",
          request_id: "request-1",
          resolved_model: TARGET_ROUTE.model,
        }],
        expectedNonzeroExit: true,
      },
    ];

    const results = cases.map((testCase) => {
      const gate = gradeAttempt({
        fixture,
        run: testCase.run,
        raw: testCase.raw,
        providerEvents: testCase.providerEvents,
      });
      const failureExitCode = gate.gate_accepted ? 0 : 1;
      const passed =
        testCase.observation.observable === true &&
        gate.gate_accepted === false &&
        gate.authority_advanced === false &&
        (!testCase.expectedNonzeroExit ||
          testCase.run === null ||
          Number(testCase.run.exit_code) !== 0) &&
        failureExitCode !== 0;
      const result = {
        id: testCase.id,
        observable: testCase.observation.observable,
        observation_reason: testCase.observation.reason,
        launcher_status: testCase.run?.status ?? "NO_RECEIPT",
        launcher_exit_code: testCase.run?.exit_code ?? 1,
        gate_accepted: gate.gate_accepted,
        gate_failure_reasons: gate.failure_reasons,
        failure_exit_code: failureExitCode,
        authority_advanced: gate.authority_advanced,
        passed,
      };
      writeJson(join(outputRoot, `${testCase.id}.json`), result);
      return result;
    });
    const summary = {
      schema_version: "sealed-delegation/session-failure-injection/v1",
      generated_at: new Date().toISOString(),
      case_count: results.length,
      passed_count: results.filter((result) => result.passed).length,
      passed: results.every((result) => result.passed),
      authority_advanced: false,
      cases: results,
    };
    assert.equal(summary.case_count, 10);
    writeJson(join(outputRoot, "summary.json"), summary);
    return summary;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestIndex = process.argv.indexOf("--manifest");
  const outputIndex = process.argv.indexOf("--output");
  const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const manifestPath = resolve(
    manifestIndex >= 0 ? process.argv[manifestIndex + 1] : join(here, "corpus/manifest.json"),
  );
  const outputRoot = resolve(
    outputIndex >= 0 ? process.argv[outputIndex + 1] : join(here, "results/failure-injection"),
  );
  const summary = await runFailureInjection({ manifestPath, outputRoot });
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.passed ? 0 : 1;
}
