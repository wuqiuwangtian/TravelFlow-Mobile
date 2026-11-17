// Fixed host integration cases plus deterministic scheduler tests; no device,
// database, secret, real authentication provider, network or dependency install.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROFILE, BoundaryError, parseInput } from "../prototypes/p1-boundary/input.mjs";
import { CandidateBoundary, controlIntent, queryIntent, capabilities } from "../prototypes/p1-boundary/commands.mjs";
import { BoundedScheduler } from "../prototypes/p1-boundary/scheduler.mjs";

assert.equal(process.argv.length, 2, "Usage: node scripts/check-p1-boundary.mjs");
const corpus = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-boundary-cases.json", import.meta.url)));
const baseline = JSON.parse(readFileSync(new URL("../docs/internal/fixtures/p1-patch-cases.json", import.meta.url))).baseline;
assert.equal(corpus.fixture_format_version, 1);
assert.equal(corpus.status, "host-boundary-candidate");
assert.equal(corpus.shared_contract_version, null);
assert.ok(Array.isArray(corpus.cases) && corpus.cases.length === 55, "Keep the fixed input corpus complete");
assert.deepEqual(PROFILE, { status: "host-candidate-not-shared-contract", control_profile: "p1-host-control-1", query_profile: "p1-host-query-1",
  control_bytes: 32768, query_bytes: 8192, depth: 16, tokens: 2048, string_scalars: 4096, number_characters: 64,
  key_scalars: 256, key_bytes: 1024, running_global: 4, queued_global: 32, running_per_scope: 1, queued_per_scope: 16 });
const clone = value => structuredClone(value);
const encode = value => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
function generate(recipe) {
  switch (recipe.kind) {
    case "raw": return encode(recipe.text);
    case "padded": {
      const bytes = encode(recipe.text);
      assert.ok(bytes.length <= recipe.bytes);
      const result = new Uint8Array(recipe.bytes).fill(32); result.set(bytes); return result;
    }
    case "nested": return encode("[".repeat(recipe.depth) + "0" + "]".repeat(recipe.depth));
    case "tokens": {
      const items = Array(recipe.items).fill("0"); if (recipe.last_object) items[items.length - 1] = "{}";
      return encode("[" + items.join(",") + "]");
    }
    case "string": return encode(JSON.stringify(recipe.character.repeat(recipe.count)));
    case "escaped_string": return encode('"' + "\\u0061".repeat(recipe.count) + '"');
    case "number": return encode("9".repeat(recipe.digits));
    case "hex": return Uint8Array.from(Buffer.from(recipe.hex, "hex"));
    case "oversize_invalid": return new Uint8Array(32769).fill(255);
    default: throw new Error("Unknown fixture recipe");
  }
}

const ids = new Set();
for (const entry of corpus.cases) {
  assert.match(entry.id, /^BI[0-9]{2}$/); assert.ok(!ids.has(entry.id)); ids.add(entry.id);
  const bytes = generate(entry.recipe);
  let result;
  try {
    result = ({ parse: () => parseInput(bytes, entry.recipe.channel ?? "control"), control: () => controlIntent(bytes),
      query: () => queryIntent(bytes), capabilities: () => capabilities(bytes) })[entry.entry]();
    assert.equal(entry.expected.accepted, true, `${entry.id}: accepted rejected input`);
  } catch (error) {
    if (!(error instanceof BoundaryError)) throw error;
    assert.deepEqual({ accepted: false, error: error.code }, entry.expected, entry.id);
    continue;
  }
  if (Object.hasOwn(entry.expected, "amount")) assert.equal(result.payload.amount_cents, entry.expected.amount, entry.id);
  if (["control", "query"].includes(entry.entry)) assert.equal(Object.isFrozen(result.operation), true);
  if (entry.entry === "capabilities") {
    assert.deepEqual(result.limits, PROFILE); assert.equal(result.shared_contract_version, null);
    result.limits.control_bytes = 1; assert.equal(PROFILE.control_bytes, 32768, "Capabilities must not mutate enforcement");
  }
}

let flowCases = 0, schedulerCases = 0;
const deadline = setTimeout(() => { throw new Error("Boundary self-check stalled"); }, 15000);
async function flow(name, work) { await work(); flowCases++; }
async function schedule(name, work) { await work(); schedulerCases++; }
function context(options = {}) {
  const stats = { authorization: 0, receipts: 0, inspections: 0, writes: 0 };
  const snapshot = { revision_id: "revision-1", expense: clone(baseline.base), links: clone(baseline.context), expense_count: 1, ...options.snapshot };
  const instance = {
    principal: { authenticated: true, source_device_id: "device-1", ...options.principal }, stats,
    async authorize(operation, target, mode, signal) {
      stats.authorization++;
      if (options.authorize) return options.authorize(operation, target, mode, signal);
      return options.allowed !== false && operation.dataset_id === "dataset-1" && (operation.source_device_id === "device-1" || options.allowOldSource)
        && (!target || target.travel_id === "travel-1");
    },
    async lookupReceipt() { stats.receipts++; if (options.throwRead) throw options.throwRead; return options.record ?? { state: "missing", settled: true }; },
    async inspect() { stats.inspections++; return snapshot; },
    async commit() { stats.writes++; throw new Error("Unexpected persistence in host candidate"); },
  };
  return instance;
}
function request(payload, updates = {}) { return { ...clone(corpus.templates.patch), payload, ...updates }; }
const watch = promise => promise.then(value => ({ value }), error => ({ error }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

try {
  await flow("raw patch to joint plan", async () => {
    const ctx = context(), response = await new CandidateBoundary().control(encode(request({ notes: "补记" })), ctx);
    assert.equal(response.kind, "uncommitted-plan"); assert.equal(response.value.candidate.notes, "补记");
    assert.deepEqual(ctx.stats, { authorization: 1, receipts: 1, inspections: 1, writes: 0 });
    assert.equal(ctx.principal.authenticated, true);
  });
  await flow("raw integer semantics include original lexeme", async () => {
    const body = JSON.stringify(request({ amount_cents: "TOKEN" })).replace('"TOKEN"', "1e2");
    const result = await new CandidateBoundary().control(encode(body), context());
    assert.equal(result.value.candidate.amount_cents, 100);
  });
  await flow("full create validates new references", async () => {
    const ctx = context({ snapshot: { expense: null, expense_count: 1999 } });
    const response = await new CandidateBoundary().control(encode(corpus.templates.create), ctx);
    assert.equal(response.kind, "uncommitted-plan"); assert.equal(response.value.planned_business_revision, "new");
    assert.equal(response.value.candidate.id, "fictional-expense"); assert.equal(response.value.candidate.currency, "CNY");
  });
  for (const [name, snapshot, expected] of [
    ["create record count", { expense: null, expense_count: 2000 }, "expense_count"],
    ["create entity collision", {}, "entity_exists"],
  ]) await flow(name, async () => assert.equal((await new CandidateBoundary().control(encode(corpus.templates.create), context({ snapshot }))).error, expected));
  await flow("new create receipt is checked", async () => {
    const body = clone(corpus.templates.create); body.payload.receipt_ids = ["4".repeat(32)];
    assert.equal((await new CandidateBoundary().control(encode(body), context({ snapshot: { expense: null } }))).error, "receipt_unavailable");
  });
  for (const [name, payload, expected] of [["joint budget", { budget_item_id: null }, "budget_link"],
    ["baseline conflict even for no-op", {}, "baseline_conflict"]]) await flow(name, async () => {
      const ctx = context(name.startsWith("baseline") ? { snapshot: { revision_id: "later" } } : {});
      assert.equal((await new CandidateBoundary().control(encode(request(payload)), ctx)).error, expected);
    });
  await flow("new patch missing entity", async () => assert.equal((await new CandidateBoundary().control(encode(request({})), context({ snapshot: { expense: null } }))).error, "entity_missing"));
  await flow("repository target must match", async () => assert.equal((await new CandidateBoundary().control(encode(request({})), context({ snapshot: { expense: { ...baseline.base, id: "wrong" } } }))).error, "target_mismatch"));
  await flow("no-change is a plan not a committed receipt", async () => {
    const result = await new CandidateBoundary().control(encode(request({})), context());
    assert.equal(result.value.planned_business_revision, "unchanged"); assert.equal(result.value.planned_operation_receipt, "required-not-persisted");
  });
  await flow("legacy unknown correction preserves absence", async () => {
    const expense = clone(baseline.base); delete expense.currency;
    const result = await new CandidateBoundary().control(encode(request({ amount_cents: 12000 })), context({ snapshot: { expense } }));
    assert.equal(Object.hasOwn(result.value.candidate, "currency"), false); assert.equal(result.value.cny_totals_eligible, false);
  });
  for (const [name, bytes] of [
    ["oversize", new Uint8Array(32769)],
    ["huge exponent", encode(JSON.stringify(request({ amount_cents: "TOKEN" })).replace('"TOKEN"', "1e1000000000"))],
    ["partial schema", encode(request({ observed_head: "r2" }))],
  ]) await flow(`${name} never reaches adapters`, async () => {
    const ctx = context(); const result = await new CandidateBoundary().control(bytes, ctx);
    assert.equal(result.accepted, false); assert.deepEqual(ctx.stats, { authorization: 0, receipts: 0, inspections: 0, writes: 0 });
  });
  for (const entry of corpus.cases.filter(entry => entry.entry === "parse" && entry.recipe.channel !== "query" && entry.expected.error?.startsWith("resource_"))) {
    await flow(`${entry.id} budget rejection precedes every adapter`, async () => {
      const ctx = context(); assert.equal((await new CandidateBoundary().control(generate(entry.recipe), ctx)).error, entry.expected.error);
      assert.deepEqual(ctx.stats, { authorization: 0, receipts: 0, inspections: 0, writes: 0 });
    });
  }
  await flow("complete control envelope at 32KiB", async () => {
    const bytes = generate({ kind: "padded", text: JSON.stringify(request({})), bytes: 32768 });
    assert.equal((await new CandidateBoundary().control(bytes, context())).kind, "uncommitted-plan");
  });
  await flow("complete receipt query at 8KiB and plus one", async () => {
    const ctx = context();
    assert.equal((await new CandidateBoundary().query(generate({ kind: "padded", text: JSON.stringify(corpus.templates.query), bytes: 8192 }), ctx)).state, "not_found_at_settled_read");
    const denied = context();
    assert.equal((await new CandidateBoundary().query(new Uint8Array(8193), denied)).error, "resource_bytes");
    assert.deepEqual(denied.stats, { authorization: 0, receipts: 0, inspections: 0, writes: 0 });
  });
  for (const options of [{ principal: { authenticated: false } }, { principal: { source_device_id: "spoof" } }, { allowed: false }]) {
    await flow("current authority denied before receipt read", async () => {
      const ctx = context({ ...options, record: { state: "committed" } });
      assert.equal((await new CandidateBoundary().control(encode(request({})), ctx)).error, "denied");
      assert.equal(ctx.stats.receipts, 0); assert.equal(ctx.stats.inspections, 0);
    });
  }
  await flow("same committed intent bypasses current entity and head", async () => {
    const body = request({ amount_cents: 100 });
    const record = { state: "committed", intent: controlIntent(encode(body)), effect: "changed", result_revision_id: "original" };
    const replay = JSON.stringify(request({ amount_cents: "TOKEN" })).replace('"TOKEN"', "100.0");
    const ctx = context({ record, snapshot: { revision_id: "later", expense: null } });
    const result = await new CandidateBoundary().control(encode(replay), ctx);
    assert.equal(result.kind, "replay-view"); assert.equal(result.receipt.result_revision_id, "original"); assert.equal(ctx.stats.inspections, 0);
  });
  await flow("same key different control intent is rejected", async () => {
    const ctx = context({ record: { state: "committed", intent: controlIntent(encode(request({ allow_shared_receipts: false }))), effect: "no_change", result_revision_id: "r1" } });
    assert.equal((await new CandidateBoundary().control(encode(request({ allow_shared_receipts: true })), ctx)).error, "intent_conflict");
    assert.equal(ctx.stats.inspections, 0);
  });
  for (const [record, expected] of [[{ state: "unavailable" }, "receipt_unavailable"], [{ state: "missing", settled: false }, "result_unknown"]]) {
    await flow("unresolved receipt does not become new operation", async () => {
      const ctx = context({ record }); assert.equal((await new CandidateBoundary().control(encode(request({})), ctx)).error, expected); assert.equal(ctx.stats.inspections, 0);
    });
  }
  for (const effect of ["changed", "no_change"]) await flow("query needs only current authorized bounded key", async () => {
    const ctx = context({ record: { state: "committed", effect, result_revision_id: "old", old_profile: "retired", payload: "not re-decoded" } });
    const result = await new CandidateBoundary().query(encode(corpus.templates.query), ctx);
    assert.deepEqual(result, { accepted: true, state: "committed", receipt: { effect, result_revision_id: "old" } }); assert.equal(ctx.stats.inspections, 0);
  });
  await flow("query can use separately authorized original source", async () => {
    const body = clone(corpus.templates.query); body.operation.source_device_id = "old-source";
    assert.equal((await new CandidateBoundary().query(encode(body), context({ allowOldSource: true }))).state, "not_found_at_settled_read");
  });
  await flow("query authorization hides existence", async () => {
    for (const record of [{ state: "committed" }, { state: "missing", settled: true }]) {
      const ctx = context({ allowed: false, record }); assert.equal((await new CandidateBoundary().query(encode(corpus.templates.query), ctx)).error, "denied"); assert.equal(ctx.stats.receipts, 0);
    }
  });
  await flow("authority must explicitly return boolean true", async () => {
    const ctx = context({ authorize: async () => "false" });
    assert.equal((await new CandidateBoundary().query(encode(corpus.templates.query), ctx)).error, "denied");
    assert.equal(ctx.stats.receipts, 0);
  });
  await flow("malformed stored projection cannot confirm a commit", async () => {
    const ctx = context({ record: { state: "committed", effect: "no_change", result_revision_id: "\ud800" } });
    assert.equal((await new CandidateBoundary().query(encode(corpus.templates.query), ctx)).error, "receipt_unavailable");
  });
  for (const record of [{ state: "unavailable" }, { state: "missing", settled: false }]) await flow("query unavailable stays unknown", async () => {
    assert.equal((await new CandidateBoundary().query(encode(corpus.templates.query), context({ record }))).state, "unknown");
  });
  await flow("unexpected adapter failures propagate and release scheduler", async () => {
    const boundary = new CandidateBoundary(), boom = new Error("synthetic adapter failure");
    await assert.rejects(boundary.control(encode(request({})), context({ throwRead: boom })), error => error === boom);
    assert.deepEqual(boundary.scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });

  await schedule("per-scope exact queue limit and queued cancellation", async () => {
    const scheduler = new BoundedScheduler(), gate = deferred(), abort = new AbortController();
    const first = watch(scheduler.run("same", () => gate.promise));
    const waiting = Array.from({ length: 15 }, () => watch(scheduler.run("same", () => 1)));
    const cancelled = watch(scheduler.run("same", () => 1, abort.signal));
    assert.deepEqual(scheduler.snapshot(), { running: 1, queued: 16, busy_scopes: 1 });
    assert.equal((await watch(scheduler.run("same", () => 1))).error.code, "queue_full");
    abort.abort(); assert.equal((await cancelled).error.code, "cancelled"); assert.equal(scheduler.snapshot().queued, 15);
    gate.resolve(); await Promise.all([first, ...waiting]); assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
  await schedule("global cross-scope limits", async () => {
    const scheduler = new BoundedScheduler(), gate = deferred(); let active = 0, peak = 0;
    const work = async () => { peak = Math.max(peak, ++active); await gate.promise; active--; };
    const jobs = Array.from({ length: 4 }, (_, i) => watch(scheduler.run(`device-${i}`, work)));
    for (let i = 0; i < 32; i++) jobs.push(watch(scheduler.run(`device-${i % 4}`, work)));
    assert.deepEqual(scheduler.snapshot(), { running: 4, queued: 32, busy_scopes: 4 });
    assert.equal((await watch(scheduler.run("another-device", work))).error.code, "queue_full");
    await tick(); assert.equal(peak, 4); gate.resolve(); await Promise.all(jobs); assert.equal(peak, 4);
    assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
  await schedule("running cancellation waits for actual settlement", async () => {
    const scheduler = new BoundedScheduler(), gate = deferred(), abort = new AbortController(); let next = false;
    const running = watch(scheduler.run("same", () => gate.promise, abort.signal));
    const waiting = watch(scheduler.run("same", () => { next = true; }));
    await tick(); abort.abort(); await tick(); assert.equal(next, false);
    assert.deepEqual(scheduler.snapshot(), { running: 1, queued: 1, busy_scopes: 1 });
    gate.resolve(); assert.equal((await running).error.code, "cancelled"); await waiting;
    assert.equal(next, true); assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
  await schedule("worker failure releases capacity", async () => {
    const scheduler = new BoundedScheduler(), boom = new Error("worker");
    const first = watch(scheduler.run("same", () => { throw boom; }));
    const second = scheduler.run("same", () => 7);
    assert.equal((await first).error, boom); assert.equal(await second, 7);
    assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
  await schedule("a blocked queued scope does not block an eligible scope", async () => {
    const scheduler = new BoundedScheduler(), gates = Array.from({ length: 4 }, deferred), entered = deferred();
    const running = gates.map((gate, i) => scheduler.run(String(i), () => gate.promise));
    const blocked = scheduler.run("0", () => 1);
    const eligible = scheduler.run("new-scope", () => { entered.resolve(); return 2; });
    gates[1].resolve(); await entered.promise;
    assert.equal(scheduler.snapshot().queued, 1, "Scope 0 must remain blocked while new-scope can run");
    for (const gate of gates) gate.resolve();
    assert.equal(await eligible, 2); await Promise.all([...running, blocked]);
    assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
  await schedule("pre-cancelled admission creates no job", async () => {
    const scheduler = new BoundedScheduler(), abort = new AbortController(); abort.abort();
    assert.equal((await watch(scheduler.run("same", () => 1, abort.signal))).error.code, "cancelled");
    assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
  await schedule("authorization hooks and queries share global worker budget", async () => {
    const boundary = new CandidateBoundary(), otherBoundary = new CandidateBoundary(), gate = deferred();
    assert.equal(boundary.scheduler, otherBoundary.scheduler, "Default instances must share the host admission pool");
    const ctx = context({ authorize: async () => { await gate.promise; return true; } });
    const jobs = Array.from({ length: 4 }, (_, i) => boundary.control(encode(request({}, { target: { ...corpus.templates.patch.target, branch_id: `branch-${i}` } })), ctx));
    await tick(); assert.equal(ctx.stats.authorization, 4);
    const abort = new AbortController(), query = otherBoundary.query(encode(corpus.templates.query), ctx, abort.signal);
    assert.equal(boundary.scheduler.snapshot().queued, 1); abort.abort(); assert.equal((await query).error, "cancelled");
    gate.resolve(); await Promise.all(jobs); assert.equal(ctx.stats.authorization, 4);
    assert.deepEqual(boundary.scheduler.snapshot(), { running: 0, queued: 0, busy_scopes: 0 });
  });
} finally { clearTimeout(deadline); }

console.log(JSON.stringify({ raw_input_cases: ids.size, integration_cases: flowCases, scheduler_cases: schedulerCases,
  scope: "single-JS-runtime host candidate; synthetic authorization and read adapters; uncommitted plans only",
  preparse_limits_checked: true, bounded_integer_expansion_checked: true, adapter_dispatch_spies_checked: true,
  shared_contract_version: null, canonical_bytes_verified: false, real_authentication_verified: false,
  durable_receipts_verified: false, sqlite_transaction_verified: false, android_native_executed: false,
  node: process.version,
}, null, 2));
