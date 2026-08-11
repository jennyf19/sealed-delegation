import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function evaluateRoute({
  policyPath,
  runtime,
  model,
  stream,
  maxPromptTokens,
  profile,
  allowUnqualified = false,
}) {
  const resolvedPolicy = resolve(policyPath);
  const raw = readFileSync(resolvedPolicy, "utf8");
  const policy = JSON.parse(raw);
  if (policy.schema_version !== "sealed-delegation/approved-routes/v1") {
    throw new Error(`Unsupported route policy schema: ${policy.schema_version}`);
  }

  const route = (policy.routes || []).find((candidate) =>
    candidate.status === "qualified" &&
    candidate.runtime === runtime &&
    candidate.model === model &&
    candidate.stream === stream &&
    Number(candidate.max_prompt_tokens) === Number(maxPromptTokens) &&
    Array.isArray(candidate.profiles) &&
    candidate.profiles.includes(profile));
  const qualified = Boolean(route);
  if (!qualified && !allowUnqualified) {
    throw new Error(
      `Route is not approved: runtime=${runtime} model=${model} stream=${stream} ` +
      `max_prompt_tokens=${maxPromptTokens} profile=${profile}.`,
    );
  }

  return {
    policy_path: resolvedPolicy,
    policy_sha256: createHash("sha256").update(raw).digest("hex"),
    policy_id: policy.policy_id,
    route_id: route?.id ?? null,
    qualified,
    override_used: !qualified,
    runtime,
    model,
    stream,
    max_prompt_tokens: Number(maxPromptTokens),
    profile,
  };
}
