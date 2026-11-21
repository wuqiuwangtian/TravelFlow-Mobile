import { zoneCapability } from "../p1-zones/catalogue.mjs";
import { isDeepStrictEqual } from "node:util";
import { PROFILE, BoundaryError, require, parseInput, fields, string, identifier, exactInteger } from "./input.mjs";
import { evaluate as patchPlan, checkPatchFields } from "../p1-patch/expense.mjs";
import { BoundedScheduler } from "./scheduler.mjs";
import { FAMILY_FIELDS, familyPayload, familyPlan, HOST_RESOLUTION, CANDIDATE_ZONE_IDS } from "./families.mjs";
import { RESTORE_COMMANDS, restorePayload, restorePlan, checkRestoreScope } from "./restoration.mjs";

const PAYLOAD = ["title", "amount_cents", "currency", "paid_on", "category", "day", "activity_id", "notes", "receipt_ids", "allow_shared_receipts", "budget_item_id", "settles_budget"];
const receiptKey = operation => [operation.dataset_id, operation.source_device_id, operation.operation_id];
const checkAbort = signal => require(!signal?.aborted, "cancelled");
const HOST_SCHEDULER = new BoundedScheduler();
function immutable(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}

function operation(tree) {
  const object = fields(tree, ["dataset_id", "source_device_id", "operation_id"]);
  return Object.fromEntries([...object].map(([key, value]) => [key, identifier(value)]));
}

function payload(tree, create) {
  const object = fields(tree, create ? PAYLOAD : [], create ? [] : PAYLOAD);
  const result = {};
  for (const [key, value] of object) {
    if (key === "amount_cents") result[key] = exactInteger(value, 1, 9999999999);
    else if (key === "day") result[key] = value[0] === "null" ? null : exactInteger(value, 1, 60);
    else if (["allow_shared_receipts", "settles_budget"].includes(key)) {
      require(value[0] === "boolean", "type"); result[key] = value[1];
    } else if (key === "receipt_ids") {
      require(value[0] === "array", "type"); result[key] = value[1].map(string);
    } else if (["currency", "paid_on", "activity_id", "budget_item_id"].includes(key) && value[0] === "null") result[key] = null;
    else result[key] = string(value);
  }
  const checked = checkPatchFields(result);
  require(checked.accepted, checked.error);
  if (create) require(result.currency === "CNY", "currency");
  return result;
}

export function controlIntent(bytes) {
  const object = fields(parseInput(bytes, "control"), ["profile", "kind", "operation", "target", "expected_revision_id", "payload"]);
  require(string(object.get("profile")) === PROFILE.control_profile, "unsupported_profile");
  const kind = string(object.get("kind"));
  require(["expense.create", "expense.patch", ...RESTORE_COMMANDS].includes(kind) || Object.hasOwn(FAMILY_FIELDS, kind), "unsupported_command");
  const target = fields(object.get("target"), ["travel_id", "branch_id", "entity_id"]);
  return immutable({ profile: PROFILE.control_profile, kind, operation: operation(object.get("operation")),
    target: Object.fromEntries([...target].map(([key, value]) => [key, identifier(value)])),
    expected_revision_id: identifier(object.get("expected_revision_id")), payload: kind === "expense.create" || kind === "expense.patch"
      ? payload(object.get("payload"), kind === "expense.create") : RESTORE_COMMANDS.includes(kind)
        ? restorePayload(object.get("payload"), kind) : familyPayload(object.get("payload"), kind) });
}

export function queryIntent(bytes) {
  const object = fields(parseInput(bytes, "query"), ["profile", "kind", "operation"]);
  require(string(object.get("profile")) === PROFILE.query_profile, "unsupported_profile");
  require(string(object.get("kind")) === "receipt.lookup", "unsupported_command");
  return immutable({ profile: PROFILE.query_profile, kind: "receipt.lookup", operation: operation(object.get("operation")) });
}

export function capabilities(bytes) {
  const object = fields(parseInput(bytes, "query"), ["profile", "kind"]);
  require(string(object.get("profile")) === PROFILE.query_profile, "unsupported_profile");
  require(string(object.get("kind")) === "capabilities.query", "unsupported_command");
  return { status: PROFILE.status, shared_contract_version: null,
    control_commands: ["expense.create", "expense.patch", ...Object.keys(FAMILY_FIELDS), ...RESTORE_COMMANDS], query_commands: ["receipt.lookup", "capabilities.query"],
    field_semantics: ["new-CNY", "legacy-unknown-currency-patch", "paid-on-omission-vs-null", "no-change-receipt-plan",
      "separate-refund-reimbursement", "elapsed-booking-resolution-basis", "legacy-booking-preserved", "no-op-progress-audit", "explicit-delete-tombstone-plan",
      "explicit-restore-current-constraints", "historical-facts-link-overrides-only"],
    iana_booking: zoneCapability(),
    resolution_provider: { ...HOST_RESOLUTION },
    zone_catalogue: { scope: "fixture-only", time_zone_ids: [...CANDIDATE_ZONE_IDS] },
    limits: { ...PROFILE }, durable_storage: false, authentication_provider: false, canonical_bytes: false };
}

export function planIntent(intent, snapshot) {
  require(snapshot.revision_id === intent.expected_revision_id, "baseline_conflict");
  if (RESTORE_COMMANDS.includes(intent.kind)) return restorePlan(intent, snapshot);
  if (intent.kind !== "expense.create" && intent.kind !== "expense.patch") return familyPlan(intent, snapshot);
  const create = intent.kind === "expense.create";
  require(create ? snapshot.expense === null : snapshot.expense !== null, create ? "entity_exists" : "entity_missing");
  if (!create) require(snapshot.expense.id === intent.target.entity_id, "target_mismatch");
  if (create) { require(!snapshot.deleted, "entity_deleted"); require(snapshot.expense_count < 2000, "expense_count"); }
  const base = create ? { id: intent.target.entity_id, title: "candidate seed", amount_cents: 1, currency: "CNY", paid_on: null,
    category: "other", day: null, activity_id: null, notes: "", receipt_ids: [], budget_item_id: null, settles_budget: false } : snapshot.expense;
  const planned = patchPlan({ input: { base, patch: intent.payload, context: snapshot.links } });
  require(planned.accepted, planned.error);
  if (create) planned.value.planned_business_revision = "new";
  return { ...planned.value, action: "upsert", entity_type: "expense" };
}

function receiptProjection(record) {
  require(record && ["changed", "no_change"].includes(record.effect) && typeof record.result_revision_id === "string"
    && record.result_revision_id.length > 0 && Array.from(record.result_revision_id).length <= PROFILE.key_scalars
    && Array.from(record.result_revision_id).every(character => character.codePointAt(0) < 0xd800 || character.codePointAt(0) > 0xdfff)
    && new TextEncoder().encode(record.result_revision_id).byteLength <= PROFILE.key_bytes, "receipt_unavailable");
  return { effect: record.effect, result_revision_id: record.result_revision_id };
}

async function attempt(work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof BoundaryError) return { accepted: false, error: error.code };
    throw error; // Unexpected bugs are not converted to successful/empty results.
  }
}

// Hooks below are trusted, read-only host adapters. Tests supply synthetic
// authority and memory reads; this is not a token verifier or durable store.
export class CandidateBoundary {
  constructor(scheduler = HOST_SCHEDULER) { this.scheduler = scheduler; }

  #identity(context, intent, mode) {
    require(context.principal?.authenticated === true, "denied");
    if (mode === "write") require(context.principal.source_device_id === intent.operation.source_device_id, "denied");
  }

  async #authorize(context, intent, mode, signal) {
    this.#identity(context, intent, mode);
    require(await context.authorize(intent.operation, intent.target ?? null, mode, signal) === true, "denied");
    checkAbort(signal);
  }

  control(bytes, context, signal) {
    return attempt(async () => {
      checkAbort(signal);
      const intent = controlIntent(bytes);
      this.#identity(context, intent, "write");
      const scope = JSON.stringify([intent.operation.dataset_id, intent.target.travel_id, intent.target.branch_id]);
      return this.scheduler.run(scope, async workerSignal => {
        await this.#authorize(context, intent, "write", workerSignal);
        const previous = await context.lookupReceipt(receiptKey(intent.operation), workerSignal);
        checkAbort(workerSignal);
        require(previous.state !== "unavailable", "receipt_unavailable");
        if (previous.state === "committed") {
          require(isDeepStrictEqual(previous.intent, intent), "intent_conflict");
          return { accepted: true, kind: "replay-view", receipt: receiptProjection(previous) };
        }
        require(previous.state === "missing" && previous.settled === true, "result_unknown");
        checkRestoreScope(intent);
        const snapshot = await context.inspect(intent.target, workerSignal, intent);
        checkAbort(workerSignal);
        return { accepted: true, kind: "uncommitted-plan", intent, value: planIntent(intent, snapshot) };
      }, signal);
    });
  }

  query(bytes, context, signal) {
    return attempt(async () => {
      checkAbort(signal);
      const intent = queryIntent(bytes);
      this.#identity(context, intent, "query");
      return this.scheduler.run(JSON.stringify(["receipt", ...receiptKey(intent.operation)]), async workerSignal => {
        await this.#authorize(context, intent, "query", workerSignal);
        const record = await context.lookupReceipt(receiptKey(intent.operation), workerSignal);
        checkAbort(workerSignal);
        if (record.state === "committed") return { accepted: true, state: "committed", receipt: receiptProjection(record) };
        if (record.state === "missing" && record.settled === true) return { accepted: true, state: "not_found_at_settled_read" };
        return { accepted: true, state: "unknown" };
      }, signal);
    });
  }
}
