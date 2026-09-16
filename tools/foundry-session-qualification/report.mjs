import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  gradeAttempt,
  listAttemptDirectories,
  loadCorpus,
  readJsonLines,
  sha256File,
  validateCorpus,
  validateEnvironmentReceipt,
  writeJson,
} from "./qualification-lib.mjs";
import {
  classifyFailureInjection,
  failureInjectionSpecifications,
} from "./failure-injection-lib.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function isWithin(root, candidate) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sameReasons(left, right) {
  return JSON.stringify([...(left ?? [])].sort()) ===
    JSON.stringify([...(right ?? [])].sort());
}

const manifestPath = resolve(valueAfter("--manifest") ?? "");
const resultsRoot = resolve(valueAfter("--results") ?? "");
const outputPath = resolve(valueAfter("--output") ?? join(resultsRoot, "analysis.json"));
const failureSummaryPath = valueAfter("--failure-summary");
const threatReviewPath = valueAfter("--threat-review");
const environmentPath = valueAfter("--environment");
const { manifest } = loadCorpus(manifestPath);
const corpusValidation = validateCorpus(manifestPath);
if (!corpusValidation.valid) {
  throw new Error(`Corpus validation failed: ${corpusValidation.errors.join("; ")}`);
}
const resolvedEnvironmentPath = environmentPath ? resolve(environmentPath) : null;
let environment = null;
const environmentReadErrors = [];
if (!resolvedEnvironmentPath || !existsSync(resolvedEnvironmentPath)) {
  environmentReadErrors.push("environment_receipt_missing");
} else {
  try {
    environment = JSON.parse(readFileSync(resolvedEnvironmentPath, "utf8"));
  } catch {
    environmentReadErrors.push("environment_receipt_malformed");
  }
}
const environmentValidation = environmentReadErrors.length > 0
  ? { valid: false, errors: environmentReadErrors }
  : validateEnvironmentReceipt(environment, corpusValidation);
const approvedCorpus = environment?.corpus ?? null;
const environmentCorpusMatches =
  environmentValidation.valid &&
  approvedCorpus?.corpus_sha256 === corpusValidation.corpus_sha256 &&
  JSON.stringify(approvedCorpus?.files) === JSON.stringify(corpusValidation.files);
const allAttempts = listAttemptDirectories(resultsRoot).map((attemptRoot) => {
  const attemptPath = join(attemptRoot, "attempt.json");
  const gatePath = join(attemptRoot, "gate.json");
  const providerPath = join(attemptRoot, "provider-events.jsonl");
  const artifactFailureReasons = [];
  const attempt = existsSync(attemptPath)
    ? JSON.parse(readFileSync(attemptPath, "utf8"))
    : {};
  const recordedGate = existsSync(gatePath)
    ? JSON.parse(readFileSync(gatePath, "utf8"))
    : null;
  const fixture = manifest.fixtures.find((candidate) => candidate.id === attempt.fixture_id);
  if (attempt.schema_version !== "sealed-delegation/session-qualification-attempt/v2") {
    artifactFailureReasons.push("attempt_schema_mismatch");
  }
  if (!fixture) artifactFailureReasons.push("unknown_attempt_fixture");
  const expectedAttemptName = `attempt-${String(attempt.attempt_number).padStart(3, "0")}`;
  if (basename(attemptRoot) !== expectedAttemptName) {
    artifactFailureReasons.push("attempt_directory_number_mismatch");
  }
  if (basename(dirname(attemptRoot)) !== attempt.fixture_id) {
    artifactFailureReasons.push("attempt_directory_fixture_mismatch");
  }
  if (!environmentValidation.valid) {
    artifactFailureReasons.push("environment_integrity_invalid");
  } else if (!environmentCorpusMatches) {
    artifactFailureReasons.push("environment_corpus_mismatch");
  }
  if (!attempt.gate_receipt ||
      resolve(attempt.gate_receipt) !== resolve(gatePath)) {
    artifactFailureReasons.push("attempt_gate_link_mismatch");
  }
  const approvedInputRoot = join(attemptRoot, "approved-input");
  if (!attempt.execution_source_path ||
      !isWithin(approvedInputRoot, attempt.execution_source_path) ||
      !existsSync(attempt.execution_source_path)) {
    artifactFailureReasons.push("attempt_execution_source_link_invalid");
  }
  const attemptForGrade = artifactFailureReasons.includes(
    "attempt_execution_source_link_invalid",
  )
    ? { ...attempt, execution_source_path: null }
    : attempt;
  const launcherRoot = join(attemptRoot, "launcher-runs");
  const runPath = attempt.launcher_receipt ? resolve(attempt.launcher_receipt) : null;
  if (!runPath || !isWithin(launcherRoot, runPath)) {
    artifactFailureReasons.push("launcher_receipt_outside_attempt");
  }
  const run = runPath && isWithin(launcherRoot, runPath) && existsSync(runPath)
    ? JSON.parse(readFileSync(runPath, "utf8"))
    : null;
  if (attempt.launcher_receipt && !run) {
    artifactFailureReasons.push("launcher_receipt_missing");
  }
  if (runPath && run?.run_id !== basename(dirname(runPath))) {
    artifactFailureReasons.push("launcher_run_id_path_mismatch");
  }
  const stagedInputsValid = Array.isArray(run?.staged_inputs) &&
    run.staged_inputs.length === 1 &&
    run.staged_inputs.every((staged) =>
      staged?.staged_path &&
      isWithin(dirname(runPath), staged.staged_path));
  if (run && !stagedInputsValid) {
    artifactFailureReasons.push("launcher_staged_input_link_invalid");
  }
  const runForGrade = run && !stagedInputsValid
    ? { ...run, staged_inputs: [] }
    : run;
  const stdoutPath = run?.stdout_path ? resolve(run.stdout_path) : null;
  const stdoutValid = stdoutPath &&
    isWithin(dirname(runPath), stdoutPath) &&
    existsSync(stdoutPath) &&
    sha256File(stdoutPath) === run.stdout_sha256;
  if (run && !stdoutValid) {
    artifactFailureReasons.push("launcher_stdout_link_invalid");
  }
  const stderrPath = run?.stderr_path ? resolve(run.stderr_path) : null;
  const stderrValid = stderrPath &&
    isWithin(dirname(runPath), stderrPath) &&
    existsSync(stderrPath) &&
    sha256File(stderrPath) === run.stderr_sha256;
  if (run && !stderrValid) {
    artifactFailureReasons.push("launcher_stderr_link_invalid");
  }
  const raw = stdoutValid
    ? readFileSync(stdoutPath, "utf8")
    : "";
  const providerEvents = readJsonLines(providerPath);
  if (providerEvents.some((event) =>
    event.fixture_id !== attempt.fixture_id ||
    Number(event.attempt_number) !== Number(attempt.attempt_number))) {
    artifactFailureReasons.push("provider_event_link_mismatch");
  }
  const regraded = fixture
    ? gradeAttempt({
        fixture,
        run: runForGrade,
        raw,
        providerEvents,
        environment,
        attemptNumber: attempt.attempt_number,
        attempt: attemptForGrade,
        approvedCorpus,
      })
    : {
        gate_accepted: false,
        failure_reasons: ["unknown_attempt_fixture"],
        malformed_output: false,
        fabricated_result: false,
        authority_advanced: false,
      };
  const recordedGateMatches =
    recordedGate?.schema_version === regraded.schema_version &&
    recordedGate?.fixture_id === regraded.fixture_id &&
    recordedGate?.launcher_run_id === regraded.launcher_run_id &&
    recordedGate?.gate_accepted === regraded.gate_accepted &&
    recordedGate?.authority_advanced === regraded.authority_advanced &&
    recordedGate?.malformed_output === regraded.malformed_output &&
    recordedGate?.fabricated_result === regraded.fabricated_result &&
    sameReasons(recordedGate?.failure_reasons, regraded.failure_reasons);
  if (!recordedGateMatches) artifactFailureReasons.push("recorded_gate_mismatch");
  const failureReasons = [
    ...new Set([...regraded.failure_reasons, ...artifactFailureReasons]),
  ];
  const gateAccepted = regraded.gate_accepted && artifactFailureReasons.length === 0;
  return {
    fixture_id: attempt.fixture_id,
    attempt_number: attempt.attempt_number,
    attempt_path: attemptRoot,
    launcher_receipt: runPath ?? null,
    launcher_status: run?.status ?? null,
    launcher_exit_code: run?.exit_code ?? attempt.launcher_exit_code ?? null,
    elapsed_seconds: run?.elapsed_seconds ?? null,
    gate_accepted: gateAccepted,
    failure_reasons: failureReasons,
    malformed_output: regraded.malformed_output,
    fabricated_result: regraded.fabricated_result,
    authority_advanced: regraded.authority_advanced,
    corpus_sha256: attempt.corpus_sha256 ?? null,
    gate_schema_version: recordedGate?.schema_version ?? null,
    recorded_gate_matches_regrade: recordedGateMatches,
    evidence_links_valid: artifactFailureReasons.length === 0,
    provider_events: providerEvents,
  };
});
const staleAttempts = allAttempts.filter((attempt) =>
  attempt.corpus_sha256 !== corpusValidation.corpus_sha256 ||
  attempt.gate_schema_version !== "sealed-delegation/session-qualification-gate/v2" ||
  !attempt.recorded_gate_matches_regrade ||
  !attempt.evidence_links_valid);
const attempts = allAttempts.filter((attempt) => !staleAttempts.includes(attempt));

const firstAttempts = manifest.fixtures.map((fixture) =>
  attempts.find((attempt) =>
    attempt.fixture_id === fixture.id && attempt.attempt_number === 1));
const walls = attempts
  .map((attempt) => attempt.elapsed_seconds)
  .filter((value) => Number.isFinite(value));
const totalTokens = attempts.flatMap((attempt) => attempt.provider_events)
  .filter((event) => event.event === "request_completed")
  .reduce((sum, event) => sum + (Number(event.usage?.total_tokens) || 0), 0);
const failureSummary = failureSummaryPath && existsSync(resolve(failureSummaryPath))
  ? JSON.parse(readFileSync(resolve(failureSummaryPath), "utf8"))
  : null;
const failureSummaryRoot = failureSummaryPath
  ? dirname(resolve(failureSummaryPath))
  : null;
const failureDefinitions = new Map(
  failureInjectionSpecifications(manifest.fixtures[0]).map(
    (testCase) => [testCase.id, testCase],
  ),
);
function verifyFailureCase(summaryCase) {
  const invalid = (reason) => ({ id: summaryCase.id, valid: false, reason });
  const definition = failureDefinitions.get(summaryCase.id);
  if (!definition) return invalid("unknown_case");
  const caseRoot = join(failureSummaryRoot, summaryCase.id);
  const attemptRoot = join(caseRoot, "attempt-001");
  const attemptPath = join(attemptRoot, "attempt.json");
  const gatePath = join(attemptRoot, "gate.json");
  const resultPath = join(caseRoot, "result.json");
  const providerPath = join(attemptRoot, "provider-events.jsonl");
  if (![attemptPath, gatePath, resultPath].every(existsSync)) {
    return invalid("required_artifact_missing");
  }
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
  const recordedGate = JSON.parse(readFileSync(gatePath, "utf8"));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (attempt.schema_version !== "sealed-delegation/session-qualification-attempt/v2" ||
      attempt.fixture_id !== manifest.fixtures[0].id ||
      attempt.attempt_number !== 1 ||
      attempt.retry_reason !== `failure_injection:${summaryCase.id}` ||
      attempt.corpus_sha256 !== corpusValidation.corpus_sha256 ||
      !attempt.execution_source_path ||
      !isWithin(join(attemptRoot, "approved-input"), attempt.execution_source_path) ||
      !existsSync(attempt.execution_source_path)) {
    return invalid("attempt_link_invalid");
  }
  if (!attempt.gate_receipt || resolve(attempt.gate_receipt) !== resolve(gatePath)) {
    return invalid("attempt_gate_link_mismatch");
  }
  const runPath = attempt.launcher_receipt ? resolve(attempt.launcher_receipt) : null;
  const launcherRoot = join(attemptRoot, "launcher-runs");
  if (!runPath || !isWithin(launcherRoot, runPath) || !existsSync(runPath)) {
    return invalid("launcher_receipt_invalid");
  }
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  if (run.run_id !== basename(dirname(runPath))) {
    return invalid("launcher_run_id_mismatch");
  }
  const stdoutPath = run.stdout_path ? resolve(run.stdout_path) : null;
  const stderrPath = run.stderr_path ? resolve(run.stderr_path) : null;
  if (!stdoutPath ||
      !stderrPath ||
      !isWithin(dirname(runPath), stdoutPath) ||
      !isWithin(dirname(runPath), stderrPath) ||
      !existsSync(stdoutPath) ||
      !existsSync(stderrPath) ||
      sha256File(stdoutPath) !== run.stdout_sha256 ||
      sha256File(stderrPath) !== run.stderr_sha256 ||
      !Array.isArray(run.staged_inputs) ||
      run.staged_inputs.length !== 1 ||
      !isWithin(dirname(runPath), run.staged_inputs[0].staged_path)) {
    return invalid("launcher_artifact_hash_or_link_invalid");
  }
  const providerEvents = readJsonLines(providerPath);
  if (providerEvents.some((event) =>
    event.fixture_id !== attempt.fixture_id ||
    Number(event.attempt_number) !== 1)) {
    return invalid("provider_event_link_mismatch");
  }
  const regraded = gradeAttempt({
    fixture: manifest.fixtures[0],
    run,
    raw: readFileSync(stdoutPath, "utf8"),
    providerEvents,
    environment,
    attemptNumber: 1,
    attempt,
    approvedCorpus,
  });
  if (recordedGate.schema_version !== regraded.schema_version ||
      recordedGate.gate_accepted !== regraded.gate_accepted ||
      recordedGate.authority_advanced !== regraded.authority_advanced ||
      !sameReasons(recordedGate.failure_reasons, regraded.failure_reasons)) {
    return invalid("recorded_gate_mismatch");
  }
  const classified = classifyFailureInjection(definition, {
    run,
    launcherResult: { code: attempt.launcher_exit_code },
    gate: regraded,
  });
  if (JSON.stringify(classified) !== JSON.stringify(result)) {
    return invalid("result_reclassification_mismatch");
  }
  if (JSON.stringify(result) !== JSON.stringify(summaryCase)) {
    return invalid("summary_result_mismatch");
  }
  if (classified.passed !== true) return invalid("case_not_fail_closed");
  return { id: summaryCase.id, valid: true, reason: null };
}
const failureCaseVerifications = Array.isArray(failureSummary?.cases)
  ? failureSummary.cases.map(verifyFailureCase)
  : [];
const expectedFailureIds = [...failureDefinitions.keys()].sort();
const actualFailureIds = Array.isArray(failureSummary?.cases)
  ? failureSummary.cases.map((testCase) => testCase.id).sort()
  : [];
const failureSuiteCoverageValid =
  failureSummary?.case_count === failureSummary?.cases?.length &&
  failureSummary?.passed_count ===
    failureSummary?.cases?.filter((testCase) => testCase.passed).length &&
  new Set(actualFailureIds).size === actualFailureIds.length &&
  JSON.stringify(actualFailureIds) === JSON.stringify(expectedFailureIds);
const failureSummaryLinked = failureSummary?.schema_version ===
    "sealed-delegation/session-failure-injection/v3" &&
  failureSummary?.execution_path === "runner-launcher-adapter-receipt" &&
  failureSummary?.complete_suite === true &&
  Array.isArray(failureSummary?.cases) &&
  failureSuiteCoverageValid &&
  failureCaseVerifications.every((verification) => verification.valid);
const threatReview = threatReviewPath && existsSync(resolve(threatReviewPath))
  ? JSON.parse(readFileSync(resolve(threatReviewPath), "utf8"))
  : null;
const lifecyclePath = join(resultsRoot, "adapter-lifecycle.json");
const lifecycle = existsSync(lifecyclePath)
  ? JSON.parse(readFileSync(lifecyclePath, "utf8"))
  : null;

const firstPassCount = firstAttempts.filter((attempt) => attempt?.gate_accepted).length;
const promotionGate = {
  environment_receipt_valid: environmentValidation.valid,
  all_first_attempts_pass:
    firstPassCount === manifest.fixtures.length && manifest.fixtures.length === 20,
  zero_fabricated_results: !attempts.some((attempt) => attempt.fabricated_result),
  zero_malformed_results: !attempts.some((attempt) => attempt.malformed_output),
  zero_authority_advancement: !attempts.some((attempt) => attempt.authority_advanced),
  all_failure_injections_fail_closed: failureSummaryLinked &&
    failureSummary?.passed === true &&
    failureSummary?.passed_count === failureSummary?.case_count &&
    failureSummary?.case_count === 13,
  no_unresolved_high_severity_threat: threatReview?.unresolved_high_severity === 0,
  adapter_closed_cleanly:
    lifecycle?.adapter_closed === true && lifecycle?.interrupted === false,
  no_stale_or_mixed_attempts: staleAttempts.length === 0,
};
const mechanicallyPromotable = Object.values(promotionGate).every((value) => value === true);
const recommendation = mechanicallyPromotable ? "PROMOTE" :
  (attempts.some((attempt) => attempt.fabricated_result ||
    attempt.authority_advanced) ? "REJECT" : "HOLD");

const report = {
  schema_version: "sealed-delegation/session-qualification-analysis/v3",
  generated_at: new Date().toISOString(),
  corpus_id: manifest.corpus_id,
  corpus_sha256: corpusValidation.corpus_sha256,
  corpus_case_count: manifest.fixtures.length,
  stale_attempt_count: staleAttempts.length,
  raw_attempt_count: attempts.length,
  first_attempt_pass_count: firstPassCount,
  semantic_contract_pass_rate: attempts.length
    ? attempts.filter((attempt) => attempt.gate_accepted).length / attempts.length
    : 0,
  false_success_count: attempts.filter((attempt) =>
    attempt.launcher_status === "COMPLETED" && !attempt.gate_accepted).length,
  malformed_output_count: attempts.filter((attempt) => attempt.malformed_output).length,
  fabricated_result_count: attempts.filter((attempt) => attempt.fabricated_result).length,
  failure_injection_pass_rate: failureSummary
    ? failureSummary.passed_count / failureSummary.case_count
    : null,
  failure_injection_verification: {
    linked: failureSummaryLinked,
    suite_coverage_valid: failureSuiteCoverageValid,
    expected_case_ids: expectedFailureIds,
    actual_case_ids: actualFailureIds,
    cases: failureCaseVerifications,
  },
  wall_seconds: {
    mean: walls.length ? walls.reduce((sum, value) => sum + value, 0) / walls.length : null,
    median: percentile(walls, 0.5),
    p95: percentile(walls, 0.95),
    max: walls.length ? Math.max(...walls) : null,
  },
  total_local_tokens: totalTokens || null,
  retries: attempts.filter((attempt) => attempt.attempt_number > 1),
  environment_receipt: resolvedEnvironmentPath,
  environment_validation: environmentValidation,
  adapter_lifecycle_receipt: existsSync(lifecyclePath) ? lifecyclePath : null,
  host_and_route: environment ? {
    host: environment.host,
    route: environment.route,
    copilot: environment.copilot,
    foundry_cli: environment.foundry_cli,
    foundry_sdk: environment.foundry_sdk,
    runtime_paths: environment.runtime_paths,
  } : null,
  promotion_gate: promotionGate,
  recommendation,
  attempts,
  stale_attempts: staleAttempts,
};
writeJson(outputPath, report);
console.log(JSON.stringify(report, null, 2));
process.exitCode = !environmentValidation.valid || staleAttempts.length > 0
  ? 1
  : (recommendation === "REJECT" ? 2 : 0);
