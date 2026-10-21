# Hugging Face BYOM intake

This unqualified experiment admits a pinned Hugging Face model into a reproducible
Hugging Face → Olive/ONNX → Foundry Local Session evaluation.

It does not add a model to `approved-routes.json`.

## Released SDK 2.1 runtime probe

SDK 2.1.0 includes the local-catalog registration API missing from the historical 2.0.1 attempt.
The BYOM package pins 2.1.0 separately; the existing Session qualification package and frozen
candidate remain pinned to 2.0.1. Do not repin an old candidate and reuse its conversion receipt.

Install the locked BYOM and adapter packages without automatic native downloads:

```powershell
npm ci --ignore-scripts --prefix tools\byom-intake
npm ci --ignore-scripts --prefix tools\foundry-session-probe
```

Use the official `foundry-local-win-x64.zip` from release `v2.1.0`, verify its published digest, and
pass its extracted `lib` directory. Point at an existing successful conversion's artifact receipt:

```powershell
node tools\byom-intake\sdk21-runtime-probe.mjs `
  --candidate tools\byom-intake\candidates\qwen2.5-0.5b-openvino-gpu-int4.json `
  --artifact-receipt C:\path\to\attempt\artifact-receipt.json `
  --library-path C:\path\to\foundry-local-2.1.0\lib `
  --register-openvino-ep
```

The last flag explicitly permits SDK-managed OpenVINO dependency setup, which may use Windows
ML's shared per-user cache. Get operator approval first. No model download is performed.

The probe verifies conversion linkage and every model file, stages a new copy, registers it through
the supported local catalog, and stops at the first failed stage. It tests exact plain completion,
typed `view`, a real Copilot staged-file canary, and the existing independently gated synthetic
evidence example. Each attempt gets a new directory under `results\byom\sdk21-runtime-probes`.
The reused adapter receives item/request/session factories from the same SDK; no SDK-native
objects cross the 2.0.1/2.1.0 boundary.

`SMOKE_PASSED` means only these protocol checks passed. The decision remains **HOLD**, even then:
the original candidate still pins 2.0.1, the example is not a semantic benchmark, and a new
admission contract plus prospective qualification are still required. No frozen result is rerun
or rewritten. A failed stage or cleanup returns nonzero and preserves the failed attempt.

## First rehearsal candidate

`Qwen/Qwen2.5-0.5B-Instruct` is intentionally small and has an official Microsoft Olive recipe for
OpenVINO GPU INT4. The candidate manifest pins both the Hugging Face revision and Olive recipe
revision. It also pins Python, NumPy, OpenVINO, ONNX Runtime OpenVINO, and Optimum Intel versions;
the conversion stops before execution if the environment differs.

## Validate before download

```powershell
node .\validate-candidate.mjs .\candidates\qwen2.5-0.5b-openvino-gpu-int4.json
npm test
```

The validator fails before conversion when the model revision floats, the license is absent, remote
code is unreviewed, the provider/precision is unsupported, output escapes `results/byom/`, or an
admission rung is optional. Windows runs also fail before conversion when the projected Olive cache
path is too long.

Create the conversion environment with Python 3.12:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes `
  -r .\requirements-openvino.lock.txt
```

## Admission ladder

After conversion, run in order and stop at the first failure:

1. exact plain completion;
2. typed Session tool call;
3. exact staged nonce canary;
4. frozen evidence gate.

Every first attempt remains part of the receipt. Admission permits a later qualification run; it is
not route approval.

The historical first attempt used released SDK 2.0.1, whose ABI lacks local-catalog registration.
That candidate remains HOLD. The separate released-2.1.0 probe above can test runtime compatibility
without changing the old manifest or fabricating cache metadata.

```powershell
pwsh .\prepare-conversion.ps1 `
  -CandidatePath .\candidates\qwen2.5-0.5b-openvino-gpu-int4.json `
  -Python .\.venv\Scripts\python.exe `
  -Execute
```

## Finalize the converted artifact

```powershell
pwsh .\finalize-artifact.ps1 `
  -CandidatePath .\candidates\qwen2.5-0.5b-openvino-gpu-int4.json `
  -ConversionReceiptPath C:\path\to\attempt\conversion-receipt.json
```

This enforces the artifact size ceiling and creates a SHA-256 inventory under the ignored candidate
output directory. Registration is performed at admission time through Foundry Local's native local
catalog API; generated catalog indexes are not treated as source artifacts. Every execution uses a

Check whether the installed Foundry SDK release exposes that registration API:

```powershell
$env:FOUNDRY_LOCAL_LIB_DIR = "C:\path\to\foundry-local-sdk-native"
C:\path\to\python.exe .\check-registration-support.py `
  .\candidates\qwen2.5-0.5b-openvino-gpu-int4.json
```

Exit code `2` means the conversion is usable as an artifact, but the installed SDK cannot admit it
to a typed Session route yet. Every execution uses a
fresh `attempts/<timestamp-id>/` directory and never reuses a prior attempt's Olive cache or model
output.
