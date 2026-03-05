from scripts.shared.finding_id import (
    can_normalize_finding_id,
    format_finding_id,
    normalize_finding_id,
    parse_finding_id_number,
)


def test_normalize_finding_id() -> None:
    assert normalize_finding_id("sec-1") == "SEC001"
    assert normalize_finding_id("TQ7") == "TQ007"
    assert normalize_finding_id("bad") == "BAD"


def test_can_normalize_finding_id() -> None:
    assert can_normalize_finding_id("SEC-12")
    assert can_normalize_finding_id("SEC12")
    assert not can_normalize_finding_id("sec")


def test_format_and_parse_finding_id() -> None:
    assert format_finding_id("sec", 3) == "SEC003"
    assert parse_finding_id_number("SEC003", "sec") == 3
