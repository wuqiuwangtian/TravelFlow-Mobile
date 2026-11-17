"""Independent stdlib encoder, not the desktop backend or a command validator.

Intent vectors supply an explicit validated_intent projection; Node checks that
projection against its bounded decoder. Primitive vectors use strict raw JSON.
"""
import hashlib
import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path

PROFILE = "p1-host-intent-c14n-1"
MAX_SAFE = 9007199254740991
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("p1_raw_reference", Path(__file__).with_name("check-p1-json.py"))
raw_reference = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = raw_reference
spec.loader.exec_module(raw_reference)
CandidateError = raw_reference.CandidateError


def exact_integer(token):
    if len(token) > 64:
        raise CandidateError("resource_number")
    mantissa, _, exponent = token.lower().partition("e")
    if not any(char in "123456789" for char in mantissa):
        return 0
    # Reject giant nonzero scales before constructing Decimal or int(value).
    if abs(int(exponent or "0")) > 1000:
        raise CandidateError("integer_range")
    value = Decimal(token)
    if not -MAX_SAFE <= value <= MAX_SAFE or value != value.to_integral_value():
        raise CandidateError("integer_range")
    return int(value)


def fixture_value(tree):
    kind = tree[0]
    if kind == "object":
        return {key: fixture_value(child) for key, child in tree[1]}
    if kind == "array":
        return [fixture_value(child) for child in tree[1]]
    if kind == "number":
        return exact_integer(tree[1])
    if kind == "null":
        return None
    return tree[1]


def quote(value):
    raw_reference.scalar_string(value)
    # Explicit escapes rather than relying on a whole-object default encoder.
    escapes = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r'}
    return '"' + ''.join(escapes.get(char, f"\\u{ord(char):04x}" if ord(char) < 32 else char) for char in value) + '"'


def canonical(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return quote(value)
    if isinstance(value, int) and abs(value) <= MAX_SAFE:
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(child) for child in value) + "]"
    if isinstance(value, dict):
        # UTF-16BE code units deliberately differ from Python code point order
        # when a supplementary character is compared with a high BMP character.
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", errors="strict"))
        return "{" + ",".join(quote(key) + ":" + canonical(value[key]) for key in keys) + "}"
    raise CandidateError("canonical_integer")


def artifact(document):
    text = canonical(document)
    encoded = text.encode("utf-8", errors="strict")
    if len(encoded) > 65536:
        raise CandidateError("canonical_bytes")
    return {"accepted": True, "canonical_profile": PROFILE, "channel": document["channel"], "canonical_json": text,
            "canonical_utf8_hex": encoded.hex(), "sha256": hashlib.sha256(encoded).hexdigest()}


def evaluate(entry):
    try:
        if entry["scope"] == "intent":
            # Deliberately not a second copy of all command/business validators.
            return artifact({"canonical_profile": PROFILE, "channel": entry["channel"], "intent": entry["validated_intent"]})
        raw = entry["raw_json"].encode("utf-8") if "raw_json" in entry else bytes.fromhex(entry["raw_utf8_hex"])
        if len(raw) > 32768:
            raise CandidateError("resource_bytes")
        return artifact({"canonical_profile": PROFILE, "channel": "integer-json-fixture", "value": fixture_value(raw_reference.decode(raw))})
    except CandidateError as error:
        return {"accepted": False, "error": str(error)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/check-p1-canonical.py candidate.json")
    corpus = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps({"results": {entry["id"]: evaluate(entry) for entry in corpus["cases"]}, "python": sys.version.split()[0],
                      "stdlib_only": True, "full_command_validation_reimplemented": False}, ensure_ascii=True))
