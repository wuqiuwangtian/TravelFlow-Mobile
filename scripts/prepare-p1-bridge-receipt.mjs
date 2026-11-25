// 在仓库外新目录生成 P1 桥接消费更正与回执恢复的隔离 Capacitor 8.6.0 Android 工程。
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p0Runtime = path.join(root, "prototypes/android-runtime");
const bridgeSource = path.join(root, "prototypes/p1-bridge-receipt");

const args = process.argv.slice(2);
const usage = "Usage: prepare-p1-bridge-receipt.mjs --output NEW_DIRECTORY [--trip-context FILE]";
if (!(args.length === 2 || (args.length === 4 && args[2] === "--trip-context")) || args[0] !== "--output" || !args[1] || args[1].startsWith("--")) {
  throw new Error(usage);
}

const output = path.resolve(args[1]);
const relative = path.relative(root, output);
if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
  throw new Error("Output directory must be outside the repository");
}
if (existsSync(output)) {
  throw new Error("Output directory must not already exist");
}

mkdirSync(output, { recursive: true });
for (const name of ["package.json", "pnpm-lock.yaml"]) {
  cpSync(path.join(p0Runtime, name), path.join(output, name));
}
cpSync(path.join(bridgeSource, "capacitor.config.json"), path.join(output, "capacitor.config.json"));

function run(command, parameters) {
  const result = spawnSync(command, parameters, { cwd: output, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated command failed: ${command} ${parameters.join(" ")}`);
}

if (process.platform === "win32") {
  run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm install --frozen-lockfile --ignore-scripts"]);
} else {
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
}

const www = path.join(output, "www");
mkdirSync(www);
cpSync(path.join(bridgeSource, "web/index.html"), path.join(www, "index.html"));
const createFixturePath = path.join(root, "docs/internal/fixtures/p1-desktop-expense-create.json");
const createFixtureBytes = readFileSync(createFixturePath);
if (createHash("sha256").update(createFixtureBytes).digest("hex") !== "da9a97398ebb1e0e3b8e0e17097a8f8bc79da25602f6e7a119800572341a7b3f") {
  throw new Error("Pinned p1-desktop-expense-create.json digest mismatch");
}
writeFileSync(path.join(www, "p1-desktop-expense-create.json"), createFixtureBytes);
// Package only the public scope of the isolated desktop trip (never host file paths).
let tripSeed = null;
if (args[3]) {
  const ctx = JSON.parse(readFileSync(args[3], "utf8"));
  const ids = [ctx.dataset_id, ctx.travel_id, ctx.branch_id, ctx.current_revision_id];
  if (ctx.handoff_format !== "travelflow-p3-trip-handoff/0-draft" ||
      ctx.contract_id !== "travelflow.expense-create" || ctx.contract_version !== "0.1.0" ||
      !Array.isArray(ctx.authorized_devices) || ctx.authorized_devices.length !== 1 ||
      ![...ids, ctx.authorized_devices[0]].every(id => typeof id === "string" && id.length > 0)) {
    throw new Error("Invalid isolated init-trip context");
  }
  tripSeed = { datasetId: ctx.dataset_id, travelId: ctx.travel_id, branchId: ctx.branch_id,
    initialRevisionId: ctx.current_revision_id, sourceDeviceId: ctx.authorized_devices[0], baselineSource: "desktop init-trip" };
}
writeFileSync(path.join(www, "offline-trip-seed.json"), JSON.stringify(tripSeed));
for (const name of ["tokens.css", "components.css"]) {
  cpSync(path.join(root, "vendor/design", name), path.join(www, name));
}
cpSync(path.join(output, "node_modules/@capacitor/core/dist/index.js"), path.join(www, "capacitor-core.js"));
cpSync(path.join(output, "node_modules/@capacitor/core/LICENSE"), path.join(www, "CAPACITOR-LICENSE.txt"));

function transpileTs(sourcePath, targetPath) {
  const result = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    fileName: path.basename(sourcePath),
    reportDiagnostics: true,
  });
  if (result.diagnostics?.length) {
    throw new Error(`TypeScript transpile failed for ${sourcePath}: ${result.diagnostics.map((d) => d.messageText).join("; ")}`);
  }
  writeFileSync(targetPath, result.outputText);
}

transpileTs(path.join(root, "src/domain/ledger.ts"), path.join(www, "ledger-core.js"));
transpileTs(path.join(bridgeSource, "web/bridge-command.ts"), path.join(www, "bridge-command.js"));
transpileTs(path.join(bridgeSource, "web/bridge-app.ts"), path.join(www, "bridge-app.js"));

const cli = path.join(output, "node_modules/@capacitor/cli/bin/capacitor");
run(process.execPath, [cli, "add", "android"]);

const javaDir = path.join(output, "android/app/src/main/java/org/travelflow/p1bridge");
mkdirSync(javaDir, { recursive: true });
for (const name of [
  "MainActivity.java",
  "BridgeLedgerStore.java",
  "BridgeCreateLedgerStore.java",
  "OfflineTripLedgerStore.java",
  "BridgeLockHolderProvider.java",
  "P1BridgeReceiptPlugin.java",
]) {
  cpSync(path.join(bridgeSource, "native", name), path.join(javaDir, name));
}

const variablesGradle = path.join(output, "android/variables.gradle");
if (existsSync(variablesGradle)) {
  const updatedVariables = readFileSync(variablesGradle, "utf8").replace(
    /minSdkVersion\s*=\s*\d+/,
    "minSdkVersion = 28",
  );
  writeFileSync(variablesGradle, updatedVariables);
}

const manifestPath = path.join(output, "android/app/src/main/AndroidManifest.xml");
let manifest = readFileSync(manifestPath, "utf8");
if (!manifest.includes('android:allowBackup="true"')) {
  throw new Error("Expected Capacitor template allowBackup attribute in AndroidManifest.xml");
}
manifest = manifest.replace('android:allowBackup="true"', 'android:allowBackup="false"');
const providerXml =
  '        <provider android:name=".BridgeLockHolderProvider" android:authorities="org.travelflow.p1bridge.writer" android:exported="false" android:process=":writer" />\n    </application>';
if (!manifest.includes("</application>")) {
  throw new Error("Expected </application> tag in AndroidManifest.xml");
}
manifest = manifest.replace("</application>", providerXml);
writeFileSync(manifestPath, manifest);

console.log(JSON.stringify({
  project: output,
  appId: "org.travelflow.p1bridge",
  phase: "prepared_only",
  capacitorVersion: "8.6.0",
  sdkInstalledByThisCommand: false,
  apkBuilt: false,
}, null, 2));
