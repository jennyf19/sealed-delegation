import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  gradeAttempt,
  loadCorpus,
  readJsonLines,
  validateCorpus,
  writeJson,
} from "./qualification-lib.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const manifestPath = resolve(valueAfter("--manifest") ?? "");
const fixtureId = valueAfter("--fixture");
const runPathValue = valueAfter("--run");
const providerPathValue = valueAfter("--provider-events");
const environmentPathValue = valueAfter("--environment");
const attemptPathValue = valueAfter("--attempt");
const outputPath = resolve(valueAfter("--output") ?? "");
const attemptNumberValue = valueAfter("--attempt-number");
if (!manifestPath || !fixtureId || !attemptPathValue || !outputPath) {
  throw new Error(
    "Usage: node grader.mjs --manifest <manifest> --fixture <id> " +
    "--attempt <attempt.json> --run <run.json> --provider-events <events.jsonl> " +
    "--environment <receipt.json> --output <gate.json>",
  );
}

const { manifest } = loadCorpus(manifestPath);
const fixture = manifest.fixtures.find((candidate) => candidate.id === fixtureId);
if (!fixture) throw new Error(`Unknown fixture: ${fixtureId}`);
const runPath = runPathValue ? resolve(runPathValue) : null;
const run = runPath && existsSync(runPath)
  ? JSON.parse(readFileSync(runPath, "utf8"))
  : null;
const raw = run?.stdout_path && existsSync(run.stdout_path)
  ? readFileSync(run.stdout_path, "utf8")
  : "";
const environment = environmentPathValue && existsSync(resolve(environmentPathValue))
  ? JSON.parse(readFileSync(resolve(environmentPathValue), "utf8"))
  : null;
const attempt = JSON.parse(readFileSync(resolve(attemptPathValue), "utf8"));
const approvedCorpus = environment?.corpus ?? validateCorpus(manifestPath);
const providerEvents = providerPathValue
  ? readJsonLines(resolve(providerPathValue))
  : [];
const gate = {
  ...gradeAttempt({
    fixture,
    run,
    raw,
    providerEvents,
    environment,
    attemptNumber: attemptNumberValue === null ? null : Number(attemptNumberValue),
    attempt,
    approvedCorpus,
  }),
  gated_at: new Date().toISOString(),
  gate_path: outputPath,
  attempt_directory: dirname(outputPath),
};
writeJson(outputPath, gate);
console.log(JSON.stringify(gate, null, 2));
process.exitCode = gate.gate_accepted ? 0 : 1;
