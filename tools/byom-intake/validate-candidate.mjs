import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CANDIDATE_PATTERN = /^[a-z0-9][a-z0-9.-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9_.-]+:[1-9][0-9]*$/;
const DEVICES = new Set(["cpu", "gpu", "npu"]);
const PROVIDERS = new Set([
  "CPUExecutionProvider",
  "CUDAExecutionProvider",
  "OpenVINOExecutionProvider",
  "QNNExecutionProvider",
  "VitisAIExecutionProvider",
  "NvTensorRTRTXExecutionProvider",
  "WebGpuExecutionProvider",
]);
const PRECISIONS = new Set(["fp32", "fp16", "int8", "int4"]);
const schema = JSON.parse(
  readFileSync(new URL("./candidate.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function isNormalizedRelativePosixPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.every((segment) => segment && segment !== "." && segment !== "..") &&
    segments.join("/") === value
  );
}

function requireObject(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object.`);
    return false;
  }
  return true;
}

function requireMatch(value, pattern, path, errors) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${path} has an invalid value.`);
  }
}

export function validateCandidate(candidate) {
  const errors = [];
  if (!validateSchema(candidate)) {
    errors.push(
      ...validateSchema.errors.map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      ),
    );
    return errors;
  }
  if (!requireObject(candidate, "candidate", errors)) return errors;
  if (candidate.schema_version !== "sealed-delegation/byom-candidate/v1") {
    errors.push("schema_version must be sealed-delegation/byom-candidate/v1.");
  }
  requireMatch(candidate.candidate_id, CANDIDATE_PATTERN, "candidate_id", errors);

  if (requireObject(candidate.source, "source", errors)) {
    if (candidate.source.provider !== "hugging-face") {
      errors.push("source.provider must be hugging-face.");
    }
    requireMatch(candidate.source.repository, REPOSITORY_PATTERN, "source.repository", errors);
    requireMatch(candidate.source.revision, SHA_PATTERN, "source.revision", errors);
    if (candidate.source.official_publisher !== true) {
      errors.push("source.official_publisher must be true.");
    }
    if (typeof candidate.source.license_id !== "string" || !candidate.source.license_id) {
      errors.push("source.license_id is required.");
    }
    if (
      typeof candidate.source.license_url !== "string" ||
      !candidate.source.license_url.startsWith("https://")
    ) {
      errors.push("source.license_url must be an HTTPS URL.");
    }
    if (candidate.source.requires_remote_code !== false) {
      errors.push("source.requires_remote_code must be false for the default intake path.");
    }
  }

  if (requireObject(candidate.conversion, "conversion", errors)) {
    if (candidate.conversion.tool !== "olive") {
      errors.push("conversion.tool must be olive.");
    }
    requireMatch(candidate.conversion.olive_version, VERSION_PATTERN, "conversion.olive_version", errors);
    if (candidate.conversion.recipe_repository !== "microsoft/olive-recipes") {
      errors.push("conversion.recipe_repository must be microsoft/olive-recipes.");
    }
    requireMatch(candidate.conversion.recipe_revision, SHA_PATTERN, "conversion.recipe_revision", errors);
    if (!isNormalizedRelativePosixPath(candidate.conversion.recipe_path)) {
      errors.push("conversion.recipe_path must be a normalized relative POSIX path.");
    }
    if (
      typeof candidate.conversion.requirements_lock_path !== "string" ||
      !/^tools\/byom-intake\/[A-Za-z0-9_.-]+$/.test(
        candidate.conversion.requirements_lock_path,
      )
    ) {
      errors.push("conversion.requirements_lock_path is invalid.");
    }
    requireMatch(
      candidate.conversion.requirements_lock_sha256,
      /^[0-9a-f]{64}$/,
      "conversion.requirements_lock_sha256",
      errors,
    );
    if (!DEVICES.has(candidate.conversion.device)) {
      errors.push("conversion.device is unsupported.");
    }
    if (!PROVIDERS.has(candidate.conversion.execution_provider)) {
      errors.push("conversion.execution_provider is unsupported.");
    }
    if (!PRECISIONS.has(candidate.conversion.precision)) {
      errors.push("conversion.precision is unsupported.");
    }
    if (candidate.conversion.trust_remote_code !== false) {
      errors.push("conversion.trust_remote_code must be false for the default intake path.");
    }
    const environment = candidate.conversion.environment;
    const expectedEnvironment = {
      python_version: "3.12.10",
      numpy_version: "1.26.4",
      openvino_version: "2025.4.1",
      openvino_tokenizers_version: "2025.4.1.0",
      onnxruntime_openvino_version: "1.24.1",
      optimum_intel_version: "1.27.0",
      nncf_version: "2.19.0",
    };
    if (!requireObject(environment, "conversion.environment", errors)) {
      // requireObject records the error
    } else {
      for (const [field, expected] of Object.entries(expectedEnvironment)) {
        if (environment[field] !== expected) {
          errors.push(`conversion.environment.${field} must be ${expected}.`);
        }
      }
    }
  }

  if (requireObject(candidate.artifact, "artifact", errors)) {
    if (
      !isNormalizedRelativePosixPath(candidate.artifact.output_directory) ||
      !candidate.artifact.output_directory.startsWith("results/byom/")
    ) {
      errors.push("artifact.output_directory must be under results/byom/.");
    }
    requireMatch(
      candidate.artifact.inference_model_name,
      MODEL_NAME_PATTERN,
      "artifact.inference_model_name",
      errors,
    );
    if (
      !Number.isInteger(candidate.artifact.expected_max_size_bytes) ||
      candidate.artifact.expected_max_size_bytes < 1
    ) {
      errors.push("artifact.expected_max_size_bytes must be a positive integer.");
    }
    if (
      !Array.isArray(candidate.artifact.required_artifacts) ||
      candidate.artifact.required_artifacts.length === 0 ||
      candidate.artifact.required_artifacts.some(
        (pattern) =>
          typeof pattern !== "string" ||
          pattern.length === 0 ||
          pattern.includes("\\") ||
          pattern.includes("/") ||
          pattern.includes(".."),
      ) ||
      new Set(candidate.artifact.required_artifacts).size !==
        candidate.artifact.required_artifacts.length
    ) {
      errors.push(
        "artifact.required_artifacts must be a nonempty unique array of filename patterns.",
      );
    }
  }

  if (requireObject(candidate.runtime, "runtime", errors)) {
    requireMatch(
      candidate.runtime.foundry_sdk_version,
      VERSION_PATTERN,
      "runtime.foundry_sdk_version",
      errors,
    );
    requireMatch(
      candidate.runtime.adapter_runtime_id,
      CANDIDATE_PATTERN,
      "runtime.adapter_runtime_id",
      errors,
    );
    if (candidate.runtime.stream !== "on") {
      errors.push("runtime.stream must be on.");
    }
    if (
      !Array.isArray(candidate.runtime.tools) ||
      candidate.runtime.tools.length === 0 ||
      new Set(candidate.runtime.tools).size !== candidate.runtime.tools.length
    ) {
      errors.push("runtime.tools must be a nonempty unique array.");
    }
    if (
      !Number.isInteger(candidate.runtime.max_prompt_tokens) ||
      candidate.runtime.max_prompt_tokens < 1
    ) {
      errors.push("runtime.max_prompt_tokens must be a positive integer.");
    }
  }

  if (requireObject(candidate.qualification, "qualification", errors)) {
    for (const field of [
      "plain_completion",
      "typed_tool_probe",
      "staged_canary",
      "evidence_gate",
    ]) {
      if (candidate.qualification[field] !== "required") {
        errors.push(`qualification.${field} must be required.`);
      }
    }
  }
  return errors;
}

export function loadAndValidateCandidate(path) {
  const resolved = resolve(path);
  const candidate = JSON.parse(readFileSync(resolved, "utf8"));
  const errors = validateCandidate(candidate);
  return { resolved, candidate, errors };
}

function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node validate-candidate.mjs <candidate.json>");
  const result = loadAndValidateCandidate(path);
  console.log(
    JSON.stringify(
      {
        status: result.errors.length === 0 ? "VALID" : "INVALID",
        path: result.resolved,
        candidate_id: result.candidate.candidate_id,
        errors: result.errors,
      },
      null,
      2,
    ),
  );
  if (result.errors.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
