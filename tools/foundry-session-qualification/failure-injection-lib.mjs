export function failureInjectionSpecifications(fixture) {
  return [
    {
      id: "adapter-unavailable",
      mode: "unavailable",
      expectedReasons: ["missing_launcher_receipt", "provider_telemetry_missing"],
      requireNonzeroLauncherExit: true,
    },
    {
      id: "terminate-after-sse-headers",
      mode: "transport",
      expectedReasons: ["provider_request_failed"],
      requireNonzeroLauncherExit: true,
    },
    {
      id: "terminate-mid-stream",
      mode: "transport",
      midStream: true,
      expectedReasons: ["provider_request_failed"],
      requireNonzeroLauncherExit: true,
    },
    {
      id: "sdk-finish-length",
      mode: "adapter",
      finishReason: "length",
      expectedReasons: ["provider_finish_length", "provider_final_finish_not_stop"],
    },
    {
      id: "sdk-finish-error",
      mode: "adapter",
      finishReason: "error",
      expectedReasons: ["provider_request_failed"],
      requireNonzeroLauncherExit: true,
    },
    {
      id: "empty-output",
      mode: "adapter",
      text: "",
      expectedReasons: ["empty_output"],
    },
    {
      id: "malformed-json-output",
      mode: "adapter",
      text: '{"status":"blocked"',
      expectedReasons: ["malformed_json_output"],
    },
    {
      id: "raw-tool-call-markup",
      mode: "adapter",
      text: '<tool_call>{"name":"view","arguments":{}}</tool_call>',
      expectedReasons: ["raw_tool_markup"],
    },
    {
      id: "wrong-model-id",
      mode: "adapter",
      modelId: "wrong-model",
      expectedReasons: ["provider_request_rejected"],
      requireNonzeroLauncherExit: true,
    },
    {
      id: "wrong-missing-input-code",
      mode: "adapter",
      text: JSON.stringify({
        ...fixture.expected,
        missing_input_code: fixture.missing_input_options.find(
          (code) => code !== fixture.expected.missing_input_code,
        ),
      }),
      expectedReasons: ["missing_input_code_mismatch"],
    },
    {
      id: "empty-missing-input-description",
      mode: "adapter",
      text: JSON.stringify({ ...fixture.expected, missing_input: "   " }),
      expectedReasons: ["missing_input_description_invalid"],
    },
    {
      id: "missing-semantic-code-field",
      mode: "adapter",
      text: JSON.stringify({
        status: fixture.expected.status,
        answer: fixture.expected.answer,
        missing_input: fixture.expected.missing_input,
        source: fixture.expected.source,
      }),
      expectedReasons: ["json_shape_mismatch"],
    },
    {
      id: "child-timeout",
      mode: "transport",
      hang: true,
      expectedReasons: ["launcher_status_timeout"],
      requireNonzeroLauncherExit: true,
      timeoutSeconds: 30,
    },
  ];
}

export function classifyFailureInjection(testCase, execution) {
  const integrityFailurePrefixes = [
    "attempt_",
    "approved_source_",
    "copilot_",
    "launcher_stderr_hash_",
    "launcher_stdout_hash_",
    "runtime_mismatch",
    "model_mismatch",
    "stream_mismatch",
    "profile_mismatch",
    "task_mode_mismatch",
    "prompt_budget_mismatch",
    "tool_allowlist_mismatch",
    "research_override_not_recorded",
    "source_staged_hash_mismatch",
    "staged_file_hash_mismatch",
    "staged_input_count_mismatch",
  ];
  const integrityFailureReasons = execution.gate.failure_reasons.filter((reason) =>
    integrityFailurePrefixes.some((prefix) => reason.startsWith(prefix)));
  const observedExpectedReason = testCase.expectedReasons.some(
    (reason) => execution.gate.failure_reasons.includes(reason),
  );
  const launcherExit = execution.run?.exit_code ??
    execution.launcherResult.code ??
    1;
  const passed =
    execution.gate.gate_accepted === false &&
    execution.gate.authority_advanced === false &&
    integrityFailureReasons.length === 0 &&
    observedExpectedReason &&
    (!testCase.requireNonzeroLauncherExit || Number(launcherExit) !== 0);
  return {
    id: testCase.id,
    launcher_status: execution.run?.status ?? "NO_RECEIPT",
    launcher_exit_code: launcherExit,
    gate_accepted: execution.gate.gate_accepted,
    gate_failure_reasons: execution.gate.failure_reasons,
    expected_failure_reasons: testCase.expectedReasons,
    expected_failure_observed: observedExpectedReason,
    authority_advanced: execution.gate.authority_advanced,
    passed,
  };
}
