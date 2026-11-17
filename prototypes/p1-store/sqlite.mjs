// Synthetic host experiment only. Never opens an application database.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { controlIntent, queryIntent, planIntent } from "../p1-boundary/commands.mjs";
import { entityType } from "../p1-boundary/families.mjs";
import { BoundaryError, require } from "../p1-boundary/input.mjs";

const PURPOSE = "TravelFlow synthetic P1 host experiment v1";
const INIT = Symbol("fixture-initialization");
const TABLES = ["fixture_branches", "fixture_revisions", "fixture_receipts", "fixture_outbox", "fixture_tombstones"];
// Node reports extended SQLite result codes; the low byte is the primary code.
const busy = error => Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 0xff);
const same = (left, right) => isDeepStrictEqual(left, right);
export class CommitResultUnknown extends Error {
  constructor(cause) { super("Synthetic commit result unknown", { cause }); this.code = "result_unknown"; }
}

export class SyntheticStore {
  #db; #scope;
  stats = { begins: 0, receipt_reads: 0, snapshot_reads: 0, committed_operations: 0 };

  static create(seed) {
    require(seed.dataset_id.startsWith("fixture-") && seed.travel_id.startsWith("fixture-") && seed.branch_id.startsWith("fixture-"), "synthetic_scope");
    const directory = mkdtempSync(path.join(tmpdir(), "travelflow-p1-store-"));
    try {
      writeFileSync(path.join(directory, "PURPOSE"), PURPOSE, { flag: "wx" });
      return new SyntheticStore(directory, { token: INIT, seed });
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  }

  constructor(directory, initialization = {}) {
    const real = realpathSync(directory);
    require(path.dirname(real) === realpathSync(tmpdir()) && path.basename(real).startsWith("travelflow-p1-store-"), "synthetic_path");
    require(readFileSync(path.join(real, "PURPOSE"), "utf8") === PURPOSE, "synthetic_marker");
    const filename = path.join(real, "synthetic.sqlite");
    require(initialization.token === INIT || existsSync(filename), "storage_missing");
    this.directory = real;
    this.#db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false });
    try {
      if (initialization.token === INIT) this.#initialize(initialization.seed);
      const metadata = this.#db.prepare("SELECT value FROM fixture_meta WHERE key='scope'").get();
      this.#scope = JSON.parse(metadata?.value ?? "null");
      require(this.#scope?.purpose === PURPOSE && this.#scope.format === 1 && this.#scope.dataset_id.startsWith("fixture-"), "synthetic_schema");
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;");
    } catch (error) { this.#db.close(); throw error; }
  }

  #initialize(seed) {
    this.#db.exec(`
      CREATE TABLE fixture_meta(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE fixture_revisions(id TEXT PRIMARY KEY NOT NULL, parent_id TEXT REFERENCES fixture_revisions(id), snapshot TEXT NOT NULL, stamp TEXT NOT NULL);
      CREATE TABLE fixture_branches(dataset TEXT NOT NULL, travel TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL REFERENCES fixture_revisions(id), snapshot TEXT NOT NULL,
        PRIMARY KEY(dataset,travel,branch));
      CREATE TABLE fixture_receipts(dataset TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, intent TEXT NOT NULL, result_revision TEXT NOT NULL REFERENCES fixture_revisions(id),
        effect TEXT NOT NULL CHECK(effect IN ('changed','no_change')), stamp TEXT NOT NULL, PRIMARY KEY(dataset,source,operation));
      CREATE TABLE fixture_outbox(seq INTEGER PRIMARY KEY, dataset TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, result_revision TEXT NOT NULL REFERENCES fixture_revisions(id),
        effect TEXT NOT NULL CHECK(effect IN ('changed','no_change')), UNIQUE(dataset,source,operation));
      CREATE TABLE fixture_tombstones(entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, deleted_revision TEXT NOT NULL REFERENCES fixture_revisions(id), PRIMARY KEY(entity_type,entity_id));
    `);
    const scope = { purpose: PURPOSE, format: 1, dataset_id: seed.dataset_id, travel_id: seed.travel_id, branch_id: seed.branch_id };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO fixture_meta VALUES('scope',?)").run(JSON.stringify(scope));
      this.#db.prepare("INSERT INTO fixture_revisions VALUES(?,NULL,?,?)").run(seed.revision_id, JSON.stringify(seed.state), "fixture-seed");
      this.#db.prepare("INSERT INTO fixture_branches VALUES(?,?,?,?,?)").run(seed.dataset_id, seed.travel_id, seed.branch_id, seed.revision_id, JSON.stringify(seed.state));
      this.#db.exec("COMMIT");
    } catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
  }

  #authorize(intent, principal, query = false) {
    require(principal?.authenticated === true && principal.dataset_id === this.#scope.dataset_id && intent.operation.dataset_id === this.#scope.dataset_id, "denied");
    if (query) require(principal.can_query === true && (intent.operation.source_device_id === principal.source_device_id || principal.read_sources?.includes(intent.operation.source_device_id)), "denied");
    else require(principal.can_write === true && principal.source_device_id === intent.operation.source_device_id
      && intent.target.travel_id === this.#scope.travel_id && intent.target.branch_id === this.#scope.branch_id, "denied");
  }

  #branch() {
    const row = this.#db.prepare("SELECT head,snapshot FROM fixture_branches WHERE dataset=? AND travel=? AND branch=?")
      .get(this.#scope.dataset_id, this.#scope.travel_id, this.#scope.branch_id);
    if (!row) throw new Error("Synthetic authoritative branch missing");
    return { head: row.head, state: JSON.parse(row.snapshot) };
  }

  #snapshot(intent, branch) {
    this.stats.snapshot_reads++;
    const state = branch.state, id = intent.target.entity_id, type = entityType(intent.kind);
    const activity = state.activities.find(row => row.id === id) ?? null;
    const calendar = Array.isArray(state.calendars) ? state.calendars.find(row => row.day === activity?.day)
      : state.calendar?.day === activity?.day ? state.calendar : undefined;
    return { revision_id: branch.head, expense_count: state.expenses.length, adjustment_count: state.adjustments.length,
      expense: state.expenses.find(row => row.id === id) ?? null, adjustment: state.adjustments.find(row => row.id === id) ?? null,
      activity, calendar,
      deleted: !!this.#db.prepare("SELECT 1 FROM fixture_tombstones WHERE entity_type=? AND entity_id=?").get(type, id),
      links: { ...state.links, expenses: state.expenses, adjustments: state.adjustments,
        actual_activity_ids: state.activities.filter(row => !row.is_context_anchor).map(row => row.id) } };
  }

  execute(bytes, principal, options = {}) {
    let commitAttempted = false;
    try {
      const intent = controlIntent(bytes); this.#authorize(intent, principal);
      this.stats.begins++; this.#db.exec("BEGIN IMMEDIATE");
      this.stats.receipt_reads++;
      const receipt = this.#db.prepare("SELECT intent,result_revision,effect FROM fixture_receipts WHERE dataset=? AND source=? AND operation=?")
        .get(intent.operation.dataset_id, intent.operation.source_device_id, intent.operation.operation_id);
      if (receipt) {
        require(same(JSON.parse(receipt.intent), intent), "intent_conflict");
        this.#db.exec("COMMIT");
        return { accepted: true, kind: "committed", replayed: true, effect: receipt.effect, result_revision_id: receipt.result_revision };
      }
      const branch = this.#branch(), planned = planIntent(intent, this.#snapshot(intent, branch));
      const changed = planned.planned_business_revision === "new", stamp = options.stamp ?? new Date().toISOString();
      const revision = changed ? `fixture-${randomUUID()}` : branch.head;
      if (changed) {
        const state = branch.state, collection = planned.entity_type === "activity" ? "activities" : `${planned.entity_type}s`;
        const rows = state[collection], index = rows.findIndex(row => row.id === intent.target.entity_id);
        if (planned.action === "delete") rows.splice(index, 1);
        else {
          const entity = structuredClone(planned.candidate);
          if (planned.entity_type === "activity") { if (intent.kind === "progress.set") entity.progress_updated_at = stamp; }
          else { entity.updated_at = stamp; if (intent.kind.endsWith(".create")) entity.created_at = stamp; }
          if (index < 0) rows.push(entity); else rows[index] = entity;
        }
        const snapshot = JSON.stringify(state);
        this.#db.prepare("INSERT INTO fixture_revisions VALUES(?,?,?,?)").run(revision, branch.head, snapshot, stamp);
        this.#db.prepare("UPDATE fixture_branches SET head=?,snapshot=? WHERE dataset=? AND travel=? AND branch=?")
          .run(revision, snapshot, this.#scope.dataset_id, this.#scope.travel_id, this.#scope.branch_id);
        if (planned.action === "delete") this.#db.prepare("INSERT INTO fixture_tombstones VALUES(?,?,?)").run(planned.entity_type, intent.target.entity_id, revision);
      }
      options.fault?.("after_business");
      const effect = changed ? "changed" : "no_change";
      this.#db.prepare("INSERT INTO fixture_receipts VALUES(?,?,?,?,?,?,?)").run(intent.operation.dataset_id, intent.operation.source_device_id,
        intent.operation.operation_id, JSON.stringify(intent), revision, effect, stamp);
      options.fault?.("after_receipt");
      this.#db.prepare("INSERT INTO fixture_outbox(dataset,source,operation,result_revision,effect) VALUES(?,?,?,?,?)")
        .run(intent.operation.dataset_id, intent.operation.source_device_id, intent.operation.operation_id, revision, effect);
      options.fault?.("after_outbox"); options.fault?.("before_commit");
      commitAttempted = true; this.#db.exec("COMMIT"); this.stats.committed_operations++;
      options.fault?.("after_commit");
      return { accepted: true, kind: "committed", replayed: false, effect, result_revision_id: revision };
    } catch (error) {
      try { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); }
      catch (rollbackError) { throw new CommitResultUnknown(new AggregateError([error, rollbackError])); }
      if (commitAttempted) throw new CommitResultUnknown(error);
      if (error instanceof BoundaryError) return { accepted: false, error: error.code };
      if (busy(error)) return { accepted: false, error: "storage_busy" };
      throw error;
    }
  }

  query(bytes, principal) {
    try {
      const intent = queryIntent(bytes); this.#authorize(intent, principal, true);
      // A reserved read is used to distinguish a stable absence from a writer
      // currently owning the database. No business/receipt row is written.
      this.stats.begins++; this.#db.exec("BEGIN IMMEDIATE"); this.stats.receipt_reads++;
      const receipt = this.#db.prepare("SELECT result_revision,effect FROM fixture_receipts WHERE dataset=? AND source=? AND operation=?")
        .get(intent.operation.dataset_id, intent.operation.source_device_id, intent.operation.operation_id);
      this.#db.exec("COMMIT");
      return receipt ? { accepted: true, state: "committed", receipt: { effect: receipt.effect, result_revision_id: receipt.result_revision } }
        : { accepted: true, state: "not_found_at_settled_read" };
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      if (error instanceof BoundaryError) return { accepted: false, error: error.code };
      if (busy(error)) return { accepted: true, state: "unknown", reason: "storage_busy" };
      throw error;
    }
  }

  // All remaining accessors are explicitly for fixture evidence.
  inspectFixture() {
    return { ...this.#branch(), tables: Object.fromEntries(TABLES.map(table => [table, this.#db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) };
  }
  totalChanges() { return this.#db.prepare("SELECT total_changes() AS n").get().n; }
  sqliteVersion() { return this.#db.prepare("SELECT sqlite_version() AS version").get().version; }
  holdFixtureLock(work) { this.#db.exec("BEGIN IMMEDIATE"); try { return work(); } finally { this.#db.exec("ROLLBACK"); } }
  close() { this.#db.close(); }
}
