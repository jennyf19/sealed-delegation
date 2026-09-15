import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeLauncherAttempt } from "./attempt-execution.mjs";
import {
  TARGET_ROUTE,
  findCorpusFileReceipt,
  loadCorpus,
  validateCorpus,
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

function attemptNumber(name) {
  return Number(name.replace("attempt-", ""));
}

function existingAttempts(fixtureRoot) {
  if (!existsSync(fixtureRoot)) return [];
  return readdirSync(fixtureRoot)
    .filter((name) => /^attempt-\d{3}$/.test(name))
    .sort()
    .map(attemptNumber);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const manifestPath = resolve(valueAfter("--manifest") ?? join(here, "corpus/manifest.json"));
const resultsRoot = resolve(
  valueAfter("--results") ?? join(repoRoot, "results/session-qualification-semantic"),
);
const approvedHash = valueAfter("--approved-corpus-sha256");
const validateOnly = process.argv.includes("--validate-only");
const resume = process.argv.includes("--resume");
const retryIds = new Set(valuesAfter("--retry"));
const selectedIds = new Set(valuesAfter("--fixture"));
const timeoutSeconds = Number(valueAfter("--timeout-seconds") ?? 900);
const corpusValidation = validateCorpus(manifestPath);
if (!corpusValidation.valid) {
  console.error(JSON.stringify(corpusValidation, null, 2));
  process.exit(1);
}
if (validateOnly) {
  console.log(JSON.stringify(corpusValidation, null, 2));
  process.exit(0);
}
if (!approvedHash || approvedHash !== corpusValidation.corpus_sha256) {
  throw new Error(
    `Model execution is sealed until JM approves corpus SHA-256 ` +
    `${corpusValidation.corpus_sha256}. Pass it with --approved-corpus-sha256.`,
  );
}

const { manifest, promptTemplate } = loadCorpus(manifestPath);
mkdirSync(resultsRoot, { recursive: true });
const pinnedRoot = join(resultsRoot, "pinned");
const pinnedCopilot = join(pinnedRoot, "copilot.exe");
if (!existsSync(pinnedCopilot)) {
  const where = spawnSync("where.exe", ["copilot.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sourceCopilot = where.status === 0
    ? where.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .find((candidate) => existsSync(candidate) && statSync(candidate).size > 0)
    : null;
  if (!sourceCopilot) {
    throw new Error("Could not resolve a concrete non-alias Copilot executable to pin.");
  }
  mkdirSync(pinnedRoot, { recursive: true });
  copyFileSync(sourceCopilot, pinnedCopilot);
}
const environmentPath = join(resultsRoot, "environment.json");
const environmentExists = existsSync(environmentPath);
const environmentCandidatePath = environmentExists
  ? join(resultsRoot, "environment-resume-check.json")
  : environmentPath;
const environmentCommand = spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-File", join(here, "environment-receipt.ps1"),
    "-RepositoryRoot", repoRoot,
    "-ManifestPath", manifestPath,
    "-OutputPath", environmentCandidatePath,
    "-CopilotExecutable", pinnedCopilot,
  ],
  { cwd: repoRoot, encoding: "utf8", windowsHide: true },
);
if (environmentCommand.status !== 0) {
  throw new Error(
    `Environment receipt failed:\n${environmentCommand.stderr || environmentCommand.stdout}`,
  );
}
const environmentCandidate = JSON.parse(readFileSync(environmentCandidatePath, "utf8"));
const environment = environmentExists
  ? JSON.parse(readFileSync(environmentPath, "utf8"))
  : environmentCandidate;
if (environmentCandidate.corpus.corpus_sha256 !== approvedHash) {
  throw new Error("Environment receipt corpus hash differs from the approved corpus hash.");
}
if (!environmentCandidate.repository.clean) {
  throw new Error(
    "Qualification requires a clean committed worktree so the commit SHA and file hashes are reviewable.",
  );
}
for (const [key, expected] of Object.entries(TARGET_ROUTE)) {
  if (JSON.stringify(environmentCandidate.route[key]) !== JSON.stringify(expected)) {
    throw new Error(`Environment route field ${key} differs from the frozen target tuple.`);
  }
}
if (environmentExists) {
  const stableFields = (receipt) => ({
    commit_sha: receipt.repository.commit_sha,
    route: receipt.route,
    copilot: receipt.copilot,
    foundry_cli: receipt.foundry_cli,
    foundry_sdk: receipt.foundry_sdk,
    model_cache: receipt.model_cache,
    runtime_paths: receipt.runtime_paths,
    corpus_sha256: receipt.corpus.corpus_sha256,
    file_hashes: receipt.file_hashes,
  });
  if (JSON.stringify(stableFields(environment)) !==
      JSON.stringify(stableFields(environmentCandidate))) {
    throw new Error("Resume environment differs from the original qualification receipt.");
  }
}

const executionPlan = [];
for (const fixture of manifest.fixtures) {
  if (selectedIds.size > 0 && !selectedIds.has(fixture.id)) continue;
  const fixtureRoot = join(resultsRoot, fixture.id);
  const attempts = existingAttempts(fixtureRoot);
  const explicitlyRetried = retryIds.has(fixture.id);
  if (explicitlyRetried && attempts.length === 0) {
    throw new Error(`${fixture.id} cannot be retried because it has no recorded first attempt.`);
  }
  if (attempts.length > 0 && !explicitlyRetried) {
    if (resume) continue;
    throw new Error(
      `${fixture.id} already has recorded attempts. Use --resume to skip it or ` +
      `--retry ${fixture.id} to record an explicit retry.`,
    );
  }
  executionPlan.push({
    fixture,
    fixtureRoot,
    explicitlyRetried,
    number: attempts.length === 0 ? 1 : Math.max(...attempts) + 1,
  });
}

function generateReport() {
  const reportArgs = [
    join(here, "report.mjs"),
    "--manifest", manifestPath,
    "--results", resultsRoot,
    "--environment", environmentPath,
    "--failure-summary", join(resultsRoot, "failure-injection/summary.json"),
    "--threat-review", join(resultsRoot, "threat-review.json"),
    "--output", join(resultsRoot, "analysis.json"),
  ];
  const reportResult = spawnSync(process.execPath, reportArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (reportResult.status !== 0 && reportResult.status !== 2) {
    throw new Error(`Analysis report failed:\n${reportResult.stderr || reportResult.stdout}`);
  }
  console.log(reportResult.stdout.trim());
}

if (executionPlan.length === 0) {
  generateReport();
  process.exit(0);
}

const { startAdapter } = await import("../foundry-session-probe/adapter.mjs");
const globalProviderPath = join(resultsRoot, "provider-events.jsonl");
let activeAttemptContext = null;
const providerRequestContexts = new Map();
const recordEvent = (event) => {
  let context = event.request_id
    ? providerRequestContexts.get(event.request_id)
    : null;
  if (event.event === "request_started") {
    context = activeAttemptContext;
    if (event.request_id && context) {
      providerRequestContexts.set(event.request_id, context);
    }
  } else if (!context) {
    context = activeAttemptContext;
  }
  const value = {
    recorded_at: new Date().toISOString(),
    ...(context ?? {}),
    ...event,
  };
  appendFileSync(globalProviderPath, `${JSON.stringify(value)}\n`);
  if (context?.provider_path) {
    appendFileSync(context.provider_path, `${JSON.stringify(value)}\n`);
  }
  if (event.request_id &&
      ["request_completed", "request_failed", "request_rejected"].includes(event.event)) {
    providerRequestContexts.delete(event.request_id);
  }
};
const adapter = await startAdapter({
  host: "127.0.0.1",
  port: 0,
  modelAlias: environment.model_cache.alias,
  modelCacheDir: environment.runtime_paths.model_cache.effective_path,
  libraryPath: environment.runtime_paths.native_library.effective_path,
  recordEvent,
});
if (adapter.model.id !== TARGET_ROUTE.model) {
  await adapter.close();
  throw new Error(`Resolved model ${adapter.model.id} differs from ${TARGET_ROUTE.model}.`);
}

const launcher = join(
  repoRoot,
  ".github/skills/local-agent-delegation/scripts/invoke_local_agent.ps1",
);
let interrupted = false;
let closePromise = null;
function closeAdapter() {
  if (closePromise) return closePromise;
  closePromise = (async () => {
    let closeError = null;
    try {
      await adapter.close();
    } catch (error) {
      closeError = error;
    } finally {
      writeJson(join(resultsRoot, "adapter-lifecycle.json"), {
        schema_version: "sealed-delegation/adapter-lifecycle/v1",
        closed_at: new Date().toISOString(),
        base_url: adapter.baseUrl,
        model: adapter.model.id,
        interrupted,
        adapter_closed: closeError === null,
        close_error: closeError?.message ?? null,
        authority_advanced: false,
      });
    }
    if (closeError) throw closeError;
  })();
  return closePromise;
}
const handleSignal = async () => {
  interrupted = true;
  activeAttemptContext = null;
  try {
    await closeAdapter();
  } finally {
    process.exit(130);
  }
};
process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);
try {
  for (const plan of executionPlan) {
    const { fixture, fixtureRoot, explicitlyRetried, number } = plan;
    const executionCorpus = validateCorpus(manifestPath);
    if (!executionCorpus.valid ||
        executionCorpus.corpus_sha256 !== approvedHash ||
        JSON.stringify(executionCorpus.files) !== JSON.stringify(environment.corpus.files)) {
      throw new Error(
        `${fixture.id}: corpus changed after approval; refusing to execute.`,
      );
    }
    const approvedSource = findCorpusFileReceipt(environment.corpus, fixture.source);
    if (!approvedSource) {
      throw new Error(`${fixture.id}: approved corpus has no source receipt.`);
    }
    mkdirSync(fixtureRoot, { recursive: true });
    const attemptRoot = join(fixtureRoot, `attempt-${String(number).padStart(3, "0")}`);
    const providerPath = join(attemptRoot, "provider-events.jsonl");
    activeAttemptContext = {
      fixture_id: fixture.id,
      attempt_number: number,
      provider_path: providerPath,
    };
    const sourcePath = resolve(dirname(manifestPath), fixture.source);
    try {
      await executeLauncherAttempt({
        attemptRoot,
        fixture,
        attemptNumber: number,
        retryReason: explicitlyRetried ? "explicit_operator_retry" : null,
        sourcePath,
        approvedSource,
        promptTemplate,
        repoRoot,
        launcherPath: launcher,
        baseUrl: adapter.baseUrl,
        modelAlias: environment.model_cache.alias,
        pinnedCopilot,
        timeoutSeconds,
        environment,
        approvedCorpus: environment.corpus,
      });
    } finally {
      activeAttemptContext = null;
    }
  }
} catch (error) {
  interrupted = true;
  throw error;
} finally {
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  activeAttemptContext = null;
  try {
    await closeAdapter();
  } catch (error) {
    if (!interrupted) throw error;
  }
}

generateReport();
