"""Triton stage I/O contract tests.

Parses ``specs/001-zero-training-mvp/contracts/triton-stages.md`` and asserts
each served model's ``config.pbtxt`` matches the contract's declared input /
output tensor shapes, dtypes, and axis ordering.

Blocking CI gate on any PR touching ``triton-models/**`` or the contract doc.

References:
    - Plan §Contract tests (Triton stage I/O)
    - Tasks T358
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pytest

# Paths ----------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACT_DOC = REPO_ROOT / "specs" / "001-zero-training-mvp" / "contracts" / "triton-stages.md"
TRITON_MODELS_ROOT = REPO_ROOT / "packages" / "ml-inference" / "triton-models"

# Dtype mapping: contract doc → Triton data_type enum string
DTYPE_MAP: Dict[str, str] = {
    "fp32": "TYPE_FP32",
    "fp16": "TYPE_FP16",
    "uint8": "TYPE_UINT8",
    "int32": "TYPE_INT32",
    "int64": "TYPE_INT64",
}


# ---------------------------------------------------------------------------
# Contract parser
# ---------------------------------------------------------------------------


_STAGE_HEADER_RE = re.compile(r"^##\s+Stage\s+\d+\s+—\s+(.+?)\s*$")
_MODEL_NAME_RE = re.compile(r"^\*\*Model name\*\*:\s*`([^`]+)`")
_TABLE_ROW_RE = re.compile(
    r"^\|\s*(input|output)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|"
)


def _parse_contract(doc: Path) -> Dict[str, Dict[str, List[dict]]]:
    """Return ``{model_name: {"inputs": [...], "outputs": [...]}}``.

    Each entry has ``{"name": str, "shape": str | None, "dtype": str | None}``.
    Rows whose shape is non-parseable (json/scalar) are retained with
    ``shape=None`` for dtype-only validation.
    """

    if not doc.exists():
        pytest.skip(f"Contract doc missing: {doc}")

    current_model: Optional[str] = None
    result: Dict[str, Dict[str, List[dict]]] = {}

    for line in doc.read_text().splitlines():
        name_match = _MODEL_NAME_RE.match(line)
        if name_match:
            current_model = name_match.group(1)
            result.setdefault(current_model, {"inputs": [], "outputs": []})
            continue

        row_match = _TABLE_ROW_RE.match(line)
        if row_match and current_model is not None:
            io_kind, tensor_name, shape_str, dtype_str = row_match.groups()
            shape = _parse_shape(shape_str)
            dtype = DTYPE_MAP.get(dtype_str.strip().lower())
            bucket = "inputs" if io_kind == "input" else "outputs"
            result[current_model][bucket].append(
                {"name": tensor_name, "shape": shape, "dtype": dtype}
            )
    return result


def _parse_shape(shape_str: str) -> Optional[List[int]]:
    """Parse ``[1, 1, Z, 512, 512]`` style shape → list of dims or -1 for symbolic.

    Returns ``None`` for unparseable strings (``scalar``, ``json``, etc.).
    """

    s = shape_str.strip().strip("[]")
    if not s or s.lower() in {"scalar", "json", "—", "-"}:
        return None
    dims: List[int] = []
    for piece in (p.strip() for p in s.split(",")):
        if not piece:
            continue
        try:
            dims.append(int(piece))
        except ValueError:
            # Symbolic dim (Z, L, etc.) → Triton represents as -1
            dims.append(-1)
    return dims or None


# ---------------------------------------------------------------------------
# Triton config.pbtxt parser (minimal — enough for input/output blocks)
# ---------------------------------------------------------------------------


_BLOCK_RE = re.compile(r"(input|output)\s*\[\s*\{(.*?)\}\s*\]", re.DOTALL)
_KV_RE = re.compile(r'(\w+)\s*:\s*("[^"]*"|\[[^\]]*\]|\S+)')


def _parse_pbtxt(path: Path) -> Dict[str, List[dict]]:
    if not path.exists():
        return {"inputs": [], "outputs": []}
    text = path.read_text()
    blocks: Dict[str, List[dict]] = {"inputs": [], "outputs": []}
    for kind, body in _BLOCK_RE.findall(text):
        entry: Dict[str, object] = {}
        for key, val in _KV_RE.findall(body):
            val = val.strip()
            if val.startswith("["):
                dims = [int(x.strip()) for x in val.strip("[]").split(",") if x.strip()]
                entry[key] = dims
            elif val.startswith('"'):
                entry[key] = val.strip('"')
            else:
                entry[key] = val
        bucket = "inputs" if kind == "input" else "outputs"
        blocks[bucket].append(entry)
    return blocks


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def contract() -> Dict[str, Dict[str, List[dict]]]:
    return _parse_contract(CONTRACT_DOC)


def _all_contract_entries(contract: Dict) -> List[Tuple[str, str, dict]]:
    out: List[Tuple[str, str, dict]] = []
    for model, buckets in contract.items():
        for kind in ("inputs", "outputs"):
            for entry in buckets[kind]:
                out.append((model, kind, entry))
    return out


def test_contract_doc_parses(contract: Dict) -> None:
    assert contract, "Failed to parse any stages from triton-stages.md"
    # The MVP cascade has 5 inference stages (research §C):
    # STU-Net parenchyma, STU-Net lesions, Pictorial Couinaud, LiLNet, VISTA3D, MedSAM-2
    assert len(contract) >= 4, f"Expected ≥4 Triton models, found {len(contract)}"


def test_every_contract_model_has_pbtxt(contract: Dict) -> None:
    """Every model declared in the contract must have a Triton ``config.pbtxt``.

    Skips cleanly when the triton-models directory has not been populated yet
    — this is a TDD scaffold; populated during /implement.
    """

    if not TRITON_MODELS_ROOT.exists():
        pytest.skip(f"Triton model repo not provisioned: {TRITON_MODELS_ROOT}")

    missing = []
    for model in contract:
        pbtxt = TRITON_MODELS_ROOT / model / "config.pbtxt"
        if not pbtxt.exists():
            missing.append(model)
    assert not missing, f"Missing config.pbtxt for models: {missing}"


@pytest.mark.parametrize(
    "model,kind,entry",
    _all_contract_entries(_parse_contract(CONTRACT_DOC)) if CONTRACT_DOC.exists() else [],
    ids=lambda x: f"{x[0]}-{x[1]}-{x[2].get('name', '?')}" if isinstance(x, tuple) else str(x),
)
def test_tensor_matches_contract(model: str, kind: str, entry: dict) -> None:
    pbtxt = TRITON_MODELS_ROOT / model / "config.pbtxt"
    if not pbtxt.exists():
        pytest.skip(f"config.pbtxt missing for {model}")

    blocks = _parse_pbtxt(pbtxt)
    actual = next(
        (b for b in blocks[kind] if b.get("name") == entry["name"]),
        None,
    )
    assert actual is not None, (
        f"Tensor `{entry['name']}` missing from {kind} block in {pbtxt}"
    )

    if entry["dtype"] is not None:
        assert actual.get("data_type") == entry["dtype"], (
            f"{model}/{entry['name']}: dtype mismatch — "
            f"contract={entry['dtype']} pbtxt={actual.get('data_type')}"
        )

    if entry["shape"] is not None:
        actual_dims = actual.get("dims", [])
        # Contract may include leading batch dim `[1, ...]`; Triton config dims
        # elide the batch dim when max_batch_size > 0. Compare non-batch axes.
        contract_axes = entry["shape"][1:] if entry["shape"][0] == 1 else entry["shape"]
        if len(contract_axes) != len(actual_dims):
            # Permit rank match when batch dim is explicit in pbtxt
            if len(entry["shape"]) != len(actual_dims):
                pytest.fail(
                    f"{model}/{entry['name']}: rank mismatch — "
                    f"contract={entry['shape']} pbtxt dims={actual_dims}"
                )
            contract_axes = entry["shape"]

        for idx, (expected, actual_dim) in enumerate(zip(contract_axes, actual_dims)):
            if expected == -1:
                continue  # symbolic dim — any int accepted
            assert expected == actual_dim, (
                f"{model}/{entry['name']}: axis {idx} mismatch — "
                f"contract={expected} pbtxt={actual_dim}"
            )
