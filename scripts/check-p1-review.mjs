// 仅复核P1评审资料与现有只读计算，不实现写入、回执、同步或日期迁移。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv.length <= 3, "Usage: node scripts/check-p1-review.mjs [review.json]");
const inputPath = process.argv[2] ?? path.join(root, "docs/internal/fixtures/p1-review-cases.json");
const corpus = JSON.parse(readFileSync(inputPath, "utf8"));
assert.equal(corpus.review_format_version, 1, "Unknown review format (not a contract version)");
assert.equal(corpus.status, "review-draft", "This checker cannot approve a shared contract");
assert.equal(corpus.shared_contract_version, null, "A review corpus must not claim a contract version");
assert.deepEqual(corpus.acceptance, {
  desktop_joint_review: "pending", mobile_write_execution: "not-implemented",
}, "No joint review or write execution is established by this checker");
for (const key of ["desktop_commit", "mobile_design_baseline"]) {
  assert.match(corpus[key], /^[a-f0-9]{40}$/, `Pinned ${key} required`);
}
assert.equal(corpus.desktop_repository, "https://github.com/wuqiuwangtian/TravelFlow-AI");

const design = readFileSync(path.join(root, "docs/internal/P1_LOCAL_DATA_DESIGN.md"), "utf8");
const designIds = new Set([...design.matchAll(/^\| ([MDBHXTFV]\d+) \|/gm)].map(match => match[1]));
const ids = new Set();
function register(entry) {
  assert.match(entry.id, /^[A-Z]\d{2}$/);
  assert.ok(!ids.has(entry.id), `Duplicate review ID: ${entry.id}`);
  ids.add(entry.id);
  assert.ok(Array.isArray(entry.design_cases) && entry.design_cases.length > 0, `${entry.id}: design cases required`);
  for (const id of entry.design_cases) assert.ok(designIds.has(id), `${entry.id}: unknown design case ${id}`);
}
function nonempty(value, label) {
  assert.equal(typeof value, "string", `${label}: text required`);
  assert.ok(value.trim().length > 0, `${label}: empty text`);
}

assert.ok(Array.isArray(corpus.sources) && corpus.sources.length > 0);
const sourceIds = new Set();
for (const source of corpus.sources) {
  nonempty(source.id, "source ID");
  assert.ok(!sourceIds.has(source.id), `Duplicate source ID: ${source.id}`);
  sourceIds.add(source.id);
  if (source.path) {
    assert.match(source.blob_sha, /^[a-f0-9]{40}$/, `${source.id}: pinned blob required`);
    assert.ok(Array.isArray(source.symbols) && source.symbols.length > 0);
  } else {
    assert.equal(new URL(source.url).protocol, "https:");
    nonempty(source.scope, `${source.id}.scope`);
  }
}

const compiled = ts.transpileModule(readFileSync(path.join(root, "src/domain/ledger.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { summarizeLedger } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
for (const key of ["projection_cases", "calendar_cases", "clock_cases", "source_scenarios"]) {
  assert.ok(Array.isArray(corpus[key]) && corpus[key].length > 0, `${key}: cases required`);
}
for (const entry of corpus.projection_cases) {
  register(entry);
  const before = JSON.stringify(entry.input);
  assert.deepEqual(summarizeLedger(entry.input), entry.expected, `${entry.id}: read-only projection`);
  assert.equal(JSON.stringify(entry.input), before, `${entry.id}: input changed`);
}
for (const entry of corpus.calendar_cases) {
  register(entry);
  assert.match(entry.instant, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/, `${entry.id}: explicit offset required`);
  const instant = new Date(entry.instant);
  assert.ok(Number.isFinite(instant.getTime()), `${entry.id}: invalid instant`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: entry.time_zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant).map(part => [part.type, part.value]));
  assert.equal(`${parts.year}-${parts.month}-${parts.day}`, entry.expected_local_date, `${entry.id}: calendar calculation`);
}
for (const entry of corpus.clock_cases) {
  register(entry);
  assert.match(entry.start_time, /^([01]\d|2[0-3]):[0-5]\d$/);
  assert.ok(Number.isSafeInteger(entry.start_day_offset) && entry.start_day_offset >= 0 && entry.start_day_offset <= 60);
  assert.ok(Number.isSafeInteger(entry.duration_minutes) && entry.duration_minutes >= 1 && entry.duration_minutes <= 1440);
  const [hours, minutes] = entry.start_time.split(":").map(Number);
  const end = entry.start_day_offset * 1440 + hours * 60 + minutes + entry.duration_minutes;
  const clock = `${String(Math.floor(end % 1440 / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  assert.equal(clock, entry.expected_end_time, `${entry.id}: wall-clock arithmetic`);
  assert.equal(Math.floor(end / 1440), entry.expected_end_day_offset, `${entry.id}: day offset`);
}
for (const entry of corpus.source_scenarios) {
  register(entry);
  assert.ok(Array.isArray(entry.source_ids) && entry.source_ids.length > 0);
  for (const id of entry.source_ids) assert.ok(sourceIds.has(id), `${entry.id}: unknown source ${id}`);
  for (const key of ["given", "when", "source_reading", "proposal", "open_question"]) {
    nonempty(entry[key], `${entry.id}.${key}`);
  }
}

console.log(JSON.stringify({
  review_format_checked: 1,
  read_only_projection_cases: corpus.projection_cases.length,
  calendar_calculations: corpus.calendar_cases.length,
  wall_clock_calculations: corpus.clock_cases.length,
  source_scenarios_catalogued: corpus.source_scenarios.length,
  desktop_joint_review: "pending",
  python_backend_executed: false,
  mobile_write_scenarios_executed: 0,
  note: "Only corpus consistency and read-only calculations checked; source semantics, transactions, DST policy and migration are not executed.",
}, null, 2));
