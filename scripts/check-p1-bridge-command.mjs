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

  console.log(JSON.stringify({
    passed: true,
    controlCanonicalSha256: p1Control.sha256,
    queryCanonicalSha256: p1Query.sha256,
    boundaryDigests,
    shared_contract_version: null,
    android_native_executed: false,
  }, null, 2));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
