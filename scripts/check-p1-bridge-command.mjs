// 宿主只读校验：验证 P1 桥接 TS 命令构造与规范化字节输出同既有 p1-canonical 候选完全一致。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { fingerprintIntent } from "../prototypes/p1-canonical/intent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandTsPath = path.join(root, "prototypes/p1-bridge-receipt/web/bridge-command.ts");

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "travelflow-p1-bridge-cmd-"));
try {
  const transpiled = ts.transpileModule(readFileSync(commandTsPath, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: "bridge-command.ts",
    reportDiagnostics: true,
  });
  assert.equal(transpiled.diagnostics?.length ?? 0, 0, "bridge-command.ts transpile diagnostics");
  const compiledPath = path.join(tmpDir, "bridge-command.mjs");
  writeFileSync(compiledPath, transpiled.outputText);

  const mod = await import(pathToFileURL(compiledPath).href);
  const opId = "op-bridge-fixture-001";
  const patchIntent = mod.buildExpensePatchIntent({
    operationId: opId,
    expectedRevision: 2,
    amountCents: 842,
    notes: "p1-bridge-correction:before-commit:842",
  });
  const tsControlCanonical = mod.canonicalizeControlDocument(patchIntent);
  const p1Control = fingerprintIntent(Buffer.from(JSON.stringify(patchIntent), "utf8"), "control");
  assert.equal(p1Control.accepted, true);
  assert.equal(tsControlCanonical, p1Control.canonical_json);
  assert.equal(
    createHash("sha256").update(tsControlCanonical, "utf8").digest("hex"),
    p1Control.sha256,
  );

  const queryIntent = mod.buildReceiptLookupIntent(opId);
  const tsQueryCanonical = mod.canonicalizeQueryDocument(queryIntent);
  const p1Query = fingerprintIntent(Buffer.from(JSON.stringify(queryIntent), "utf8"), "receipt-query");
  assert.equal(p1Query.accepted, true);
  assert.equal(tsQueryCanonical, p1Query.canonical_json);
  assert.equal(
    createHash("sha256").update(tsQueryCanonical, "utf8").digest("hex"),
    p1Query.sha256,
  );

  for (const invalidRaw of ["", "0", "-1", "842.9", "1e3", "1E3", "0842", " 842", "842 ", "842px", "10000000000"]) {
    assert.throws(() => mod.parseStrictAmountCents(invalidRaw), `Expected rejection for ${JSON.stringify(invalidRaw)}`);
  }

  const boundaryDigests = {};
  for (const [label, raw, expected] of [
    ["int32_max", "2147483647", 2147483647],
    ["int32_over", "2147483648", 2147483648],
    ["max_cents", "9999999999", 9999999999],
  ]) {
    const parsed = mod.parseStrictAmountCents(raw);
    assert.equal(parsed, expected);
    const intent = mod.buildExpensePatchIntent({
      operationId: `op-bridge-${label}`,
      expectedRevision: 2,
      amountCents: parsed,
      notes: `p1-bridge-boundary:${label}`,
    });
    const tsCanon = mod.canonicalizeControlDocument(intent);
    const p1Canon = fingerprintIntent(Buffer.from(JSON.stringify(intent), "utf8"), "control");
    assert.equal(p1Canon.accepted, true);
    assert.equal(tsCanon, p1Canon.canonical_json);
    assert.equal(JSON.parse(tsCanon).intent.payload.amount_cents, expected);
    boundaryDigests[label] = p1Canon.sha256;
  }

  assert.throws(() => mod.buildExpensePatchIntent({
    operationId: opId,
    expectedRevision: 2,
    amountCents: 0,
    notes: "invalid",
  }));
  assert.throws(() => mod.buildExpensePatchIntent({
    operationId: opId,
    expectedRevision: 2,
    amountCents: 10000000000,
    notes: "invalid",
  }));
  assert.throws(() => mod.buildExpensePatchIntent({
    operationId: "",
    expectedRevision: 2,
    amountCents: 842,
    notes: "invalid",
  }));

  const desktopFixtureBytes = readFileSync(path.join(root, "docs/internal/fixtures/p1-desktop-expense-create.json"));
  assert.equal(
    createHash("sha256").update(desktopFixtureBytes).digest("hex"),
    "da9a97398ebb1e0e3b8e0e17097a8f8bc79da25602f6e7a119800572341a7b3f",
  );
  const desktopFixture = JSON.parse(desktopFixtureBytes.toString("utf8"));
  const createCanon = mod.canonicalizeControlDocument(desktopFixture.command);
  const createSha = createHash("sha256").update(createCanon, "utf8").digest("hex");
  assert.equal(createSha, "e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd");
  const createQueryCanon = mod.canonicalizeQueryDocument(desktopFixture.receipt_query);
  const createQuerySha = createHash("sha256").update(createQueryCanon, "utf8").digest("hex");
  assert.equal(createQuerySha, "6eae8c5e2bbda98cd3e7dab4858f6d573f8593698ce3c9ce97ffee3f45ea8315");

  for (const [bad, expectedErr] of [[0, "integer_range"], [true, "type"], [1.25, "integer_range"], [10000000000, "integer_range"]]) {
    assert.deepEqual(mod.validateExpenseCreateAmount(bad), { ok: false, error: expectedErr });
  }

  console.log(JSON.stringify({
    passed: true,
    controlCanonicalSha256: p1Control.sha256,
    queryCanonicalSha256: p1Query.sha256,
    desktopCreateCommandSha256: createSha,
    desktopCreateQuerySha256: createQuerySha,
    boundaryDigests,
    shared_contract_version: null,
    android_native_executed: false,
  }, null, 2));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
