import { isDeepStrictEqual } from "node:util";
import { require, BoundaryError, fields, string, identifier, exactInteger } from "./input.mjs";
import { checkPatchFields } from "../p1-patch/expense.mjs";
import { bookingZone, ZONE_CATALOGUE_ID } from "../p1-zones/catalogue.mjs";
import { elapsedBooking, resolveElapsedBooking, paymentDate, CandidateError } from "../p1-values/values.mjs";
import zoneRegistry from "../p1-values/time-zone-ids.json" with { type: "json" };

export const HOST_RESOLUTION = Object.freeze({ zone_catalogue_id: "p1-test-zones-1", tzdata_version: process.versions.tz ?? "unreported", provider: "node-intl", icu: process.versions.icu });
export const CANDIDATE_ZONE_IDS = Object.freeze([...zoneRegistry.time_zone_ids]);
export const FAMILY_FIELDS = Object.freeze({
  "expense.delete": [],
  "adjustment.create": ["expense_id", "kind", "amount_cents", "currency", "status", "notes"],
  "adjustment.patch": ["expense_id", "kind", "amount_cents", "currency", "status", "notes"],
  "adjustment.delete": [],
  "booking.set": ["start_time", "start_day_offset", "duration_minutes", "notes", "local_start", "time_zone", "utc_offset", "start_instant", "duration_semantics", "resolution_basis"],
  "booking.clear": [],
  "booking.notes.patch": ["notes"],
  "booking.legacy.patch": ["start_time", "start_day_offset", "duration_minutes", "notes"],
  "progress.set": ["progress"],
});
const optional = new Set(["adjustment.patch", "booking.legacy.patch"]);
const clock = value => typeof value === "string" && value.length === 5 && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
function candidate(work) {
  try { return work(); } catch (error) { if (error instanceof CandidateError) throw new BoundaryError(error.code); throw error; }
}
function notes(value, limit) { const checked = checkPatchFields({ notes: value }); require(checked.accepted, checked.error); require(Array.from(value).length <= limit, "text_length"); }
export function familyPayload(tree, kind) {
  const keys = FAMILY_FIELDS[kind];
  require(keys !== undefined, "unsupported_command");
  const object = fields(tree, optional.has(kind) ? [] : keys, optional.has(kind) ? keys : []), result = {};
  for (const [key, value] of object) {
    if (key === "amount_cents") result[key] = exactInteger(value, 1, 9999999999);
    else if (key === "start_day_offset") result[key] = exactInteger(value, 0, 60);
    else if (key === "duration_minutes") result[key] = exactInteger(value, 1, 1440);
    else if (key === "resolution_basis") {
      result[key] = Object.fromEntries([...fields(value, ["calendar_revision_id", "zone_catalogue_id", "tzdata_version"])].map(([k, v]) => [k, identifier(v)]));
    } else if (key === "currency" && value[0] === "null") result[key] = null;
    else result[key] = string(value);
  }
  if (kind.startsWith("adjustment.")) {
    if (Object.hasOwn(result, "expense_id")) identifier(["string", result.expense_id]);
    if (Object.hasOwn(result, "kind")) require(["refund", "reimbursement"].includes(result.kind), "adjustment_kind");
    if (Object.hasOwn(result, "status")) require(["pending", "received"].includes(result.status), "adjustment_status");
    if (Object.hasOwn(result, "currency")) require(result.currency === null || result.currency === "CNY", "currency");
    if (kind === "adjustment.create") require(result.currency === "CNY", "currency");
  }
  if (Object.hasOwn(result, "notes")) notes(result.notes, kind.startsWith("booking.") ? 500 : 1000);
  if (Object.hasOwn(result, "start_time")) require(clock(result.start_time), "clock");
  if (kind === "booking.set") {
    require(result.local_start.length === 16 && result.local_start[10] === "T" && clock(result.local_start.slice(11)), "date");
    candidate(() => paymentDate({ paid_on: result.local_start.slice(0, 10) }, "create"));
    require(result.utc_offset.length === 6 && /^[+-](?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(result.utc_offset) && result.utc_offset !== "-00:00", "offset");
    require(result.start_instant.length === 24 && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z$/.test(result.start_instant), "instant");
    require(result.duration_semantics === "elapsed", "duration_semantics"); identifier(["string", result.time_zone]);
  }
  if (kind === "progress.set") require(["not_started", "in_progress", "completed", "skipped"].includes(result.progress), "progress");
  return result;
}

export function entityType(kind) { return kind.startsWith("expense.") ? "expense" : kind.startsWith("adjustment.") ? "adjustment" : "activity"; }
function plan(type, before, after, action = "upsert") {
  return { entity_type: type, action, candidate: after, controls: {},
    planned_business_revision: isDeepStrictEqual(before, after) ? "unchanged" : "new",
    planned_operation_receipt: "required-not-persisted", cny_totals_eligible: after?.currency === "CNY" };
}

export function familyPlan(intent, snapshot) {
  const { kind, payload, target } = intent, type = entityType(kind), before = snapshot[type] ?? null;
  const create = kind.endsWith(".create");
  require(create ? before === null : before !== null, create ? "entity_exists" : "entity_missing");
  if (create) require(!snapshot.deleted, "entity_deleted");
  if (before) require(before.id === target.entity_id, "target_mismatch");
  if (kind === "expense.delete") {
    require(!snapshot.links.adjustments.some(row => row.expense_id === before.id), "recovery_exists");
    return plan(type, before, null, "delete");
  }
  if (kind === "adjustment.delete") return plan(type, before, null, "delete");
  if (kind.startsWith("adjustment.")) {
    if (create) require(snapshot.adjustment_count < 4000, "adjustment_count");
    const after = create ? { id: target.entity_id, ...payload } : { ...structuredClone(before), ...payload };
    const financial = create || ["amount_cents", "expense_id", "kind", "currency", "status"].some(key => Object.hasOwn(payload, key));
    if (financial) {
      require((after.currency ?? null) === null || after.currency === "CNY", "currency");
      if (before) require((before.currency ?? null) === null || before.currency === after.currency, "currency_conversion");
    }
    const expense = snapshot.links.expenses.find(row => row.id === after.expense_id);
    require(expense !== undefined, "expense_link");
    if (create || (before && before.expense_id !== after.expense_id) || (financial && after.currency === "CNY")) {
      require(after.currency === "CNY" && expense.currency === "CNY", "currency_link");
    }
    const claimed = snapshot.links.adjustments.filter(row => row.id !== target.entity_id && row.expense_id === after.expense_id && row.kind === after.kind)
      .reduce((sum, row) => sum + BigInt(row.amount_cents), BigInt(after.amount_cents));
    require(claimed <= BigInt(expense.amount_cents), "recovery_limit");
    return plan(type, before, after);
  }
  const after = structuredClone(before);
  if (kind === "progress.set") {
    require(!before.is_planning_origin || payload.progress === "not_started", "planning_origin");
    after.progress = payload.progress;
    return plan(type, before, after);
  }
  require(!before.is_context_anchor && before.progress === "not_started", "booking_protected");
  if (kind === "booking.clear") { after.booking = null; after.time_is_suggested = true; }
  else if (kind === "booking.notes.patch") {
    require(before.booking !== null && before.booking !== undefined, "booking_missing"); after.booking.notes = payload.notes;
  } else if (kind === "booking.legacy.patch") {
    require(before.booking && (!before.booking.mode || before.booking.mode === "legacy_wall_clock"), "booking_mode");
    Object.assign(after.booking, payload);
    Object.assign(after, { start_time: after.booking.start_time, start_day_offset: after.booking.start_day_offset, duration_minutes: after.booking.duration_minutes });
  } else if (kind === "booking.set") {
    const basis = payload.resolution_basis;
    let resolveBooking = elapsedBooking;
    if (basis.zone_catalogue_id === ZONE_CATALOGUE_ID) {
      const zone = bookingZone(payload.time_zone, basis);
      resolveBooking = value => resolveElapsedBooking(value, () => zone);
    } else {
      require(basis.zone_catalogue_id === HOST_RESOLUTION.zone_catalogue_id && basis.tzdata_version === HOST_RESOLUTION.tzdata_version, "resolution_basis");
    }
    require(snapshot.calendar !== null && snapshot.calendar !== undefined, "calendar_missing");
    require(basis.calendar_revision_id === snapshot.calendar.revision_id, "calendar_conflict");
    if (Object.hasOwn(snapshot.calendar, "day")) require(snapshot.calendar.day === before.day, "calendar_date");
    const date = new Date(`${snapshot.calendar.day_date}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + payload.start_day_offset);
    require(Number.isFinite(date.valueOf()) && date.toISOString().length === 24, "booking_range");
    require(payload.local_start === `${date.toISOString().slice(0, 10)}T${payload.start_time}`, "calendar_date");
    const resolved = candidate(() => resolveBooking(Object.fromEntries(["local_start", "time_zone", "utc_offset", "start_instant", "duration_minutes", "duration_semantics"].map(key => [key, payload[key]]))));
    after.booking = { ...structuredClone(payload), mode: "resolved_elapsed", ...resolved };
    Object.assign(after, { start_time: payload.start_time, start_day_offset: payload.start_day_offset, duration_minutes: payload.duration_minutes, time_is_suggested: false });
  } else throw new Error(`Unexpected family: ${kind}`);
  return plan(type, before, after);
}
