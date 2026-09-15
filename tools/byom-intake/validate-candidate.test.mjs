import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateCandidate } from "./validate-candidate.mjs";

const candidate = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "candidates",
      "qwen2.5-0.5b-openvino-gpu-int4.json",
    ),
    "utf8",
  ),
);

test("accepts the pinned rehearsal candidate", () => {
  assert.deepEqual(validateCandidate(candidate), []);
});

test("rejects a floating model revision", () => {
  const changed = structuredClone(candidate);
  changed.source.revision = "main";
  assert.match(validateCandidate(changed).join("\n"), /source\/revision/);
});

test("rejects unreviewed remote code", () => {
  const changed = structuredClone(candidate);
  changed.source.requires_remote_code = true;
  assert.match(validateCandidate(changed).join("\n"), /source\/requires_remote_code/);
});

test("rejects conversion remote code", () => {
  const changed = structuredClone(candidate);
  changed.conversion.trust_remote_code = true;
  assert.match(validateCandidate(changed).join("\n"), /trust_remote_code/);
});

test("rejects output outside the ignored results tree", () => {
  const changed = structuredClone(candidate);
  changed.artifact.output_directory = "models/candidate";
  assert.match(validateCandidate(changed).join("\n"), /results\/byom/);
});

test("requires every admission rung", () => {
  const changed = structuredClone(candidate);
  changed.qualification.evidence_gate = "optional";
  assert.match(validateCandidate(changed).join("\n"), /evidence_gate/);
});

test("requires expected converted artifacts", () => {
  const changed = structuredClone(candidate);
  changed.artifact.required_artifacts = [];
  assert.match(validateCandidate(changed).join("\n"), /required_artifacts/);
});

test("rejects an unpinned conversion environment", () => {
  const changed = structuredClone(candidate);
  changed.conversion.environment.openvino_version = "2026.3.1";
  assert.match(validateCandidate(changed).join("\n"), /openvino_version/);
});

test("rejects recipe path traversal", () => {
  const changed = structuredClone(candidate);
  changed.conversion.recipe_path = "../../../attacker/repo/main/payload.json";
  assert.match(validateCandidate(changed).join("\n"), /normalized relative POSIX path/);
});

test("rejects lexical output traversal", () => {
  const changed = structuredClone(candidate);
  changed.artifact.output_directory = "results/byom/../../.git";
  assert.match(validateCandidate(changed).join("\n"), /results\/byom/);
});

test("rejects unknown properties and invalid tool entries from the schema", () => {
  const changed = structuredClone(candidate);
  changed.unknown = true;
  changed.runtime.tools = [null];
  const errors = validateCandidate(changed).join("\n");
  assert.match(errors, /additional properties/);
  assert.match(errors, /must be string/);
});
