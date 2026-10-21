import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProbeDirectory, verifyArtifact } from "./sdk21-runtime-probe.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) => writeFileSync(path, JSON.stringify(value));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sealed-sdk21-artifact-"));
  const candidatePath = join(root, "candidate.json");
  const candidateBytes = readFileSync(new URL(
    "./candidates/qwen2.5-0.5b-openvino-gpu-int4.json", import.meta.url,
  ));
  const candidate = JSON.parse(candidateBytes);
  writeFileSync(candidatePath, candidateBytes);
  const model = join(root, "model");
  mkdirSync(model);
  const files = Object.entries({
    "genai_config.json": "{}",
    "tokenizer.json": "{}",
    "model.onnx": "pinned graph",
    "model.bin": "pinned model bytes",
  }).map(([path, content]) => {
    const bytes = Buffer.from(content);
    writeFileSync(join(model, path), bytes);
    return { path, size_bytes: bytes.length, sha256: hash(bytes) };
  });
  const conversionPath = join(root, "conversion-receipt.json");
  const conversion = {
    schema_version: "sealed-delegation/byom-conversion-receipt/v1",
    candidate_id: candidate.candidate_id,
    candidate_sha256: hash(candidateBytes),
    source_revision: candidate.source.revision,
    recipe_revision: candidate.conversion.recipe_revision,
    executed: true,
    exit_code: 0,
  };
  json(conversionPath, conversion);
  const artifact = {
    schema_version: "sealed-delegation/byom-artifact-receipt/v1",
    candidate_id: candidate.candidate_id,
    model_directory: model,
    conversion_receipt_path: conversionPath,
    conversion_receipt_sha256: hash(readFileSync(conversionPath)),
    file_count: files.length,
    total_size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    files,
  };
  const receiptPath = join(root, "artifact-receipt.json");
  json(receiptPath, artifact);
  return { root, candidatePath, receiptPath, model, artifact, conversion, conversionPath };
}

test("accepts an intact artifact linked to the exact conversion candidate", () => {
  const value = fixture();
  try {
    const verified = verifyArtifact(value.candidatePath, value.receiptPath);
    assert.equal(verified.modelDirectory, value.model);
    assert.equal(verified.candidateHash, value.conversion.candidate_sha256);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects changed model bytes before SDK registration", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.model, "model.bin"), "modified");
    assert.throws(() => verifyArtifact(value.candidatePath, value.receiptPath),
      /Artifact file integrity failed/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects a candidate changed after conversion", () => {
  const value = fixture();
  try {
    const candidate = JSON.parse(readFileSync(value.candidatePath));
    candidate.runtime.foundry_sdk_version = "2.1.0";
    json(value.candidatePath, candidate);
    assert.throws(() => verifyArtifact(value.candidatePath, value.receiptPath),
      /Conversion does not match/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects unlisted model files", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.model, "extra.bin"), "unlisted");
    assert.throws(() => verifyArtifact(value.candidatePath, value.receiptPath),
      /Artifact inventory or size limit/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects an inventory path that escapes the model directory", () => {
  const value = fixture();
  try {
    value.artifact.files[0].path = "../outside.bin";
    json(value.receiptPath, value.artifact);
    assert.throws(() => verifyArtifact(value.candidatePath, value.receiptPath),
      /Artifact inventory path is not contained/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects a complete inventory that omits a required artifact", () => {
  const value = fixture();
  try {
    unlinkSync(join(value.model, "tokenizer.json"));
    value.artifact.files = value.artifact.files.filter((file) => file.path !== "tokenizer.json");
    value.artifact.file_count = value.artifact.files.length;
    value.artifact.total_size_bytes = value.artifact.files.reduce(
      (sum, file) => sum + file.size_bytes, 0,
    );
    json(value.receiptPath, value.artifact);
    assert.throws(() => verifyArtifact(value.candidatePath, value.receiptPath),
      /Required artifact is missing/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("enforces the candidate size limit before reading model contents", () => {
  const value = fixture();
  try {
    const candidate = JSON.parse(readFileSync(value.candidatePath));
    candidate.artifact.expected_max_size_bytes = 1;
    json(value.candidatePath, candidate);
    value.conversion.candidate_sha256 = hash(readFileSync(value.candidatePath));
    json(value.conversionPath, value.conversion);
    value.artifact.conversion_receipt_sha256 = hash(readFileSync(value.conversionPath));
    json(value.receiptPath, value.artifact);
    assert.throws(() => verifyArtifact(value.candidatePath, value.receiptPath),
      /size limit/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("refuses an output junction before creating files outside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "sealed-sdk21-output-"));
  const outside = mkdtempSync(join(tmpdir(), "sealed-sdk21-outside-"));
  try {
    symlinkSync(outside, join(root, "results"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => createProbeDirectory(root), /symbolic link or junction/);
    assert.equal(existsSync(join(outside, "byom")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
