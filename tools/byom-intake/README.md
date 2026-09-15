# Hugging Face BYOM intake

This unqualified experiment admits a pinned Hugging Face model into a reproducible
Hugging Face → Olive/ONNX → Foundry Local Session evaluation.

It does not add a model to `approved-routes.json`.

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

The intended first two rungs use Foundry's local-catalog registration API. Current Foundry source
contains that API, but the published SDK 2.0.1 ABI does not. Do not fabricate catalog metadata or
build route evidence against unreleased SDK source; record the candidate as HOLD at registration.

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
