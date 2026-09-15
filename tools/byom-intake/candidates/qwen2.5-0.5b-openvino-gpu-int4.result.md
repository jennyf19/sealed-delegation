# Qwen2.5 0.5B OpenVINO GPU INT4 result

**Decision:** HOLD at the Foundry Session registration rung.

## Frozen inputs

- Hugging Face: `Qwen/Qwen2.5-0.5B-Instruct`
- revision: `7ae557604adf67be50417f59c2c2f167def9a775`
- license: Apache-2.0
- Olive recipe: `microsoft/olive-recipes` at
  `38e17a606cdabc8f95e98c2424d60146f9ad5712`
- recipe:
  `Qwen-Qwen2.5-0.5B-Instruct/aitk/qwen2_5_ov_config.json`

## Conversion

The pinned Python 3.12 / Olive 0.13 / OpenVINO 2025.4 stack completed the official OpenVINO GPU
INT4 recipe:

- conversion exit: 0;
- final clean-attempt conversion wall: approximately 53.4 seconds, with the Hugging Face source
  already present in the local cache;
- final artifact: 22 files, 384,287,877 bytes;
- primary weights: `openvino_model_dy.bin`, 358,224,301 bytes;
- source and recipe revisions were passed into the resolved Olive configuration;
- generated artifact inventory and SHA-256 hashes are stored in the ignored candidate results.

The environment required explicit compatibility pins. Python 3.13 could not resolve the NumPy
constraint. `onnxruntime-openvino` 1.24.1 could not load OpenVINO 2026.3.1. The working stack uses
OpenVINO 2025.4.1, Optimum Intel 1.27.0, NNCF 2.19.0, and NumPy 1.26.4.

## Admission blocker

Foundry's current source contains a local-catalog `RegisterModel` API that supplies
`task=chat-completion`, and its BYOM end-to-end test uses that API. The published JavaScript and
Python 2.0.1 APIs/ABI do not expose `Manager_GetCatalogByType` / `RegisterModel`; those symbols are
not present in the released headers or native vtable. The machine-readable capability receipt
records all three required symbols as absent and returns `HOLD`.

A cache-only diagnostic discovered the generated artifact, but its task remained `(unset)`, so
typed `ChatSession` correctly refused it. Handwritten cache metadata did not change that result and
is not part of the proposed intake workflow.

## Outcome

The reusable intake pipeline successfully validates, pins, converts in a fresh immutable attempt,
inventories, and size-gates an official Hugging Face model. The first candidate cannot proceed to
plain completion, typed-tool, canary, or evidence gates using the released Foundry Local 2.0.1 SDK.

Reconsider when a released Foundry SDK exposes local model registration. Do not build against
unreleased `main` or fabricate catalog metadata for route qualification.
