// Isolated host encoding candidate. No receipt writes, auth or shared version.
import { createHash } from "node:crypto";
import { controlIntent, queryIntent } from "../p1-boundary/commands.mjs";
import { BoundaryError, require, parseInput, exactInteger } from "../p1-boundary/input.mjs";

export const CANONICAL_PROFILE = Object.freeze({
  id: "p1-host-intent-c14n-1", status: "host-candidate-not-shared-contract", digest: "sha256",
  key_order: "utf16-code-units", number_domain: "safe-integer-only", output_bytes: 65536,
  string_normalization: "none", array_order: "preserved", shared_contract_version: null,
});

// Private serializer: callers below only supply validated intents or values
// constructed from the strict diagnostic tree, never arbitrary JS objects.
function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    require(Number.isSafeInteger(value), "canonical_integer");
    return String(value); // Safe integers are below the exponent-output threshold.
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function artifact(document) {
  const canonical_json = canonical(document), bytes = Buffer.from(canonical_json, "utf8");
  require(bytes.byteLength <= CANONICAL_PROFILE.output_bytes, "canonical_bytes");
  return { accepted: true, canonical_profile: CANONICAL_PROFILE.id, channel: document.channel,
    canonical_json, canonical_utf8_hex: bytes.toString("hex"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function fingerprintIntent(bytes, channel = "control") {
  require(["control", "receipt-query"].includes(channel), "canonical_channel");
  // Schema/field validation happens before encoding. Current state, clocks,
  // permissions and derived booking endpoints are not part of this document.
  const intent = channel === "control" ? controlIntent(bytes) : queryIntent(bytes);
  return artifact({ canonical_profile: CANONICAL_PROFILE.id, channel, intent });
}

function fixtureValue(tree) {
  switch (tree[0]) {
    case "object": return Object.fromEntries(tree[1].map(([key, child]) => [key, fixtureValue(child)]));
    case "array": return tree[1].map(fixtureValue);
    case "number": {
      const token = tree[1], negative = token.startsWith("-");
      const absolute = exactInteger(["number", negative ? token.slice(1) : token], 0, Number.MAX_SAFE_INTEGER);
      return absolute === 0 ? 0 : negative ? -absolute : absolute;
    }
    case "null": return null;
    case "string": case "boolean": return tree[1];
    default: throw new Error("Unexpected strict diagnostic node");
  }
}

// Primitive serialization vectors only. This is not an application command,
// snapshot/coordinate codec or a general JCS implementation.
export function fingerprintFixtureValue(bytes) {
  return artifact({ canonical_profile: CANONICAL_PROFILE.id, channel: "integer-json-fixture",
    value: fixtureValue(parseInput(bytes, "control")) });
}

export function evaluate(entry) {
  const bytes = typeof entry.raw_json === "string" ? Buffer.from(entry.raw_json, "utf8") : Buffer.from(entry.raw_utf8_hex, "hex");
  try {
    return entry.scope === "intent" ? fingerprintIntent(bytes, entry.channel) : fingerprintFixtureValue(bytes);
  } catch (error) {
    if (error instanceof BoundaryError) return { accepted: false, error: error.code };
    throw error;
  }
}
