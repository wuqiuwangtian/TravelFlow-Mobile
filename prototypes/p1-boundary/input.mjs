// Host candidate only. Scanner budgets run before the recursive JSON parser.
import { createScanner, SyntaxKind } from "jsonc-parser";
import { decode } from "../p1-json/decode.mjs";
import profile from "./profile.json" with { type: "json" };

export const PROFILE = Object.freeze(profile);
export class BoundaryError extends Error { constructor(code) { super(code); this.code = code; } }
export const require = (condition, code) => { if (!condition) throw new BoundaryError(code); };

export function parseInput(bytes, channel) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("UTF-8 byte input required");
  require(channel === "control" || channel === "query", "channel");
  require(bytes.byteLength <= PROFILE[`${channel}_bytes`], "resource_bytes");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new BoundaryError("encoding"); }
  const scanner = createScanner(text, false);
  let depth = 0, tokens = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.Trivia || token === SyntaxKind.LineBreakTrivia) continue;
    require(++tokens <= PROFILE.tokens, "resource_tokens");
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      require(++depth <= PROFILE.depth, "resource_depth");
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) depth = Math.max(0, depth - 1);
    if (token === SyntaxKind.NumericLiteral) require(scanner.getTokenLength() <= PROFILE.number_characters, "resource_number");
    if (token === SyntaxKind.StringLiteral) {
      let count = 0;
      for (const _ of scanner.getTokenValue()) require(++count <= PROFILE.string_scalars, "resource_string");
    }
  }
  // Grammar, decoded duplicate keys and Unicode reuse the accepted candidate.
  // Budget errors can precede grammar errors; malformed input is never repaired.
  try { return decode(bytes); }
  catch (error) {
    if (["encoding", "json", "unicode", "duplicate_key"].includes(error.code)) throw new BoundaryError(error.code);
    throw error;
  }
}

export function fields(tree, required, optional = []) {
  require(tree?.[0] === "object", "shape");
  const result = new Map(tree[1]);
  require(required.every(key => result.has(key)) && [...result.keys()].every(key => required.includes(key) || optional.includes(key)), "shape");
  return result;
}

export function string(tree) { require(tree?.[0] === "string", "type"); return tree[1]; }
export function identifier(tree) {
  const value = string(tree);
  require(value.length > 0 && Array.from(value).length <= PROFILE.key_scalars
    && new TextEncoder().encode(value).byteLength <= PROFILE.key_bytes, "identity");
  return value; // Opaque, exact spelling; no trim/NFC or UUID rewrite.
}

export function exactInteger(tree, low, high) {
  require(tree?.[0] === "number", "type");
  const token = tree[1];
  require(token.length <= PROFILE.number_characters, "resource_number");
  const negative = token.startsWith("-");
  const [mantissa, exponent = "0"] = (negative ? token.slice(1) : token).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const coefficient = (whole + fraction).replace(/^0+/, "");
  if (!coefficient) { require(low <= 0 && high >= 0, "integer_range"); return 0; }
  const digits = coefficient.replace(/0+$/, "");
  // The exponent is at most 64 source characters. Only bounded-size BigInts
  // are made here, never a ratio/power proportional to the exponent's value.
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(coefficient.length - digits.length);
  const width = BigInt(String(high).length);
  require(!negative && scale >= 0n && BigInt(digits.length) + scale <= width, "integer_range");
  const value = BigInt(digits) * 10n ** scale; // scale <= width-1 (at most 9 here).
  require(value >= BigInt(low) && value <= BigInt(high), "integer_range");
  return Number(value);
}
