// 只报告当前隔离Android WebView的实际能力；不把功能检测当作旧设备实测。
import assert from "node:assert/strict";
import { connectProbe } from "./lib/android-probe-cdp.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--port") {
  throw new Error("Usage: node scripts/check-android-compat.mjs --port FORWARDED_CDP_PORT");
}
const page = await connectProbe(args[1]);
try {
  // 诊断表达式使用较旧语法，避免检查器本身依赖被检查的新语法。
  const report = await page.evaluate(`(function () {
    var features = {};
    features.esModules = 'noModule' in document.createElement('script');
    features.secureContext = window.isSecureContext === true;
    features.randomUUID = !!(window.crypto && typeof window.crypto.randomUUID === 'function');
    features.cryptoRandomValues = !!(window.crypto && typeof window.crypto.getRandomValues === 'function');
    features.promise = typeof Promise === 'function';
    features.map = typeof Map === 'function';
    try {
      features.optionalChaining = new Function('var x = {a: 1}; return x?.a === 1;')();
    } catch (error) { features.optionalChaining = false; }
    features.cssVariables = !!(window.CSS && CSS.supports('color', 'var(--tf-ink)'));
    var style = document.createElement('style');
    style.textContent = '@layer tf_compat_probe { .tf-compat-probe { color: red; } }';
    document.head.appendChild(style);
    try {
      var rules = style.sheet.cssRules;
      features.cssLayers = rules.length === 1 && !!rules[0].cssRules && rules[0].cssText.indexOf('@layer') === 0;
    } catch (error) { features.cssLayers = false; }
    style.parentNode.removeChild(style);
    var enhancements = {
      colorMix: !!(window.CSS && CSS.supports('color', 'color-mix(in srgb, red, blue)')),
      individualScale: !!(window.CSS && CSS.supports('scale', '1'))
    };
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      nativeAndroid: !!(window.Capacitor && typeof window.Capacitor.getPlatform === 'function' && window.Capacitor.getPlatform() === 'android'),
      runtime: document.getElementById('runtime').textContent,
      viewport: {width: innerWidth, layoutWidth: document.documentElement.clientWidth,
        visualWidth: window.visualViewport ? visualViewport.width : innerWidth,
        contentWidth: document.documentElement.scrollWidth},
      features: features,
      enhancements: enhancements
    };
  })()`);
  const missing = Object.entries(report.features).filter(([, supported]) => !supported).map(([name]) => name);
  if (report.nativeAndroid && missing.length === 0 && report.runtime === "正在检查原生环境…") {
    try {
      await page.until(`document.getElementById('runtime').textContent !== '正在检查原生环境…'`);
    } catch { /* 保留初始化失败的实际状态，仍输出诊断报告。 */ }
    report.runtime = await page.evaluate("document.getElementById('runtime').textContent");
  }
  const passed = report.nativeAndroid && report.runtime === "Android原生桥已就绪" && missing.length === 0;
  console.log(JSON.stringify({passed, scope: "current_webview_only", missing, ...report}, null, 2));
  assert.ok(passed, "Current artifact requires missing capabilities or native runtime is not ready; no older-device support inferred");
} finally { page.close(); }
