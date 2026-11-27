// Included by the isolated handoff harness. Both APK versions use the same signed app ID and trip.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";
import { setInputValue, waitForCondition } from "./check-p1-offline-entry-android.mjs";

export async function checkPendingUpgrade({ ctx, before, inspect, sql, phone, restart, cdp, handoff, upgrade }) {
  const dump = () => sql(".dump");
  const localRows = () => sql("SELECT seq,hex(raw_command_json),hex(canonical_intent_json),expected_revision_id,"
    + "result_revision_id,intent_sha256 FROM outbox ORDER BY seq");
  const wireRows = () => sql("SELECT outbox_seq,hex(raw_command_json),expected_revision_id,intent_sha256 FROM outbox_wire ORDER BY outbox_seq");

  async function save(title, amount) {
    const seq = (await phone("getUiState()")).saveAttemptSeq;
    await cdp().tap("trip-open-entry-btn");
    await setInputValue(cdp(), "trip-entry-title", title);
    await setInputValue(cdp(), "trip-entry-amount-yuan", amount);
    await cdp().tap("trip-entry-save-btn");
    await waitForCondition(cdp(), `(() => { const s = window.__travelflowOfflineEntry.getUiState();
      return s.saveAttemptSeq > ${seq} && s.lastAttempt.outcome === "saved"; })()`, "legacy ledger saved");
  }
  await save("旧版已发送的午餐", "17.23");
  await save("旧版离线车票", "3.00");
  assert.equal(sql("PRAGMA user_version"), "2");
  const original = await phone("inspect()");
  const localBytes = localRows();
  const items = (await phone("exportOutboxCommands()")).items;
  assert.equal(items.length, 2);
  const [first, second] = items;
  assert.equal(first.expected_revision_id, ctx.current_revision_id);
  assert.equal(second.expected_revision_id, first.result_revision_id);
  for (const item of items) assert.equal(item.intent_sha256, fingerprintIntent(Buffer.from(item.raw_command_json)).sha256);
  handoff("receive", Buffer.from(first.raw_command_json), 86, "--fault", "after_commit_before_reply");
  const desktopAfterCommit = inspect();
  assert.equal(desktopAfterCommit.head_paid_cents, before.head_paid_cents + 1723);
  assert.equal(desktopAfterCommit.receipts.length, before.receipts.length + 1);

  await upgrade();
  assert.equal(sql("PRAGMA user_version"), "3");
  assert.equal(localRows(), localBytes);
  const migrated = await phone("inspect()");
  assert.deepEqual([migrated.expenseCount, migrated.totalCents, migrated.outboxCount, migrated.headRevisionId],
    [2, 2023, 2, original.headRevisionId]);
  assert.deepEqual(migrated.expenses, original.expenses);
  const expectedWires = items.map(item => [item.seq, Buffer.from(item.raw_command_json).toString("hex").toUpperCase(),
    item.expected_revision_id, item.intent_sha256].join("|")).join("\n");
  assert.equal(wireRows(), expectedWires);
  const query = item => Buffer.from(JSON.stringify(item.receipt_query));
  const reply = handoff("lookup", query(first));
  assert.equal(reply.receipt.intent_sha256, first.intent_sha256);
  const confirm = result => phone(`confirmDelivery(${JSON.stringify(first.operation_id)},${JSON.stringify(result)})`);
  const mismatched = structuredClone(reply);
  mismatched.receipt.intent_sha256 = second.intent_sha256;
  const beforeMismatch = dump();
  assert.equal((await confirm(mismatched)).accepted, false);
  assert.equal(dump(), beforeMismatch);
  assert.equal((await confirm(reply)).accepted, true);
  const afterConfirm = dump();
  assert.equal((await confirm(reply)).accepted, true);
  await restart();
  assert.equal(dump(), afterConfirm);
  const pending = (await phone("exportOutboxCommands()")).items;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].raw_command_json, second.raw_command_json);
  assert.equal(pending[0].expected_revision_id, second.expected_revision_id);
  assert.equal(pending[0].intent_sha256, second.intent_sha256);
  // v2 has no marker proving this op was never sent. Its old local parent must survive later mappings.
  const rejected = handoff("receive", Buffer.from(pending[0].raw_command_json), 1);
  assert.deepEqual([rejected.ok, rejected.error], [false, "baseline_conflict"]);
  const final = await phone("inspect()");
  assert.deepEqual([final.expenseCount, final.totalCents, final.outboxCount, final.syncedDesktopRevisionId],
    [2, 2023, 1, reply.receipt.result_revision_id]);
  assert.equal(wireRows(), expectedWires);
  assert.equal(localRows(), localBytes);
  assert.equal(sql("SELECT revision_id,desktop_revision_id FROM revisions ORDER BY seq"), [
    `${ctx.current_revision_id}|${ctx.current_revision_id}`,
    `${first.result_revision_id}|${reply.receipt.result_revision_id}`,
    `${second.result_revision_id}|`,
  ].join("\n"));
  assert.deepEqual(inspect(), desktopAfterCommit);
  console.log(JSON.stringify({ upgradedFrom: "e9d303e8073efbf7631aecfd206f776b2a20eecb", schema: "2 -> 3",
    frozenRawSha256: items.map(item => createHash("sha256").update(item.raw_command_json).digest("hex")),
    wireIntentDigests: items.map(item => item.intent_sha256), desktopRevision: final.syncedDesktopRevisionId,
    secondResponse: rejected.error, mobileCents: final.totalCents, pending: final.outboxCount,
    mobileRevisions: final.revisionCount, desktopCents: desktopAfterCommit.head_paid_cents }));
}
