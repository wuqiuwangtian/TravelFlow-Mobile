// Decoded synthetic adapter input only, not a desktop-file import API.
import { require, identifier } from "../p1-boundary/input.mjs";

export const LEGACY_LIMITS = Object.freeze({ versions: 64, depth: 32, nodes: 100000, bytes: 1048576 });
const own = (object, key) => Object.hasOwn(object, key);
export function emptyFixtureState() {
  return { expenses: [], adjustments: [], activities: [], links: { days: [], budget_rows: [], available_receipt_ids: [],
    other_receipt_ids: [], adjustments: [], actual_activity_ids: [] } };
}
export function legacyKey(value) {
  require(typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)), "legacy_id");
  if (typeof value === "string") identifier(["string", value]);
  // String "1" and number 1 remain distinct, without rewriting opaque IDs.
  return JSON.stringify([typeof value, value]);
}

function boundedJSON(value) {
  let nodes = 0, weight = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    require(depth <= LEGACY_LIMITS.depth && ++nodes <= LEGACY_LIMITS.nodes, "legacy_budget");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      weight += item.length; require(weight <= LEGACY_LIMITS.bytes, "legacy_budget");
      require(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item), "unicode");
      return;
    }
    if (typeof item === "number") {
      require(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)) && !Object.is(item, -0), "legacy_number"); return;
    }
    require(typeof item === "object" && !ancestors.has(item), "legacy_json");
    require(Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)), "legacy_json");
    require(Object.getOwnPropertySymbols(item).length === 0, "legacy_json");
    ancestors.add(item);
    if (Array.isArray(item)) {
      require(Object.getPrototypeOf(item) === Array.prototype, "legacy_json");
      require(item.length <= LEGACY_LIMITS.nodes, "legacy_budget");
      require(Object.getOwnPropertyNames(item).length === item.length + 1, "legacy_json");
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        require(descriptor && own(descriptor, "value"), "legacy_json"); visit(descriptor.value, depth + 1);
      }
    } else {
      for (const key of Object.getOwnPropertyNames(item)) {
        visit(key, depth + 1);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        require(descriptor.enumerable && own(descriptor, "value"), "legacy_json"); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 1);
  const encoded = JSON.stringify(value);
  require(Buffer.byteLength(encoded) <= LEGACY_LIMITS.bytes, "legacy_budget");
  return JSON.parse(encoded);
}

function validateState(state) {
  require(state && typeof state === "object" && !Array.isArray(state), "legacy_state");
  for (const [collection, limit] of [["expenses", 2000], ["adjustments", 4000], ["activities", 10000]]) {
    const rows = state[collection];
    require(Array.isArray(rows) && rows.length <= limit, "legacy_state");
    const ids = new Set();
    for (const row of rows) {
      require(row && typeof row === "object" && !Array.isArray(row), "legacy_state");
      require(typeof row.id === "string", "legacy_id");
      identifier(["string", row.id]); require(!ids.has(row.id), "legacy_duplicate_entity"); ids.add(row.id);
      if (collection !== "activities") require(Number.isSafeInteger(row.amount_cents), "legacy_money");
    }
  }
  require(state.links && ["days", "budget_rows", "available_receipt_ids"].every(key => Array.isArray(state.links[key])), "legacy_state");
}

export function legacyManifest(input) {
  const manifest = boundedJSON(input);
  require(manifest && manifest.fixture_format_version === 1 && manifest.source_system === "TravelFlow-AI-fixture", "legacy_format");
  const sourceKeys = ["source_dataset_id", "source_travel_id", "source_branch_id"];
  sourceKeys.forEach(key => legacyKey(manifest[key]));
  require(Array.isArray(manifest.versions) && manifest.versions.length > 0 && manifest.versions.length <= LEGACY_LIMITS.versions, "legacy_versions");
  const records = new Map();
  for (const version of manifest.versions) {
    require(version && typeof version === "object" && !Array.isArray(version), "legacy_version");
    const key = legacyKey(version.source_version_id);
    require(!records.has(key), "legacy_duplicate_version");
    if (own(version, "parent_source_version_id") && version.parent_source_version_id !== null) legacyKey(version.parent_source_version_id);
    validateState(version.state); records.set(key, version);
  }
  const head = legacyKey(manifest.head_source_version_id); require(records.has(head), "legacy_head");
  const identity = JSON.stringify([manifest.source_system, ...sourceKeys.map(key => legacyKey(manifest[key]))]);
  // Only explicit links establish ancestry. Missing and unavailable parents
  // remain different provenance states; array order and timestamps do not.
  const ordered = [], visiting = new Set(), visited = new Set();
  function visit(key) {
    require(!visiting.has(key), "legacy_cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    const version = records.get(key);
    const parent = own(version, "parent_source_version_id") && version.parent_source_version_id !== null ? legacyKey(version.parent_source_version_id) : null;
    if (parent !== null && records.has(parent)) visit(parent);
    visiting.delete(key); visited.add(key);
    ordered.push({ key, version, parent_key: parent,
      lineage: !own(version, "parent_source_version_id") ? "unknown" : parent === null ? "root" : records.has(parent) ? "linked" : "unresolved" });
  }
  for (const key of records.keys()) visit(key);
  const header = { ...manifest }; delete header.versions;
  return { identity, head, header, ordered };
}
