// Supplemental checks for fb7ecc0. The unchanged 0b43cff evidence is indexed in MAINTAINING.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";
import { SyntheticStore } from "../prototypes/p1-store/sqlite.mjs";
import { emptyFixtureState } from "../prototypes/p1-store/legacy.mjs";

const digest = data => createHash("sha256").update(data).digest("hex");
const encode = data => Buffer.from(JSON.stringify(data));
const principal = { authenticated: true, can_write: true, can_query: true,
  dataset_id: "fixture-dataset", source_device_id: "fixture-device" };

function inputFor(base, step, revisions) {
  const doc = structuredClone(base);
  for (const [key, value] of Object.entries(step.patch ?? {})) {
    if (key === "expected_revision_var") {
      assert.ok(revisions[value]);
      doc.expected_revision_id = revisions[value];
    } else if (["operation", "target", "payload"].includes(key)) Object.assign(doc[key], value);
    else doc[key] = value;
  }
  if (!step.sort_keys) return doc;
  return JSON.parse(JSON.stringify(doc, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value));
}

function businessRow(command) {
  const { allow_shared_receipts, ...fields } = command.payload;
  return { ...fields, id: command.target.entity_id };
}

function hostStore(defaults, count) {
  const state = emptyFixtureState();
  state.expenses = Array.from({ length: count }, (_, i) => ({
    ...businessRow(defaults.base_command), id: `seed-expense-${i}`, title: `预置消费 ${i}`, amount_cents: 100, category: "other" }));
  let store = SyntheticStore.create({ dataset_id: defaults.dataset_id, travel_id: defaults.travel_id,
    branch_id: defaults.branch_id, revision_id: defaults.initial_revision_id, state });
  const dir = store.directory;
  return {
    execute: doc => store.execute(encode(doc), principal),
    query: doc => store.query(encode(doc), principal),
    reopen() { store.close(); store = new SyntheticStore(dir); },
    readReceipt() {
      const rows = store.inspectFixture().tables.fixture_receipts;
      assert.equal(rows.length, 1);
      const { dataset, source, operation, intent, effect, result_revision } = rows[0];
      return { key: [dataset, source, operation], artifact: fingerprintIntent(Buffer.from(intent), "control"),
        effect, revision: result_revision };
    },
    busy(doc) {
      const lock = new DatabaseSync(path.join(dir, "synthetic.sqlite"));
      try { lock.exec("BEGIN IMMEDIATE"); return store.query(encode(doc), principal); }
      finally { lock.close(); }
    },
    inspect() {
      const { state, tables, head } = store.inspectFixture();
      return { head, count: state.expenses.length, facts: state.expenses,
        history: tables.fixture_revisions, receipts: tables.fixture_receipts.map(r => ({
          operation: r.operation, result: r.result_revision, intent: JSON.parse(r.intent) })),
        outbox: tables.fixture_outbox.map(r => ({ operation: r.operation, result: r.result_revision })) };
    },
    close() { store.close(); rmSync(dir, {recursive:true, force:true}); },
  };
}

async function androidStore(context, defaults, count, scenario) {
  const { client, adb } = context;
  async function call(method, args) {
    return client.evaluate(`(async () => {
      const {registerPlugin} = await import("./capacitor-core.js");
      return registerPlugin("P1BridgeReceipt")[${JSON.stringify(method)}](${JSON.stringify({ scenario, ...args })});
    })()`);
  }
  await call("seedCreateScenario", { datasetId: defaults.dataset_id, travelId: defaults.travel_id,
    branchId: defaults.branch_id, initialRevisionId: defaults.initial_revision_id, initialCount: count });
  async function query(doc) {
    return call("lookupCreateReceipt", { datasetId: doc.operation.dataset_id,
      sourceDeviceId: doc.operation.source_device_id, operationId: doc.operation.operation_id, principal });
  }
  return {
    execute(doc) {
      return client.evaluate(`(async () => {
        const {registerPlugin} = await import("./capacitor-core.js");
        const {canonicalizeControlDocument} = await import("./bridge-command.js");
        const command = ${JSON.stringify(doc)};
        return registerPlugin("P1BridgeReceipt").submitExpenseCreate({scenario:${JSON.stringify(scenario)},
          principal:${JSON.stringify(principal)}, rawCommandJson:JSON.stringify(command),
          canonicalIntentJson:canonicalizeControlDocument(command), faultMode:"none"});
      })()`);
    },
    query,
    async readReceipt() {
      const { receipts } = await call("inspectCreateState", {});
      assert.equal(receipts.length, 1);
      const row = receipts[0];
      const wrapper = JSON.parse(row.intent_json);
      const artifact = fingerprintIntent(encode(wrapper.intent), wrapper.channel);
      assert.equal(artifact.canonical_profile, wrapper.canonical_profile);
      assert.equal(artifact.canonical_json, row.intent_json);
      return { key: [row.dataset_id, row.source_device_id, row.operation_id], artifact,
        effect: row.effect, revision: row.result_revision_id };
    },
    async busy(doc) {
      const child = spawn(path.join(process.env.ANDROID_HOME, "platform-tools/adb"), ["-s", adb.serial,
        "shell","-T","run-as","org.travelflow.p1bridge","sqlite3",`files/p1-bridge-${scenario}/store.db`],
        {stdio:["pipe","pipe","pipe"]});
      const done = once(child, "close");
      const timer = setTimeout(() => child.kill(), 15000);
      try {
        child.stdin.write("BEGIN IMMEDIATE;\n.print LOCKED\n");
        const [chunk] = await Promise.race([once(child.stdout, "data"), done.then(() => { throw Error("lock holder exited"); })]);
        assert.equal(chunk.toString().trim(), "LOCKED");
        return await query(doc);
      } finally {
        if (child.exitCode === null && !child.killed) child.stdin.end("ROLLBACK;\n.quit\n");
        try { assert.deepEqual(await done, [0,null]); } finally { clearTimeout(timer); }
      }
    },
    async inspect() {
      // Native calls reopen SQLite on each invocation. Read historical snapshots, receipts and the current page.
      const s = await call("inspectCreateState", {pageOffset:0,pageLimit:200});
      const facts = [...s.expenses];
      while (facts.length < s.expenseCount) {
        const page = await call("inspectCreateState", {pageOffset:facts.length,pageLimit:200});
        assert.equal(page.headRevisionId,s.headRevisionId);
        assert.ok(page.expenses.length > 0);
        facts.push(...page.expenses);
      }
      assert.equal(facts.length,s.expenseCount);
      return { head:s.headRevisionId, count:s.expenseCount, facts, history:s.revisions,
        receipts:s.receipts.map(r=>({operation:r.operation_id,result:r.result_revision_id,intent:JSON.parse(r.intent_json).intent})),
        outbox:s.outbox.map(r=>({operation:r.operation_id,result:r.result_revision_id})) };
    },
    reopen() {}, close() {},
  };
}

// Only the invalid-input mapping and persistent receipt representation changed in candidate 2.
async function checkSecondCandidate(filename, defaults, android) {
  const read = name => JSON.parse(readFileSync(path.join(path.dirname(filename), name)));
  const { cases } = read("canonical-digests.json");
  const invalidInput = read("result-mapping.json").outcomes.rejected_invalid_input;
  const report = [];
  for (const [caseId, scenario] of [
    ["control_lunch_base", "create-before-commit"],
    ["control_lunch_allow_shared_receipts_true", "create-after-commit"],
  ]) {
    const expected = cases.find(item => item.id === caseId);
    const command = JSON.parse(expected.raw_json);
    const store = android ? await androidStore(android, defaults, 0, scenario) : hostStore(defaults, 0);
    try {
      const errors = {};
      if (!android && caseId === "control_lunch_base") {
        const before = await store.inspect();
        for (const [field, value, code] of [
          ["category", "unknown", "category"], ["settles_budget", true, "budget_link"],
        ]) {
          const invalid = structuredClone(command);
          invalid.payload[field] = value;
          const result = await store.execute(invalid);
          assert.deepEqual(result, { accepted: false, error: code });
          assert.ok(invalidInput.mobile_host.errors.includes(result.error));
          assert.deepEqual(await store.inspect(), before);
          errors[field] = result.error;
        }
      }
      const saved = await store.execute(command);
      assert.equal(saved.accepted, true);
      assert.equal(saved.replayed, false);
      store.reopen();
      const row = await store.readReceipt();
      const { dataset_id, source_device_id, operation_id } = command.operation;
      assert.deepEqual(row.key, [dataset_id, source_device_id, operation_id]);
      assert.equal(row.effect, "changed");
      assert.equal(row.revision, saved.result_revision_id);
      assert.equal(row.artifact.canonical_json, expected.canonical_json);
      assert.equal(row.artifact.sha256, expected.sha256);
      report.push({ caseId, revision: row.revision, sha256: row.artifact.sha256, errors });
    } finally { store.close(); }
  }
  return report;
}

export async function checkVectorGaps(filename, android) {
  const bytes = readFileSync(filename);
  if (digest(bytes) === "6a37e2a612fa21a439cfafaf1442a920b05168504c93dd9cd5b305e81316d754") {
    return checkSecondCandidate(filename, JSON.parse(bytes).defaults, android);
  }
  const candidate = digest(bytes) === "0c0f869ea650f5ea0e01b2e966cc3bb780ad9c10ce0618329a83bb12d309bba7";
  if (!candidate) assert.equal(digest(bytes), "2679ab4a3461be7b039a0686d6436640db32e4bbc1af700bd9f565a3a7e76bcb");
  const mapping = candidate ? JSON.parse(readFileSync(path.join(path.dirname(filename), "result-mapping.json"))) : null;
  const platform = android ? "mobile_android" : "mobile_host";
  const {defaults, scenarios} = JSON.parse(bytes);
  const dirs = {EC03:"create-after-commit",EC07:"create-before-commit",EC08:"create-boundary-cap-2000",EC10:"create-boundary-fields-scope"};
  const report = [];
  for (const scenario of scenarios) {
    const id = scenario.id.slice(0,4);
    if (!dirs[id]) continue;
    const count = scenario.initial_state.seeded_expenses;
    const store = android ? await androidStore(android, defaults, count, dirs[id]) : hostStore(defaults,count);
    const revisions = {};
    try {
      const initial = await store.inspect();
      assert.equal(initial.count,count);
      assert.equal(initial.head,defaults.initial_revision_id);
      assert.deepEqual([initial.history.length,initial.receipts.length,initial.outbox.length],[1,0,0]);
      for (const step of scenario.steps) {
        const isQuery = step.action.startsWith("lookup");
        const doc = inputFor(isQuery ? defaults.base_receipt_query : defaults.base_command,step,revisions);
        const before = await store.inspect();
        const inputHash = digest(encode(doc));
        const raw = step.action === "lookup_under_write_lock" ? await store.busy(doc)
          : isQuery ? await store.query(doc) : await store.execute(doc);
        // EC03's actual process interruption was already tested on both platforms; only set up its committed row here.
        store.reopen();
        const after = await store.inspect();
        assert.equal(digest(encode(doc)),inputHash);
        const binding = step.bind_revision ?? step.bind_revision_from_head;
        if (binding) revisions[binding] = after.head;
        if (step.action === "lookup_under_write_lock") {
          assert.deepEqual(raw,android ? {accepted:true,state:"pending_busy"} : {accepted:true,state:"unknown",reason:"storage_busy"});
        } else if (isQuery) {
          assert.deepEqual(raw, id === "EC07" ? {accepted:true,state:"not_found_at_settled_read"} :
            {accepted:true,state:"committed",receipt:{effect:"changed",result_revision_id:revisions.R1}});
        } else if (step.expected.business_outcome.startsWith("rejected_") && !(id === "EC10" && !android && step.name === "non_null_paid_on")) {
          const error = id === "EC08" ? "expense_count" : android ? "unsupported_capability" :
            step.name === "unsupported_currency_usd" ? "currency" : "baseline_conflict";
          assert.deepEqual(raw,{accepted:false,error},step.name);
        } else {
          const replayed = step.expected.business_outcome === "replayed_committed";
          assert.deepEqual(raw,{accepted:true,kind:"committed",replayed,effect:"changed",
            result_revision_id:replayed ? revisions.R1 : after.head});
        }
        if (!isQuery && raw.accepted && !raw.replayed) {
          assert.notEqual(after.head,before.head);
          assert.equal(after.count,before.count+1);
          assert.equal(after.history.length,before.history.length+1);
          assert.deepEqual(after.history.slice(0,-1),before.history);
          assert.deepEqual(after.facts.filter(r => r.id !== doc.target.entity_id), before.facts);
          const row = {...after.facts.find(r=>r.id===doc.target.entity_id)};
          delete row.created_at; delete row.updated_at;
          assert.deepEqual(row,businessRow(doc));
          const op=doc.operation.operation_id;
          assert.deepEqual(after.receipts,[...before.receipts,{operation:op,result:after.head,intent:doc}]);
          assert.deepEqual(after.outbox,[...before.outbox,{operation:op,result:after.head}]);
        } else assert.deepEqual(after,before,step.name);
        const delta = {revisions:after.history.length-before.history.length, expenses:after.count-before.count,
          receipts:after.receipts.length-before.receipts.length, outbox:after.outbox.length-before.outbox.length};
        if (!(id === "EC10" && !android && step.name === "non_null_paid_on")) {
          assert.deepEqual(delta,step.expected.state_delta);
        }
        const probes = {};
        if (candidate) {
          const outcome = step.expected.business_outcome;
          const entry = mapping.outcomes[outcome][platform];
          if (id === "EC10" && !android) {
            assert.equal(raw.error ?? raw.kind, entry.observed_9dec892[step.name]);
          } else if (outcome === "lookup_committed") {
            assert.equal(raw.state, entry.state);
            assert.deepEqual(Object.keys(raw.receipt).sort(), entry.minimal_receipt_projection.toSorted());
            assert.equal(raw.receipt.effect, entry.effect);
            assert.equal(Object.hasOwn(raw.receipt, "intent_sha256"), entry.includes_intent_sha256);
            assert.equal(mapping.confirmation_rule.minimal_receipt_sufficient_for_intent_confirmation, false);
            // Same lookup key and projection, two different local intents. Only the original may replay.
            for (const patch of [{ amount_cents: 8636 }, { allow_shared_receipts: true }]) {
              const other = structuredClone(defaults.base_command);
              Object.assign(other.payload, patch);
              assert.deepEqual(await store.query(defaults.base_receipt_query), raw);
              const rejected = await store.execute(other);
              assert.deepEqual(rejected, { accepted: false, error: "intent_conflict" });
              probes[Object.keys(patch)[0]] = rejected;
              assert.deepEqual(await store.inspect(), after);
            }
            // Check the invalid-field mapping on fresh keys and the current baseline.
            for (const [field, value, hostError] of [
              ["category", "unknown", "category"], ["settles_budget", true, "budget_link"],
            ]) {
              const invalid = structuredClone(defaults.base_command);
              invalid.operation.operation_id = "fixture-op-invalid";
              invalid.target.entity_id = "fixture-invalid";
              invalid.expected_revision_id = after.head;
              invalid.payload[field] = value;
              const rejected = await store.execute(invalid);
              assert.deepEqual(rejected, { accepted: false, error: android ? "invalid_field" : hostError });
              probes[field] = rejected;
              assert.deepEqual(await store.inspect(), after);
            }
          } else if (!step.fault) {
            for (const [key, value] of Object.entries(entry)) assert.deepEqual(raw[key], value, step.name);
          }
        }
        report.push({id,step:step.name,setup_only:!!step.fault,input_sha256:inputHash,raw,delta,...(Object.keys(probes).length ? {probes} : {})});
      }
    } finally { store.close(); }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkVectorGaps(process.argv[2]),null,2));
}
