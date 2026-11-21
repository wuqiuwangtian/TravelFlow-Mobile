// Reads the four history tables of a marked, synthetic desktop SQLite file.
// The caller owns the read-only connection and selects the source head explicitly.
import { createScanner, SyntaxKind } from "jsonc-parser";
import { decode } from "../p1-json/decode.mjs";
import { require } from "../p1-boundary/input.mjs";
import { emptyFixtureState, LEGACY_LIMITS } from "./legacy.mjs";

export const FIXTURE_APPLICATION_ID = 0x54534631;
const sourceByteLimit = 1 << 20;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Read TEXT as bytes: identifiers, audit strings and plan JSON may contain NUL.
// Only the selected source columns are part of this fixture adapter.
const schema = {
  sessions: ["id", "title", "created_at", "updated_at", "archived", "initial_preferences"],
  branches: ["id", "session_id", "title", "parent_branch_id", "fork_version_id", "is_primary", "created_at"],
  versions: ["id", "branch_id", "seq", "summary", "detail_level", "trigger", "checkpoint_id", "created_at"],
  plans: ["version_id", "markdown", "citations", "todos", "searched_at", "itinerary", "requirements"],
};
const integerColumns = new Set(["seq", "is_primary", "archived"]);
function rows(db, table, condition, keys, budget) {
  const columns = schema[table].map(key => {
    if (integerColumns.has(key)) return key;
    // Keep SQL NULL distinct from zero-length TEXT and cap each value before transfer.
    return `CASE WHEN ${key} IS NULL THEN NULL WHEN typeof(${key}) != 'text' THEN -2
      WHEN length(CAST(${key} AS BLOB)) > ${sourceByteLimit} THEN -1 ELSE CAST(${key} AS BLOB) END AS ${key}`;
  });
  const result = [];
  const statement = db.prepare(`SELECT ${columns.join(",")} FROM ${table} WHERE ${condition} LIMIT 65`);
  for (const row of statement.iterate(...keys)) {
    require(result.length < LEGACY_LIMITS.versions, "source_versions");
    for (const key of schema[table]) {
      const value = row[key];
      if (value === null) continue;
      if (integerColumns.has(key)) {
        require(Number.isSafeInteger(value), "source_integer");
      } else {
        require(value !== -1, "source_budget");
        require(value instanceof Uint8Array, "source_text");
        budget.bytes += value.byteLength;
        require(budget.bytes <= sourceByteLimit, "source_budget");
        row[key] = utf8.decode(value);
      }
    }
    result.push({ ...row });
  }
  return result;
}

function itineraryTree(raw) {
  require(typeof raw === "string", "source_itinerary_missing");
  const scanner = createScanner(raw, true);
  let depth = 0, tokens = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    require(++tokens <= LEGACY_LIMITS.nodes, "source_budget");
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken)
      require(++depth <= LEGACY_LIMITS.depth, "source_budget");
    if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) depth--;
  }
  return decode(Buffer.from(raw, "utf8"));
}
function fields(tree) {
  require(tree?.[0] === "object", "source_shape");
  return new Map(tree[1]);
}
function array(tree) {
  require(tree?.[0] === "array", "source_collection");
  return tree[1];
}
function integer(tree) {
  require(tree?.[0] === "number" && /^-?(0|[1-9][0-9]*)$/.test(tree[1]), "source_integer");
  const value = Number(tree[1]);
  require(Number.isSafeInteger(value) && !Object.is(value, -0), "source_integer");
  return value;
}
const strings = new Set(["id", "title", "category", "activity_id", "budget_item_id", "notes", "currency", "paid_on",
  "created_at", "updated_at", "expense_id", "kind", "status", "progress", "progress_updated_at", "start_time", "source"]);
const integers = new Set(["amount_cents", "day", "start_day_offset", "duration_minutes", "planned_cents"]);
const nullable = new Set(["day", "paid_on", "currency", "activity_id", "budget_item_id", "start_time", "duration_minutes", "booking", "progress_updated_at", "planned_cents"]);
const expense = ["id", "title", "category", "amount_cents", "day", "activity_id", "budget_item_id", "settles_budget",
  "notes", "currency", "paid_on", "receipt_ids", "created_at", "updated_at"];
const adjustment = ["id", "expense_id", "kind", "status", "amount_cents", "currency", "notes", "created_at", "updated_at"];
const activity = ["id", "title", "progress", "progress_updated_at", "is_context_anchor", "is_planning_origin",
  "time_is_suggested", "start_time", "start_day_offset", "duration_minutes", "booking"];
const booking = ["start_time", "start_day_offset", "duration_minutes", "notes"];
function project(tree, keys) {
  const input = fields(tree), result = {};
  for (const key of keys) {
    if (!input.has(key)) continue;
    const value = input.get(key);
    if (value[0] === "null" && nullable.has(key)) result[key] = null;
    else if (integers.has(key)) result[key] = integer(value);
    else if (key === "booking") {
      // An enriched booking must never silently fall back to legacy clock mode.
      require([...fields(value).keys()].every(name => booking.includes(name)), "source_booking_format");
      result[key] = project(value, booking);
    } else if (key === "receipt_ids") result[key] = array(value).map(item => {
      require(item[0] === "string", "source_shape");
      return item[1];
    });
    else {
      require(value[0] === (strings.has(key) ? "string" : "boolean"), "source_shape");
      result[key] = value[1];
    }
  }
  return result;
}

function projectItinerary(raw) {
  const doc = fields(itineraryTree(raw)), state = emptyFixtureState();
  state.expenses = array(doc.get("expenses")).map(row => project(row, expense));
  state.adjustments = array(doc.get("adjustments")).map(row => project(row, adjustment));
  state.links.budget_rows = array(doc.get("budget_items")).map(row => project(row, ["id", "title", "category", "planned_cents", "day", "activity_id", "source"]));
  for (const dayTree of array(doc.get("days"))) {
    const dayRow = fields(dayTree), day = integer(dayRow.get("day"));
    require(day >= 1 && day <= 60 && !state.links.days.includes(day), "source_day");
    state.links.days.push(day);
    for (const item of array(dayRow.get("activities"))) {
      const row = fields(item);
      require(!row.has("day") || integer(row.get("day")) === day, "source_day");
      state.activities.push({ ...project(item, activity), day });
    }
  }
  return state;
}

export function desktopFixtureManifest(db, { dataset, travel, branch, head }) {
  require([dataset, travel, branch, head].every(id => typeof id === "string" && id.length > 0), "source_scope");
  require(db.prepare("PRAGMA application_id").get().application_id === FIXTURE_APPLICATION_ID, "source_fixture_only");
  require(db.prepare("PRAGMA encoding").get().encoding === "UTF-8", "source_encoding");
  db.exec("BEGIN");
  try {
    const budget = { bytes: 0 };
    const [session] = rows(db, "sessions", "id=?", [travel], budget);
    const [branchRow] = rows(db, "branches", "id=? AND session_id=?", [branch, travel], budget);
    require(session && branchRow, "source_scope");
    const versions = rows(db, "versions", "branch_id=? ORDER BY id", [branch], budget);
    require(versions.some(version => version.id === head), "source_head");
    const manifest = {
      fixture_format_version: 1, source_system: "TravelFlow-AI-fixture", source_dataset_id: dataset,
      source_travel_id: travel, source_branch_id: branch, head_source_version_id: head,
      provenance: { adapter: "desktop-sqlite-fixture-1", session, branch: branchRow },
      versions: versions.map(version => {
        const [plan] = rows(db, "plans", "version_id=?", [version.id], budget);
        require(plan, "source_plan_missing");
        return { source_version_id: version.id, desktop_version: version, desktop_plan: plan, state: projectItinerary(plan.itinerary) };
      }),
    };
    db.exec("COMMIT");
    return manifest;
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }
}
