// 显式从固定Git提交导入；构建和校验不需要电脑仓库或网络。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === "--source" && args[2] === "--commit", "Usage: import-contract.mjs --source DESKTOP_REPO --commit FULL_SHA");
const revision = args[3];
assert(/^[a-f0-9]{40}$/.test(revision), "A full immutable commit SHA is required");
const upstream = path.resolve(args[1]);
const prefix = "contracts/ledger-v1";
const read = name => execFileSync("git", ["-C", upstream, "show", `${revision}:${prefix}/${name}`], { maxBuffer: 1024 * 1024 });
const digest = data => createHash("sha256").update(data).digest("hex");
const raw = read("manifest.json");
const manifest = JSON.parse(raw);
assert.equal(manifest.contract_id, "travelflow.ledger-projection");
assert.equal(manifest.contract_version, "0.1.0");
assert.deepEqual(Object.keys(manifest.files).sort(), ["SPEC.md", "ledger-vectors.json"]);
const files = new Map([["manifest.json", raw]]);
for (const [name, expected] of Object.entries(manifest.files)) {
  const data = read(name);
  assert.equal(digest(data), expected, `Upstream contract drift: ${name}`);
  files.set(name, data);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "vendor/contracts/ledger-v1");
mkdirSync(target, { recursive: true });
for (const [name, data] of files) writeFileSync(path.join(target, name), data);
writeFileSync(path.join(root, "vendor/contracts/ORIGIN.json"), JSON.stringify({
  repository: "https://github.com/wuqiuwangtian/TravelFlow-AI",
  commit: revision,
  path: prefix,
  manifest_sha256: digest(raw),
}, null, 2) + "\n");
console.log(`Imported ledger contract 0.1.0 at ${revision}; review changes before committing.`);
