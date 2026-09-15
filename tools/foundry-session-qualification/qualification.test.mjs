import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runFailureInjection } from "./failure-injection.mjs";
import {
  TARGET_ROUTE,
  gradeAttempt,
  loadCorpus,
  renderTask,
  sha256File,
  sha256NormalizedText,
  validateCorpus,
} from "./qualification-lib.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = join(here, "corpus", "manifest.json");

test("validates the frozen 20-case corpus", () => {
  const receipt = validateCorpus(manifestPath);
  assert.equal(receipt.valid, true, receipt.errors.join("\n"));
  assert.equal(receipt.fixture_count, 20);
  assert.equal(receipt.distinct_domain_count, 20);
  assert.deepEqual(receipt.expected_option_positions, [7, 6, 7]);
  assert.equal(receipt.uniquely_longest_expected_count, 2);
  assert.match(receipt.corpus_sha256, /^[a-f0-9]{64}$/);
});

test("normalizes line endings at the corpus approval boundary", () => {
  assert.equal(
    sha256NormalizedText("alpha\r\nbeta\r\n"),
    sha256NormalizedText("alpha\nbeta\n"),
  );
});

test("renders every task without unresolved placeholders", () => {
  const { manifest, promptTemplate } = loadCorpus(manifestPath);
  for (const fixture of manifest.fixtures) {
    const task = renderTask(promptTemplate, fixture, fixture.source.split("/").at(-1));
    assert.doesNotMatch(task, /\{\{[^}]+\}\}/);
    assert.match(task, new RegExp(fixture.source_citation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(
      task,
      new RegExp(fixture.expected.missing_input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    for (const code of fixture.missing_input_options) {
      assert.match(task, new RegExp(`- ${code}`));
    }
  }
});

test("rejects all deterministic failure injections", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "sealed-delegation-injection-results-"));
  try {
    const summary = await runFailureInjection({ manifestPath, outputRoot });
    assert.equal(summary.case_count, 13);
    assert.equal(summary.passed_count, 13);
    assert.equal(summary.passed, true);
    assert.equal(summary.authority_advanced, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("never accepts a semantically coded answer without provider telemetry", () => {
  const { manifest } = loadCorpus(manifestPath);
  const fixture = manifest.fixtures[0];
  const gate = gradeAttempt({
    fixture,
    run: null,
    raw: JSON.stringify(fixture.expected),
    providerEvents: [],
  });
  assert.equal(gate.gate_accepted, false);
  assert.equal(gate.authority_advanced, false);
  assert.ok(gate.failure_reasons.includes("provider_telemetry_missing"));
});

test("accepts a paraphrase with the correct frozen meaning code", () => {
  const temporary = mkdtempSync(join(tmpdir(), "sealed-delegation-positive-control-"));
  try {
    const { manifest } = loadCorpus(manifestPath);
    const fixture = manifest.fixtures[0];
    const stagedPath = join(temporary, "source.md");
    writeFileSync(
      stagedPath,
      readFileSync(join(here, "corpus", fixture.source)),
    );
    const hash = sha256File(stagedPath);
    const run = {
      run_id: "positive-control",
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
    const providerEvents = [
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
      },
    ];
    const gate = gradeAttempt({
      fixture,
      run,
      raw: JSON.stringify({
        ...fixture.expected,
        missing_input: "the originating locale's time-zone designation",
      }),
      providerEvents,
    });
    assert.equal(gate.gate_accepted, true, gate.failure_reasons.join(", "));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects a fluent description with the wrong meaning code", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "sealed-delegation-wrong-code-"));
  try {
    const { manifest } = loadCorpus(manifestPath);
    const fixture = manifest.fixtures[0];
    const stagedPath = join(outputRoot, "source.md");
    writeFileSync(stagedPath, readFileSync(join(here, "corpus", fixture.source)));
    const hash = sha256File(stagedPath);
    const gate = gradeAttempt({
      fixture,
      run: {
        run_id: "wrong-code-control",
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
      },
      raw: JSON.stringify({
        ...fixture.expected,
        missing_input_code: fixture.missing_input_options[0],
        missing_input: "source time-zone information",
      }),
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
          finish_reason: "stop",
        },
      ],
    });

    test("report rejects attempts from a different corpus or gate schema", () => {
      const outputRoot = mkdtempSync(join(tmpdir(), "sealed-delegation-stale-report-"));
      try {
        const attemptRoot = join(outputRoot, "timezone-source-zone", "attempt-001");
        mkdirSync(attemptRoot, { recursive: true });
        writeFileSync(join(attemptRoot, "attempt.json"), JSON.stringify({
          fixture_id: "timezone-source-zone",
          attempt_number: 1,
          corpus_sha256: "stale-corpus",
          launcher_receipt: null,
        }));
        writeFileSync(join(attemptRoot, "gate.json"), JSON.stringify({
          schema_version: "sealed-delegation/session-qualification-gate/v1",
          gate_accepted: true,
          authority_advanced: false,
        }));
        const outputPath = join(outputRoot, "analysis.json");
        const result = spawnSync(
          process.execPath,
          [
            join(here, "report.mjs"),
            "--manifest", manifestPath,
            "--results", outputRoot,
            "--output", outputPath,
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 1);
        const analysis = JSON.parse(readFileSync(outputPath, "utf8"));
        assert.equal(analysis.raw_attempt_count, 0);
        assert.equal(analysis.stale_attempt_count, 1);
        assert.equal(analysis.promotion_gate.no_stale_or_mixed_attempts, false);
      } finally {
        rmSync(outputRoot, { recursive: true, force: true });
      }
    });
    assert.equal(gate.gate_accepted, false);
    assert.deepEqual(gate.failure_reasons, ["missing_input_code_mismatch"]);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
