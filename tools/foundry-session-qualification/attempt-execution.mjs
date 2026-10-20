import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  TARGET_ROUTE,
  gradeAttempt,
  readJsonLines,
  renderTask,
  sha256File,
  sha256NormalizedText,
  writeJson,
} from "./qualification-lib.mjs";

function runProcess(file, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killedForTimeout = true;
          child.kill();
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, killedForTimeout });
    });
  });
}

export async function executeLauncherAttempt({
  attemptRoot,
  fixture,
  attemptNumber,
  retryReason = null,
  sourcePath,
  approvedSource,
  promptTemplate,
  repoRoot,
  launcherPath,
  baseUrl,
  modelAlias,
  pinnedCopilot,
  timeoutSeconds,
  environment,
  approvedCorpus,
  beforeGrade = null,
}) {
  mkdirSync(attemptRoot);
  const providerPath = join(attemptRoot, "provider-events.jsonl");
  const approvedInputRoot = join(attemptRoot, "approved-input");
  mkdirSync(approvedInputRoot);
  const executionSourcePath = join(approvedInputRoot, basename(sourcePath));
  copyFileSync(sourcePath, executionSourcePath);
  const sourceNormalizedSha256 = sha256NormalizedText(
    readFileSync(executionSourcePath, "utf8"),
  );
  if (sourceNormalizedSha256 !== approvedSource.sha256) {
    throw new Error(
      `${fixture.id}: executed source differs from the approved corpus receipt.`,
    );
  }
  const sourceSha256 = sha256File(executionSourcePath);
  const task = renderTask(promptTemplate, fixture, basename(executionSourcePath));
  const launcherRoot = join(attemptRoot, "launcher-runs");
  mkdirSync(launcherRoot);
  const attemptPath = join(attemptRoot, "attempt.json");
  const attempt = {
    schema_version: "sealed-delegation/session-qualification-attempt/v2",
    fixture_id: fixture.id,
    attempt_number: attemptNumber,
    retry_reason: retryReason,
    started_at: new Date().toISOString(),
    status: "STARTED",
    corpus_sha256: approvedCorpus.corpus_sha256,
    source_path: sourcePath,
    execution_source_path: executionSourcePath,
    source_sha256: sourceSha256,
    source_normalized_sha256: sourceNormalizedSha256,
    source_citation: fixture.source_citation,
    expected: fixture.expected,
    route: TARGET_ROUTE,
    authority_advanced: false,
  };
  writeJson(attemptPath, attempt);

  const launcherArguments = [
    "-NoProfile",
    "-File", launcherPath,
    "-Task", task,
    "-WorkingDirectory", repoRoot,
    "-InputPaths", executionSourcePath,
    "-Profile", TARGET_ROUTE.profile,
    "-TaskMode", TARGET_ROUTE.task_mode,
    "-RuntimeId", TARGET_ROUTE.runtime,
    "-Model", TARGET_ROUTE.model,
    "-FoundryAlias", modelAlias,
    "-MaxPromptTokens", String(TARGET_ROUTE.max_prompt_tokens),
    "-MaxOutputTokens", "256",
    "-Stream", TARGET_ROUTE.stream,
    "-BaseUrl", baseUrl,
    "-AllowUnqualifiedRoute",
    "-TimeoutSeconds", String(timeoutSeconds),
    "-RunRoot", launcherRoot,
    "-CopilotExecutable", pinnedCopilot,
  ];
  const launcherResult = await runProcess(
    "pwsh",
    launcherArguments,
    { cwd: repoRoot },
  );
  writeFileSync(join(attemptRoot, "launcher-wrapper-stdout.txt"), launcherResult.stdout);
  writeFileSync(join(attemptRoot, "launcher-wrapper-stderr.txt"), launcherResult.stderr);
  const runDirectories = readdirSync(launcherRoot).sort();
  const runPath = runDirectories.length === 1
    ? join(launcherRoot, runDirectories[0], "run.json")
    : null;
  const run = runPath && existsSync(runPath)
    ? JSON.parse(readFileSync(runPath, "utf8"))
    : null;
  const raw = run?.stdout_path && existsSync(run.stdout_path)
    ? readFileSync(run.stdout_path, "utf8")
    : "";
  if (beforeGrade) await beforeGrade();
  const providerEvents = readJsonLines(providerPath);
  const gate = {
    ...gradeAttempt({
      fixture,
      run,
      raw,
      providerEvents,
      environment,
      attemptNumber,
      attempt,
      approvedCorpus,
    }),
    gated_at: new Date().toISOString(),
    attempt_directory: attemptRoot,
  };
  const gatePath = join(attemptRoot, "gate.json");
  writeJson(gatePath, gate);
  const completedAttempt = {
    ...attempt,
    finished_at: new Date().toISOString(),
    status: gate.gate_accepted ? "GATE_ACCEPTED" : "GATE_REJECTED",
    launcher_exit_code: launcherResult.code,
    launcher_receipt: runPath,
    gate_receipt: gatePath,
    failure_reasons: gate.failure_reasons,
    authority_advanced: false,
  };
  writeJson(attemptPath, completedAttempt);
  return {
    attempt: completedAttempt,
    gate,
    run,
    raw,
    providerEvents,
    launcherResult,
    providerPath,
  };
}
