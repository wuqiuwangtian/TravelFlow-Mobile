// 在新目录生成候选运行时工程；不安装SDK、不接受许可、不依赖电脑端仓库。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "prototypes/android-runtime");
const args = process.argv.slice(2);
const options = new Map();
const usage = "Usage: prepare-android-probe.mjs --output NEW_DIRECTORY [--tls-fixtures FIXTURE_DIRECTORY] [--target emulator|usb] [--transport-probe platform|okhttp]";
for (let i = 0; i < args.length; i += 2) {
  if (!["--output", "--tls-fixtures", "--target", "--transport-probe"].includes(args[i]) || options.has(args[i]) ||
      !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(usage);
  options.set(args[i], args[i + 1]);
}
const hosts = {emulator: "10.0.2.2", usb: "127.0.0.1"};
const target = options.get("--target") ?? "emulator";
const transportProbe = options.get("--transport-probe") ?? "platform";
if (!options.has("--output") || !Object.hasOwn(hosts, target) || !["platform", "okhttp"].includes(transportProbe) ||
    (transportProbe === "okhttp" && (target !== "emulator" || !options.has("--tls-fixtures")))) throw new Error(usage);
const probeHost = hosts[target];
let testCa;
if (options.has("--tls-fixtures")) {
  const fixtures = path.resolve(options.get("--tls-fixtures"));
  const relative = path.relative(root, fixtures);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("TLS fixtures must be outside the repository");
  const manifest = JSON.parse(readFileSync(path.join(fixtures, "fixture.json"), "utf8"));
  testCa = readFileSync(path.join(fixtures, "ca.pem"));
  if (manifest.kind !== "travelflow-synthetic-tls-v1" || (manifest.host ?? hosts.emulator) !== probeHost ||
      (manifest.transportProbe ?? "platform") !== transportProbe ||
      (transportProbe === "okhttp" && manifest.dnsHost !== "valid.p0-dns.invalid") ||
      createHash("sha256").update(testCa).digest("hex") !== manifest.ca_sha256 ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(testCa.toString("utf8"))) {
    throw new Error("Invalid synthetic TLS fixture");
  }
}
const output = path.resolve(options.get("--output"));
if (existsSync(output)) throw new Error("Output directory must not already exist");
mkdirSync(output, { recursive: true });
for (const name of ["package.json", "pnpm-lock.yaml", "capacitor.config.json"]) {
  cpSync(path.join(source, name), path.join(output, name));
}

function run(command, parameters) {
  const result = spawnSync(command, parameters, { cwd: output, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated command failed: ${command}`);
}

if (process.platform === "win32") {
  // 命令固定；用户路径只通过cwd传递，不拼进shell。
  run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm install --frozen-lockfile --ignore-scripts"]);
} else {
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
}
const www = path.join(output, "www");
mkdirSync(www);
for (const name of ["index.html", "bootstrap.js", "probe.js"]) cpSync(path.join(source, name), path.join(www, name));
writeFileSync(path.join(www, "probe-endpoint.js"), `export const probeHost = ${JSON.stringify(probeHost)};\n`);
for (const name of ["tokens.css", "components.css"]) cpSync(path.join(root, "vendor/design", name), path.join(www, name));
cpSync(path.join(output, "node_modules/@capacitor/core/dist/index.js"), path.join(www, "capacitor-core.js"));
cpSync(path.join(output, "node_modules/@capacitor/core/LICENSE"), path.join(www, "CAPACITOR-LICENSE.txt"));
writeFileSync(path.join(www, "ledger-core.js"), ts.transpileModule(
  readFileSync(path.join(root, "src/domain/ledger.ts"), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText);

const cli = path.join(output, "node_modules/@capacitor/cli/bin/capacitor");
run(process.execPath, [cli, "add", "android"]);
const java = path.join(output, "android/app/src/main/java/org/travelflow/p0");
const appGradle = path.join(output, "android/app/build.gradle");
writeFileSync(appGradle, readFileSync(appGradle, "utf8") + "\nandroid { buildFeatures { buildConfig = true } }\n");
for (const name of ["MainActivity.java", "ProbeStorePlugin.java", "ProbeStreamPlugin.java", "ProbeCredentials.java"]) cpSync(path.join(source, name), path.join(java, name));
if (transportProbe === "okhttp") {
  const experimental = path.join(output, "android/app/src/debug/java/org/travelflow/p0");
  mkdirSync(experimental, {recursive: true});
  for (const name of ["ProbeAsyncStreamPlugin.java", "CancelableDnsLookup.java", "SystemDnsLookup.java", "SystemDnsWorkerService.java"]) {
    cpSync(path.join(root, "prototypes/okhttp-probe", name), path.join(experimental, name));
  }
  writeFileSync(path.join(output, "android/app/src/debug/AndroidManifest.xml"), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/><application><service android:name="org.travelflow.p0.SystemDnsWorkerService" android:exported="false" android:process=":p0_dns"/></application></manifest>\n');
  const notices = path.join(output, "android/app/src/debug/assets/third-party");
  mkdirSync(notices, {recursive: true});
  cpSync(path.join(root, "prototypes/okhttp-probe/LICENSE.txt"), path.join(notices, "okhttp-apache-2.0.txt"));
  cpSync(path.join(root, "prototypes/okhttp-probe/NOTICE.txt"), path.join(notices, "okhttp-notice.txt"));
  cpSync(path.join(root, "prototypes/okhttp-probe/MINIDNS-LICENCE.txt"), path.join(notices, "minidns-licence.txt"));
  writeFileSync(appGradle, readFileSync(appGradle, "utf8") + `
def dnsCodecVersion = "org.minidns:minidns-core:1.1.1"
configurations { dnsCodecCheck }
dependencies {
    debugImplementation("com.squareup.okhttp3:okhttp-android:5.3.2")
    debugImplementation(dnsCodecVersion)
    dnsCodecCheck(dnsCodecVersion)
}
tasks.register("exportDnsCodec", Copy) {
    from(configurations.dnsCodecCheck) { include "minidns-core-1.1.1.jar" }
    into(layout.buildDirectory.dir("probe-deps"))
}
`);
  const activity = path.join(java, "MainActivity.java");
  writeFileSync(activity, readFileSync(activity, "utf8").replace("        super.onCreate(savedInstanceState);", `        if (BuildConfig.DEBUG) {
            try {
                registerPlugin(Class.forName("org.travelflow.p0.ProbeAsyncStreamPlugin").asSubclass(com.getcapacitor.Plugin.class));
            } catch (ClassNotFoundException error) { throw new IllegalStateException("Missing experimental debug plugin", error); }
        }
        super.onCreate(savedInstanceState);`));
}
writeFileSync(path.join(java, "ProbeEndpoint.java"), `package org.travelflow.p0;\nfinal class ProbeEndpoint {\n    static final String HOST = ${JSON.stringify(probeHost)};\n    private ProbeEndpoint() {}\n}\n`);
const manifest = path.join(output, "android/app/src/main/AndroidManifest.xml");
writeFileSync(manifest, readFileSync(manifest, "utf8").replace('android:allowBackup="true"',
  'android:allowBackup="false" android:networkSecurityConfig="@xml/p0_network_security"'));
const mainXml = path.join(output, "android/app/src/main/res/xml");
mkdirSync(mainXml, { recursive: true });
writeFileSync(path.join(mainXml, "p0_network_security.xml"), '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/></trust-anchors></base-config></network-security-config>\n');
// 仅debug测试服务可用明文；默认与release仍拒绝明文流量。
const debug = path.join(output, "android/app/src/debug");
mkdirSync(path.join(debug, "res/xml"), { recursive: true });
if (testCa) {
  mkdirSync(path.join(debug, "res/raw"), { recursive: true });
  writeFileSync(path.join(debug, "res/raw/p0_test_ca.pem"), testCa);
}
const anchors = testCa ? '<trust-anchors><certificates src="system"/><certificates src="@raw/p0_test_ca"/></trust-anchors>' : '';
const dnsPolicy = transportProbe === "okhttp" ? `<domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="false">valid.p0-dns.invalid</domain>${anchors}</domain-config>` : "";
writeFileSync(path.join(debug, "res/xml/p0_network_security.xml"), `<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">${probeHost}</domain>${anchors}</domain-config>${dnsPolicy}</network-security-config>\n`);
console.log(JSON.stringify({
  project: output,
  appId: "org.travelflow.p0",
  target,
  transportProbe,
  probeHost,
  phase: "prepared_only",
  sdkInstalledByThisCommand: false,
  apkBuilt: false,
  syntheticCaInDebugOnly: Boolean(testCa),
  note: "Requires an approved Android SDK and JDK21 before build; no emulator/device test yet.",
}, null, 2));
