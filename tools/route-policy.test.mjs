import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateRoute } from "./route-policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(
  root,
  ".github",
  "skills",
  "local-agent-delegation",
  "references",
  "approved-routes.json",
);

test("accepts the qualified sealed route", () => {
  const result = evaluateRoute({
    policyPath,
    runtime: "foundry-local",
    model: "qwen2.5-7b-instruct-generic-gpu",
    stream: "on",
    maxPromptTokens: 16384,
    profile: "sealed",
  });
  assert.equal(result.qualified, true);
  assert.equal(result.route_id, "foundry-qwen25-7b-qualified");
  assert.equal(result.override_used, false);
});

test("rejects an unapproved runtime and model", () => {
  assert.throws(() => evaluateRoute({
    policyPath,
    runtime: "lm-studio",
    model: "uncensored-model",
    stream: "on",
    maxPromptTokens: 16384,
    profile: "sealed",
  }), /Route is not approved/);
});

test("records an explicit unqualified override", () => {
  const result = evaluateRoute({
    policyPath,
    runtime: "ollama",
    model: "experimental-model",
    stream: "on",
    maxPromptTokens: 32768,
    profile: "sealed",
    allowUnqualified: true,
  });
  assert.equal(result.qualified, false);
  assert.equal(result.override_used, true);
  assert.equal(result.route_id, null);
});
