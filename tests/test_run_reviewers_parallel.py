import json
from pathlib import Path

import pytest

from scripts.run_reviewers_parallel import load_output_schema


def test_load_output_schema_accepts_object_json(tmp_path: Path) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps({"type": "object"}), encoding="utf-8")

    loaded = load_output_schema(str(schema_path))

    assert loaded["type"] == "object"


def test_load_output_schema_rejects_non_object_json(tmp_path: Path) -> None:
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")

    with pytest.raises(ValueError, match="root must be an object"):
        load_output_schema(str(schema_path))
