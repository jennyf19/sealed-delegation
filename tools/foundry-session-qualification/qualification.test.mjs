import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyFailureInjection,
  failureInjectionSpecifications,
} from "./failure-injection-lib.mjs";
import {
  TARGET_ROUTE,
  gradeAttempt,
  loadCorpus,
  renderTask,
  sha256Bytes,
  sha256File,
  sha256NormalizedText,
  validateCorpus,
  validateEnvironmentReceipt,
} from "./qualification-lib.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = join(here, "corpus", "manifest.json");
const repoRoot = resolve(here, "../..");

function treeReceipt(root, paths) {
  const files = paths
    .map((path) => ({
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: sha256File(path),
      size_bytes: readFileSync(path).length,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    path: root,
    tree_sha256: sha256Bytes(
      files.map((file) => `${file.path}\0${file.sha256}`).join("\n"),
    ),
    file_count: files.length,
    files,
  };
}

function textReceipt(path) {
  return {
    path,
    sha256: sha256NormalizedText(readFileSync(path, "utf8")),
    hash_mode: "utf8-lf",
  };
}

function createEnvironmentFixture(root, corpus) {
  const copilotPath = join(root, "copilot.exe");
  const foundryPath = join(root, "foundry.exe");
  const modelCacheRoot = join(root, "model-cache");
  const modelRoot = join(
    modelCacheRoot,
    "Microsoft",
    "qwen2.5-7b-instruct-generic-gpu-4",
    "v4",
  );
  const nativeRoot = join(root, "native");
  const sdkRoot = join(root, "foundry-local-sdk");
  mkdirSync(modelRoot, { recursive: true });
  mkdirSync(nativeRoot, { recursive: true });
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(copilotPath, "pinned-copilot");
  writeFileSync(foundryPath, "pinned-foundry");
  const modelPath = join(modelRoot, "model.bin");
  const nativePath = join(nativeRoot, "runtime.dll");
  const sdkPath = join(sdkRoot, "index.js");
  writeFileSync(modelPath, "model-contents");
  writeFileSync(nativePath, "native-runtime");
  writeFileSync(sdkPath, "sdk-runtime");
  const catalogPath = join(modelCacheRoot, "foundry.modelinfo.json");
  const catalogModel = {
    id: TARGET_ROUTE.model,
    uri: "azureml://registries/azureml/models/qwen2.5-7b-instruct-generic-gpu/versions/4",
    publisher: "Microsoft",
    name: "qwen2.5-7b-instruct-generic-gpu",
    version: 4,
  };
  writeFileSync(catalogPath, JSON.stringify({
    models: [catalogModel],
  }));
  const catalogEntrySha256 = sha256Bytes([
    catalogModel.id,
    catalogModel.uri,
    catalogModel.publisher,
    catalogModel.name,
    catalogModel.version,
  ].join("\0"));
  const packageLockPath = join(
    repoRoot,
    "tools",
    "foundry-session-probe",
    "package-lock.json",
  );
  const requiredFiles = [
    join(repoRoot, ".github", "skills", "local-agent-delegation", "references", "approved-routes.json"),
    join(repoRoot, ".github", "skills", "local-agent-delegation", "scripts", "invoke_local_agent.ps1"),
    join(repoRoot, ".github", "skills", "local-agent-delegation", "scripts", "output_policy.ps1"),
    join(repoRoot, ".github", "skills", "local-agent-delegation", "scripts", "route_policy.ps1"),
    join(repoRoot, "tools", "foundry-session-probe", "adapter.mjs"),
    packageLockPath,
    join(here, "attempt-execution.mjs"),
    manifestPath,
    join(here, "environment-receipt.ps1"),
    join(here, "failure-injection-lib.mjs"),
    join(here, "failure-injection.mjs"),
    join(here, "grader.mjs"),
    join(here, "prompt-template.txt"),
    join(here, "qualification-lib.mjs"),
    join(here, "report.mjs"),
    join(here, "runner.mjs"),
    join(here, "validate-corpus.mjs"),
  ];
  return {
    schema_version: "sealed-delegation/session-environment/v2",
    repository: {
      root: repoRoot,
      commit_sha: "a".repeat(40),
      branch: "qualification-test",
      clean: true,
    },
    route: TARGET_ROUTE,
    copilot: {
      executable: copilotPath,
      executable_sha256: sha256File(copilotPath),
      version_output: "GitHub Copilot CLI test",
    },
    foundry_cli: {
      executable: foundryPath,
      executable_sha256: sha256File(foundryPath),
      version: "0.10.3",
      cache_location: modelCacheRoot,
    },
    foundry_sdk: {
      package: "foundry-local-sdk",
      version: "2.0.1",
      package_lock: packageLockPath,
      package_lock_sha256: sha256NormalizedText(
        readFileSync(packageLockPath, "utf8"),
      ),
      runtime: treeReceipt(sdkRoot, [sdkPath]),
    },
    model_cache: {
      alias: "qwen2.5-7b",
      variantId: TARGET_ROUTE.model,
      cached: true,
      uri: catalogModel.uri,
    },
    runtime_paths: {
      model_cache: {
        effective_path: modelCacheRoot,
        override_present: false,
        override_value: null,
        catalog: {
          path: catalogPath,
          model_id: catalogModel.id,
          uri: catalogModel.uri,
          publisher: catalogModel.publisher,
          name: catalogModel.name,
          version: catalogModel.version,
          entry_sha256: catalogEntrySha256,
        },
        model: {
          model_id: TARGET_ROUTE.model,
          catalog_uri: catalogModel.uri,
          ...treeReceipt(modelRoot, [modelPath]),
        },
      },
      native_library: {
        effective_path: nativeRoot,
        override_present: false,
        override_value: null,
        skip_install_override: null,
        runtime: treeReceipt(nativeRoot, [nativePath]),
      },
    },
    corpus,
    file_hashes: requiredFiles.map(textReceipt),
  };
}

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

test("validates environment-v2 and binds the exact model contents", () => {
  const temporary = mkdtempSync(join(tmpdir(), "sealed-delegation-environment-"));
  try {
    const corpus = validateCorpus(manifestPath);
    const environment = createEnvironmentFixture(temporary, corpus);
    assert.deepEqual(validateEnvironmentReceipt(environment, corpus), {
      valid: true,
      errors: [],
    });
    const changedHarnessReceipt = structuredClone(environment);
    changedHarnessReceipt.file_hashes[0].sha256 = "0".repeat(64);
    const changedHarness = validateEnvironmentReceipt(
      changedHarnessReceipt,
      corpus,
    );
    assert.equal(changedHarness.valid, false);
    assert.ok(changedHarness.errors.includes("environment_file_hash_mismatch"));
    const modelPath = join(
      environment.runtime_paths.model_cache.model.path,
      environment.runtime_paths.model_cache.model.files[0].path,
    );
    writeFileSync(modelPath, "changed-model-contents");
    const tampered = validateEnvironmentReceipt(environment, corpus);
    assert.equal(tampered.valid, false);
    assert.ok(tampered.errors.includes("environment_model_file_hash_mismatch"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("report requires a valid environment receipt for promotion", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "sealed-delegation-environment-report-"));
  try {
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
    assert.equal(analysis.environment_validation.valid, false);
    assert.deepEqual(
      analysis.environment_validation.errors,
      ["environment_receipt_missing"],
    );
    assert.equal(analysis.promotion_gate.environment_receipt_valid, false);
    assert.equal(analysis.recommendation, "HOLD");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
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

test("defines 13 distinct end-to-end failure injections", () => {
  const { manifest } = loadCorpus(manifestPath);
  const cases = failureInjectionSpecifications(manifest.fixtures[0]);
  assert.equal(cases.length, 13);
  assert.equal(new Set(cases.map((testCase) => testCase.id)).size, 13);
  assert.ok(cases.every((testCase) => testCase.expectedReasons.length > 0));
});

test("failure injection classification requires the expected observed failure", () => {
  const testCase = {
    id: "example",
    expectedReasons: ["raw_tool_markup"],
    requireNonzeroLauncherExit: false,
  };
  const baseExecution = {
    run: { status: "COMPLETED", exit_code: 0 },
    launcherResult: { code: 0 },
    gate: {
      gate_accepted: false,
      authority_advanced: false,
      failure_reasons: ["raw_tool_markup"],
    },
  };
  assert.equal(classifyFailureInjection(testCase, baseExecution).passed, true);
  assert.equal(classifyFailureInjection(testCase, {
    ...baseExecution,
    gate: { ...baseExecution.gate, failure_reasons: ["empty_output"] },
  }).passed, false);
  assert.equal(classifyFailureInjection(testCase, {
    ...baseExecution,
    gate: {
      ...baseExecution.gate,
      failure_reasons: ["raw_tool_markup", "staged_file_hash_mismatch"],
    },
  }).passed, false);
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

test("rejects authority language hidden in missing_input", () => {
  const { manifest } = loadCorpus(manifestPath);
  const fixture = manifest.fixtures[0];
  const gate = gradeAttempt({
    fixture,
    run: null,
    raw: JSON.stringify({
      ...fixture.expected,
      missing_input: "Production ready approval from the source owner",
    }),
    providerEvents: [],
  });
  assert.equal(gate.authority_violation, true);
  assert.ok(gate.failure_reasons.includes("authority_language"));
});

test("report re-grades raw artifacts instead of trusting gate.json", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "sealed-delegation-regrade-report-"));
  try {
    const corpus = validateCorpus(manifestPath);
    const { manifest } = loadCorpus(manifestPath);
    const fixture = manifest.fixtures[0];
    const attemptRoot = join(outputRoot, fixture.id, "attempt-001");
    const runRoot = join(attemptRoot, "launcher-runs", "run-1");
    const executionSourcePath = join(attemptRoot, "approved-input", "source.md");
    const stagedPath = join(runRoot, "workspace", "source.md");
    mkdirSync(join(attemptRoot, "approved-input"), { recursive: true });
    mkdirSync(join(runRoot, "workspace"), { recursive: true });
    copyFileSync(join(here, "corpus", fixture.source), executionSourcePath);
    copyFileSync(executionSourcePath, stagedPath);
    const hash = sha256File(stagedPath);
    const stdoutPath = join(runRoot, "stdout.txt");
    const stderrPath = join(runRoot, "stderr.txt");
    writeFileSync(stdoutPath, JSON.stringify(fixture.expected));
    writeFileSync(stderrPath, "");
    const runPath = join(runRoot, "run.json");
    const run = {
      run_id: "run-1",
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
      stdout_path: stdoutPath,
      stdout_sha256: sha256File(stdoutPath),
      stderr_path: stderrPath,
      stderr_sha256: sha256File(stderrPath),
      staged_inputs: [{
        staged_path: stagedPath,
        sha256: hash,
        source_sha256: hash,
        staged_sha256: hash,
      }],
    };
    writeFileSync(runPath, JSON.stringify(run));
    const attemptPath = join(attemptRoot, "attempt.json");
    const gatePath = join(attemptRoot, "gate.json");
    const attempt = {
      schema_version: "sealed-delegation/session-qualification-attempt/v2",
      fixture_id: fixture.id,
      attempt_number: 1,
      corpus_sha256: corpus.corpus_sha256,
      execution_source_path: executionSourcePath,
      source_sha256: hash,
      source_normalized_sha256: corpus.files.find(
        (file) => file.path === fixture.source,
      ).sha256,
      source_citation: fixture.source_citation,
      expected: fixture.expected,
      route: TARGET_ROUTE,
      launcher_receipt: runPath,
      gate_receipt: gatePath,
    };
    writeFileSync(attemptPath, JSON.stringify(attempt));
    const providerEvents = [
      {
        fixture_id: fixture.id,
        attempt_number: 1,
        event: "request_started",
        request_id: "request-1",
        resolved_model: TARGET_ROUTE.model,
      },
      {
        fixture_id: fixture.id,
        attempt_number: 1,
        event: "request_completed",
        request_id: "request-1",
        resolved_model: TARGET_ROUTE.model,
        finish_reason: "stop",
      },
    ];
    writeFileSync(
      join(attemptRoot, "provider-events.jsonl"),
      `${providerEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const environmentPath = join(outputRoot, "environment.json");
    const environment = { corpus, copilot: {} };
    writeFileSync(environmentPath, JSON.stringify(environment));
    const gate = gradeAttempt({
      fixture,
      run,
      raw: JSON.stringify(fixture.expected),
      providerEvents,
      environment,
      attemptNumber: 1,
      attempt,
      approvedCorpus: corpus,
    });
    assert.equal(gate.gate_accepted, true, gate.failure_reasons.join(", "));
    writeFileSync(gatePath, JSON.stringify(gate));

    writeFileSync(stdoutPath, '{"status":"blocked"');
    const outputPath = join(outputRoot, "analysis.json");
    const result = spawnSync(
      process.execPath,
      [
        join(here, "report.mjs"),
        "--manifest", manifestPath,
        "--results", outputRoot,
        "--environment", environmentPath,
        "--output", outputPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const analysis = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(analysis.raw_attempt_count, 0);
    assert.equal(analysis.stale_attempt_count, 1);
    assert.ok(
      analysis.stale_attempts[0].failure_reasons.includes(
        "launcher_stdout_link_invalid",
      ),
    );
    assert.ok(
      analysis.stale_attempts[0].failure_reasons.includes("recorded_gate_mismatch"),
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
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
