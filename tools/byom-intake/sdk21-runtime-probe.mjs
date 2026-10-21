import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as sdk from "foundry-local-sdk";
import { startAdapterServer } from "../foundry-session-probe/adapter.mjs";
import { validateCandidate } from "./validate-candidate.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../..");
const sdkPackage = join(
  dirname(fileURLToPath(import.meta.resolve("foundry-local-sdk"))), "..", "package.json",
);
const runtimeId = "foundry-local-session-byom-sdk21";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => sha256(readFileSync(path));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function createProbeDirectory(root) {
  let directory = root;
  for (const part of ["", "results", "byom", "sdk21-runtime-probes"]) {
    directory = join(directory, part);
    if (!existsSync(directory)) mkdirSync(directory);
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Probe output must not traverse a symbolic link or junction.");
    }
  }
  const output = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(output);
  return output;
}

function artifactFiles(root, directory = root) {
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error("Artifact directories must not be symbolic links or junctions.");
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Artifact links are not allowed.");
    if (entry.isDirectory()) return artifactFiles(root, path);
    if (!entry.isFile()) throw new Error("Unsupported artifact entry.");
    return [relative(root, path).replaceAll("\\", "/")];
  }).sort();
}

export function verifyArtifact(candidatePath, receiptPath) {
  const candidate = readJson(candidatePath);
  const errors = validateCandidate(candidate);
  if (errors.length) throw new Error(errors.join("; "));
  if (candidate.source.repository !== "Qwen/Qwen2.5-0.5B-Instruct" ||
      candidate.conversion.execution_provider !== "OpenVINOExecutionProvider") {
    throw new Error("This probe supports only the pinned Qwen2.5-0.5B OpenVINO candidate.");
  }
  const artifact = readJson(receiptPath);
  const attemptRoot = dirname(resolve(receiptPath));
  const modelDirectory = join(attemptRoot, "model");
  const conversionPath = join(attemptRoot, "conversion-receipt.json");
  if (artifact.schema_version !== "sealed-delegation/byom-artifact-receipt/v1" ||
      realpathSync(artifact.model_directory) !== realpathSync(modelDirectory) ||
      realpathSync(artifact.conversion_receipt_path) !== realpathSync(conversionPath) ||
      hashFile(conversionPath) !== artifact.conversion_receipt_sha256) {
    throw new Error("Artifact conversion linkage is invalid.");
  }
  const conversion = readJson(conversionPath);
  const candidateHash = hashFile(candidatePath);
  if (conversion.schema_version !== "sealed-delegation/byom-conversion-receipt/v1" ||
      conversion.executed !== true || conversion.exit_code !== 0 ||
      conversion.candidate_sha256 !== candidateHash ||
      conversion.candidate_id !== candidate.candidate_id ||
      artifact.candidate_id !== candidate.candidate_id ||
      conversion.source_revision !== candidate.source.revision ||
      conversion.recipe_revision !== candidate.conversion.recipe_revision) {
    throw new Error("Conversion does not match the supplied candidate.");
  }
  if (!Array.isArray(artifact.files) || artifact.files.length === 0 ||
      artifact.file_count !== artifact.files.length) {
    throw new Error("Artifact inventory is missing or inconsistent.");
  }
  const actualFiles = artifactFiles(modelDirectory);
  for (const pattern of candidate.artifact.required_artifacts) {
    const expression = new RegExp(`^${pattern.split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (!actualFiles.some((path) => expression.test(path.split("/").at(-1)))) {
      throw new Error(`Required artifact is missing: ${pattern}`);
    }
  }
  let bytes = 0;
  for (const file of artifact.files) {
    if (typeof file.path !== "string" || isAbsolute(file.path) ||
        !file.path.split("/").every((part) => part && part !== "." && part !== "..") ||
        /[\\:]/.test(file.path)) {
      throw new Error("Artifact inventory path is not contained.");
    }
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes <= 0 ||
        bytes + file.size_bytes > candidate.artifact.expected_max_size_bytes) {
      throw new Error("Artifact inventory exceeds its size limit.");
    }
    if (lstatSync(join(modelDirectory, file.path)).size !== file.size_bytes) {
      throw new Error(`Artifact file integrity failed: ${file.path}`);
    }
    const data = readFileSync(join(modelDirectory, file.path));
    if (data.length === 0 || data.length !== file.size_bytes || sha256(data) !== file.sha256) {
      throw new Error(`Artifact file integrity failed: ${file.path}`);
    }
    bytes += data.length;
  }
  if (JSON.stringify(actualFiles) !==
      JSON.stringify(artifact.files.map((file) => file.path).sort()) ||
      bytes !== artifact.total_size_bytes ||
      bytes > candidate.artifact.expected_max_size_bytes) {
    throw new Error("Artifact inventory or size limit is invalid.");
  }
  return { candidate, candidateHash, artifact, modelDirectory };
}

async function powershell(script, args, outputRoot, name) {
  const child = spawn("pwsh", ["-NoProfile", "-File", script, ...args], {
    cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  writeFileSync(join(outputRoot, `${name}-stdout.txt`), stdout);
  writeFileSync(join(outputRoot, `${name}-stderr.txt`), stderr);
  if (code !== 0) throw new Error(`${name} failed (${code}): ${stderr || stdout}`);
  return stdout;
}

export async function runProbe(values) {
  if (!values.candidate || !values["artifact-receipt"] || !values["library-path"]) {
    throw new Error("--candidate, --artifact-receipt and --library-path are required.");
  }
  const verified = verifyArtifact(resolve(values.candidate), resolve(values["artifact-receipt"]));
  const { candidate, artifact, modelDirectory } = verified;
  if (readJson(sdkPackage).version !== "2.1.0") throw new Error("Foundry SDK 2.1.0 is required.");
  const libraryPath = realpathSync(values["library-path"]);
  const nativeHash = hashFile(join(libraryPath, "foundry_local.dll"));
  const outputRoot = createProbeDirectory(repoRoot);
  const stagedModel = join(outputRoot, "model");
  mkdirSync(stagedModel);
  for (const file of artifact.files) {
    const data = readFileSync(join(modelDirectory, file.path));
    if (sha256(data) !== file.sha256) throw new Error("Artifact changed before staging.");
    const target = join(stagedModel, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: "wx" });
  }
  const report = {
    schema_version: "sealed-delegation/byom-sdk21-runtime-probe/v1",
    started_at: new Date().toISOString(),
    candidate_id: candidate.candidate_id,
    source_candidate_sha256: verified.candidateHash,
    source_artifact_receipt_sha256: hashFile(values["artifact-receipt"]),
    source_sdk_pin: candidate.runtime.foundry_sdk_version,
    probe_sdk_version: "2.1.0",
    sdk_package_sha256: hashFile(sdkPackage),
    native_library_sha256: nativeHash,
    verified_file_count: artifact.file_count,
    model_bytes: artifact.total_size_bytes,
    runtime: runtimeId,
    output_root: outputRoot,
    passed_stages: [],
    stage: "setup",
    status: "FAILED",
    decision: "HOLD",
    authority_advanced: false,
    purpose: "runtime_compatibility_only",
    remaining_gates: ["SDK-2.1 candidate admission contract", "prospective route qualification"],
  };
  const save = () => writeFileSync(
    join(outputRoot, "receipt.json"), `${JSON.stringify(report, null, 2)}\n`,
  );
  const stage = async (name, action) => {
    report.stage = name;
    save();
    await action();
    report.passed_stages.push(name);
    save();
  };
  let manager;
  let catalog;
  let metadata;
  let model;
  let session;
  let adapter;
  let gatesPassed = false;
  save();
  try {
    manager = sdk.FoundryLocalManager.create({
      appName: "sealed-delegation-byom-sdk21-probe",
      appDataDir: join(outputRoot, "app-data"),
      modelCacheDir: join(outputRoot, "catalog-cache"),
      logsDir: join(outputRoot, "logs"),
      libraryPath,
      disableNonessentialTelemetry: true,
    });
    if (values["register-openvino-ep"]) {
      report.ep_setup = await manager.downloadAndRegisterEps(["OpenVINOExecutionProvider"]);
    }
    report.execution_providers = manager.discoverEps();
    if (!report.execution_providers.some((ep) =>
      ep.name === "OpenVINOExecutionProvider" && ep.isRegistered)) {
      throw new Error("OpenVINO is not registered; authorize --register-openvino-ep first.");
    }
    catalog = manager.getCatalog(sdk.CatalogType.Local);
    metadata = new sdk.MutableModelInfo()
      .setStringProperty("task", "chat-completion")
      .setStringProperty("tool_call_start", "<tool_call>")
      .setStringProperty("tool_call_end", "</tool_call>")
      .setIntProperty("supports_tool_calling", 1);
    await stage("registration", async () => {
      model = await catalog.registerModel(
        stagedModel, candidate.artifact.inference_model_name, metadata,
      );
      report.model_id = model.id;
      await model.load();
    });
    await stage("plain_completion", async () => {
      session = new sdk.ChatSession(model);
      const response = await session.processRequest(new sdk.Request()
        .addItem(sdk.Item.userMessage("Reply exactly READY"))
        .setOptions({ search: { maxOutputTokens: 32, temperature: 0, doSample: false } }));
      report.plain_completion = response;
      const text = response.output
        .filter((item) => item.type === "message").map((item) => item.content).join("");
      if (response.finishReason !== "stop" || text.trim() !== "READY") {
        throw new Error("Plain completion did not return exact READY.");
      }
      session.dispose();
      session = null;
    });
    await stage("typed_tool", async () => {
      session = new sdk.ChatSession(model);
      session.addToolDefinition({
        name: "view", description: "Read one staged file.",
        jsonSchema: JSON.stringify({
          type: "object", properties: { path: { type: "string" } },
          required: ["path"], additionalProperties: false,
        }),
      });
      const response = await session.processRequest(new sdk.Request()
        .addItem(sdk.Item.userMessage("Use view to read canary.txt."))
        .setOptions({
          search: { maxOutputTokens: 128, temperature: 0, doSample: false },
          toolChoice: "required",
        }));
      report.typed_tool = response;
      const calls = response.output.filter((item) => item.type === "toolCall");
      if (response.finishReason !== "toolCalls" || calls.length !== 1 ||
          calls[0].name !== "view" || JSON.parse(calls[0].arguments).path !== "canary.txt") {
        throw new Error("Typed tool probe did not return the required view call.");
      }
      session.dispose();
      session = null;
    });
    adapter = await startAdapterServer({
      model,
      createSession: (selected) => new sdk.ChatSession(selected),
      createRequest: () => new sdk.Request(),
      itemFactory: sdk.Item,
      recordEvent: (event) => appendFileSync(
        join(outputRoot, "provider-events.jsonl"),
        `${JSON.stringify({ recorded_at: new Date().toISOString(), stage: report.stage, ...event })}\n`,
      ),
    });
    const common = [
      "-BaseUrl", adapter.baseUrl, "-RuntimeId", runtimeId, "-Model", model.id,
      "-MaxPromptTokens", String(candidate.runtime.max_prompt_tokens),
      "-AllowUnqualifiedRoute", "-TimeoutSeconds", "180",
    ];
    await stage("copilot_canary", async () => {
      const stdout = await powershell(join(repoRoot, "tools", "local-agent-preflight.ps1"),
        [...common, "-Stream", "on", "-MaxOutputTokens", "512",
          "-RunRoot", join(outputRoot, "canary-runs")], outputRoot, "canary");
      const canary = JSON.parse(stdout.trim());
      report.canary = canary;
      if (canary.status !== "READY" || canary.staged_input_hash_verified !== true) {
        throw new Error("The independent staged canary gate did not pass.");
      }
    });
    await stage("evidence_gate", async () => {
      await powershell(
        join(repoRoot, "examples", "evidence-check", "run-agentic-demo.ps1"),
        [...common, "-RunRoot", join(outputRoot, "evidence-runs")],
        outputRoot, "evidence",
      );
    });
    gatesPassed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    console.error(report.error);
  } finally {
    try {
      await adapter?.close();
      session?.dispose();
      if (model && await model.isLoaded()) await model.unload();
      if (model) await catalog.unregisterModel(model.id);
      metadata?.dispose();
      manager?.dispose();
      report.cleanup_completed = true;
    } catch (error) {
      report.cleanup_error = error instanceof Error ? error.message : String(error);
      console.error(report.cleanup_error);
    }
    report.status = gatesPassed && report.cleanup_completed ? "SMOKE_PASSED" : "FAILED";
    report.finished_at = new Date().toISOString();
    save();
  }
  console.log(JSON.stringify(report, null, 2));
  return report.status === "SMOKE_PASSED" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    candidate: { type: "string" },
    "artifact-receipt": { type: "string" },
    "library-path": { type: "string" },
    "register-openvino-ep": { type: "boolean", default: false },
  } });
  process.exitCode = await runProbe(values);
}
