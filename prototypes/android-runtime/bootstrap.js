// 使用经典脚本和较旧语法，避免应用模块无法解析时一直显示“正在检查”。
(function () {
  function fail(reason) {
    document.getElementById("runtime").textContent = "当前WebView无法运行此实验，请更新系统WebView后重试。";
    document.getElementById("error").textContent = reason;
    // HTML中的按钮默认禁用；不读取、清空或改写本地数据。
  }

  var missing = [];
  if (!("noModule" in document.createElement("script"))) missing.push("ES模块");
  if (!window.isSecureContext) missing.push("安全上下文");
  if (!(window.crypto && typeof window.crypto.randomUUID === "function")) missing.push("随机操作标识");
  if (!(window.CSS && CSS.supports("color", "var(--tf-ink)"))) missing.push("CSS变量");
  var style = document.createElement("style");
  style.textContent = "@layer tf_boot_probe { .tf-boot-probe { color: red; } }";
  document.head.appendChild(style);
  try {
    var rules = style.sheet.cssRules;
    if (!(rules.length === 1 && rules[0].cssRules && rules[0].cssText.indexOf("@layer") === 0)) {
      missing.push("CSS层叠层");
    }
  } catch (error) {
    missing.push("CSS层叠层");
  }
  style.parentNode.removeChild(style);
  if (missing.length) {
    fail("缺少能力：" + missing.join("、") + "。本地记录尚未确认。");
    return;
  }

  var entry = document.createElement("script");
  entry.type = "module";
  entry.src = "./probe.js";
  entry.onerror = function () {
    fail("应用模块加载或解析失败。本地记录尚未确认。");
  };
  document.body.appendChild(entry);
})();
