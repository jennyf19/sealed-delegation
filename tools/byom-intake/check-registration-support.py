from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import sys
from pathlib import Path


def is_reparse_point(path: Path) -> bool:
    return path.is_symlink() or (
        hasattr(path, "is_junction") and path.is_junction()
    )


def safe_repo_path(repo_root: Path, relative_path: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError("Candidate output directory must be a contained relative path.")
    candidate = Path(os.path.abspath(repo_root / relative))
    if not candidate.is_relative_to(repo_root):
        raise RuntimeError("Candidate output directory escaped the repository.")

    current = repo_root
    if is_reparse_point(current):
        raise RuntimeError(f"Repository root is a reparse point: {current}")
    for part in candidate.relative_to(repo_root).parts:
        current = current / part
        if current.exists() and is_reparse_point(current):
            raise RuntimeError(f"Candidate output traverses a reparse point: {current}")
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    candidate_path = safe_repo_path(
        repo_root,
        os.path.relpath(Path(args.candidate).absolute(), repo_root),
    )
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    candidate_root = safe_repo_path(
        repo_root,
        candidate["artifact"]["output_directory"],
    )
    allowed_root = safe_repo_path(repo_root, "results/byom")
    if not candidate_root.is_relative_to(allowed_root):
        raise RuntimeError("Candidate output directory escaped results/byom.")
    if "FOUNDRY_LOCAL_LIB_DIR" not in os.environ:
        raise RuntimeError("FOUNDRY_LOCAL_LIB_DIR must be set before importing the SDK.")

    from foundry_local_sdk._native.api import api

    installed_sdk_version = importlib.metadata.version("foundry-local-sdk")
    expected_sdk_version = candidate["runtime"]["foundry_sdk_version"]
    required = {
        "root.Manager_GetCatalogByType": hasattr(api.root, "Manager_GetCatalogByType"),
        "catalog.RegisterModel": hasattr(api.catalog, "RegisterModel"),
        "catalog.UnregisterModel": hasattr(api.catalog, "UnregisterModel"),
    }
    version_matches = installed_sdk_version == expected_sdk_version
    receipt = {
        "schema_version": "sealed-delegation/byom-registration-capability/v1",
        "candidate_id": candidate["candidate_id"],
        "expected_foundry_sdk_version": expected_sdk_version,
        "installed_foundry_sdk_version": installed_sdk_version,
        "sdk_version_matches": version_matches,
        "required_symbols": required,
        "registration_supported": version_matches and all(required.values()),
        "decision": "CONTINUE" if version_matches and all(required.values()) else "HOLD",
    }
    candidate_root.mkdir(parents=True, exist_ok=True)
    (candidate_root / "registration-capability.json").write_text(
        json.dumps(receipt, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["registration_supported"] else 2


if __name__ == "__main__":
    sys.exit(main())
