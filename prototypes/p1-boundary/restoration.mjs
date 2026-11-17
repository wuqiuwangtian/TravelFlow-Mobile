// Host-only explicit restoration candidate. Historical facts are not new input
// defaults, and every restored association is checked against current state.
import { require, fields, identifier, string, exactInteger } from "./input.mjs";
import { checkPatchFields, evaluate as expensePlan } from "../p1-patch/expense.mjs";
import { entityType, familyPlan } from "./families.mjs";

export const RESTORE_COMMANDS = Object.freeze(["expense.restore", "adjustment.restore"]);
export function checkRestoreScope(intent) {
  if (!RESTORE_COMMANDS.includes(intent.kind)) return;
  const source = intent.payload.source;
  require(source.dataset_id === intent.operation.dataset_id && source.travel_id === intent.target.travel_id
    && source.branch_id === intent.target.branch_id, "restore_source_scope");
}
const EXPENSE_LINKS = ["day", "activity_id", "budget_item_id", "settles_budget", "receipt_ids"];
export function restorePayload(tree, kind) {
  const expense = kind === "expense.restore";
  const object = fields(tree, expense ? ["source", "allow_shared_receipts"] : ["source"], ["link_overrides"]);
  const result = { source: Object.fromEntries([...fields(object.get("source"), ["dataset_id", "travel_id", "branch_id", "revision_id"])]
    .map(([key, value]) => [key, identifier(value)])) };
  if (expense) {
    const control = object.get("allow_shared_receipts"); require(control[0] === "boolean", "type");
    result.allow_shared_receipts = control[1];
  }
  if (object.has("link_overrides")) {
    const links = fields(object.get("link_overrides"), [], expense ? EXPENSE_LINKS : ["expense_id"]);
    result.link_overrides = Object.fromEntries([...links].map(([key, value]) => {
      if (key === "day") return [key, value[0] === "null" ? null : exactInteger(value, 1, 60)];
      if (key === "settles_budget") { require(value[0] === "boolean", "type"); return [key, value[1]]; }
      if (key === "receipt_ids") { require(value[0] === "array", "type"); return [key, value[1].map(string)]; }
      if (value[0] === "null" && key !== "expense_id") return [key, null];
      return [key, identifier(value)];
    }));
    if (expense) {
      const checked = checkPatchFields({ ...result.link_overrides, allow_shared_receipts: result.allow_shared_receipts });
      require(checked.accepted, checked.error);
    }
  }
  return result;
}

export function restorePlan(intent, snapshot) {
  checkRestoreScope(intent);
  const type = entityType(intent.kind), before = snapshot.restore_source;
  require(snapshot[type] === null, "entity_exists");
  require(snapshot.tombstone?.active === 1, "restore_not_deleted");
  require(before && before.id === intent.target.entity_id, "restore_source_missing");
  require(Number.isSafeInteger(before.amount_cents) && before.amount_cents >= 1 && before.amount_cents <= 9999999999, "history_amount_unsupported");
  require((before.currency ?? null) === null || before.currency === "CNY", "history_currency_unsupported");
  const links = intent.payload.link_overrides ?? {};
  let planned;
  if (type === "expense") {
    require(snapshot.expense_count < 2000, "expense_count");
    // All historical references are newly live references. An empty baseline
    // prevents the patch helper from skipping availability/sharing checks.
    const receipts = Object.hasOwn(links, "receipt_ids") ? links.receipt_ids : before.receipt_ids;
    const checked = expensePlan({ input: { base: { ...before, receipt_ids: [] },
      patch: { ...links, receipt_ids: receipts, allow_shared_receipts: intent.payload.allow_shared_receipts }, context: snapshot.links } });
    require(checked.accepted, checked.error); planned = checked.value;
  } else {
    require(snapshot.adjustment_count < 4000, "adjustment_count");
    require(["refund", "reimbursement"].includes(before.kind) && ["pending", "received"].includes(before.status), "history_adjustment_unsupported");
    const expense = snapshot.links.expenses.find(row => row.id === (links.expense_id ?? before.expense_id));
    require(before.currency !== "CNY" || expense?.currency === "CNY", "currency_link");
    planned = familyPlan({ ...intent, kind: "adjustment.patch", payload: links }, { ...snapshot, adjustment: before });
  }
  return { ...planned, candidate: structuredClone(planned.candidate), entity_type: type, action: "restore",
    restore_source_revision: intent.payload.source.revision_id, planned_business_revision: "new" };
}
