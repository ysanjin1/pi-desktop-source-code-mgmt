/**
 * 加载契约测试：按宿主「加载一个插件」时实际会检查/执行的顺序跑一遍。
 *
 * 规则来源：从 E:\PI-Desktop\resources\app.asar 里读到的真实校验代码与 IPC 清单
 * （PLUGIN_VIEW_ICONS 白名单、contributes.views 的 id 正则与 entry 存在性、
 *  manifest.fs.root 只允许 workspace|userSelected、onLoad 15s / 其它钩子 5s 超时、
 *  通道未知时返回错误而不是抛异常）。这里把这些规则重写成断言 —— 注意：这是
 * 「按宿主规则重实现的检查」，不是宿主的校验器本身。
 *
 * 跑法：node tests/load-contract.test.mjs
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const require = createRequire(import.meta.url);

// 宿主白名单（摘自 app.asar 的 PLUGIN_VIEW_ICONS）
const VIEW_ICONS = [
  "bell", "book", "bot", "branch", "browser", "chat", "clock", "diff", "files", "folder", "image",
  "key", "link", "list-checks", "palette", "plug", "pull-request", "search", "server", "shield",
  "sparkles", "target", "terminal", "workflow", "wrench",
];
const KNOWN_PERMISSIONS = [
  "ui.view", "ui.panel", "ui.theme", "notify", "fs.read", "fs.write", "fs.delete",
  "clipboard.read", "clipboard.write", "shell.openExternal", "net.fetch", "agent.tool.register",
  "agent.prompt.inject", "agent.complete", "agent.extension", "background.service", "bus.publish",
  "bus.subscribe", "models.list", "usage.read", "session.read", "renderer.extension",
  "browser.cdp", "desktop.control", "keyboard.globalShortcut", "mcp.server.local", "mcp.server.remote",
];
const APP_VERSION = "0.21.0";

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: (error && error.message) || String(error) });
  }
}

const manifest = JSON.parse(fsSync.readFileSync(path.join(root, "manifest.json"), "utf8"));
const isRelativeNoEscape = (p) => typeof p === "string" && p.trim() !== "" && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..");

function semverSatisfied(range, version) {
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  if (!m) return false;
  const want = m.slice(1).map(Number);
  const got = String(version).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > want[i]) return true;
    if (got[i] < want[i]) return false;
  }
  return true;
}

// ── 清单层（宿主 install/loadDev 第一步就会拒绝的东西） ─────────────────────

await test("schemaVersion = 1，id 合法且带 local. 前缀", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.id, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  assert.ok(manifest.id.startsWith("local."), "个人插件应以 local. 开头");
});

await test("必填字段齐全：name / version / main", () => {
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.trim());
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.main, "string");
});

await test("main 指向真实存在的文件", () => {
  assert.ok(isRelativeNoEscape(manifest.main), "main 必须是相对路径且不含 ..");
  assert.equal(fsSync.existsSync(path.join(root, manifest.main)), true);
});

await test("权限名都在宿主白名单内，且没有多要", () => {
  for (const p of manifest.permissions) assert.ok(KNOWN_PERMISSIONS.includes(p), `未知权限：${p}`);
  assert.deepEqual([...manifest.permissions].sort(), ["agent.tool.register", "fs.read", "ui.view"]);
});

await test("manifest.fs.read.root 只能是 workspace 或 userSelected（宿主硬校验）", () => {
  const rule = manifest.fs && manifest.fs.read;
  assert.ok(rule, "声明了 fs.read 就必须有 manifest.fs.read");
  assert.ok(["workspace", "userSelected"].includes(rule.root), `不允许的 root：${rule.root}`);
  if (rule.root === "userSelected") assert.equal(rule.scope, undefined, "userSelected 不需要 scope");
});

await test("engines 对本机 PI-Desktop 0.21.0 成立", () => {
  assert.ok(semverSatisfied(manifest.engines.piDesktop, APP_VERSION), `${manifest.engines.piDesktop} 不满足 ${APP_VERSION}`);
});

await test("activationEvents 只含 onStartup（视图型插件不需要 onCommand）", () => {
  assert.deepEqual(manifest.activationEvents, ["onStartup"]);
});

await test("视图声明：id 正则、必含 title、icon 在白名单、entry 相对且存在", () => {
  const views = manifest.contributes.views;
  assert.ok(Array.isArray(views) && views.length === 1);
  const view = views[0];
  assert.match(view.id, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "view id 必须匹配 [a-zA-Z][a-zA-Z0-9_-]{0,63}");
  assert.ok(view.title && typeof view.title === "object" && view.title.en && view.title["zh-CN"], "title 需要 en 与 zh-CN");
  assert.ok(VIEW_ICONS.includes(view.icon), `icon "${view.icon}" 不在宿主白名单里`);
  assert.ok(isRelativeNoEscape(view.entry));
  assert.equal(fsSync.existsSync(path.join(root, view.entry)), true, "view entry 文件必须存在");
});

await test("视图自身的资源引用都存在（scm.js / scm.css）", () => {
  const html = fsSync.readFileSync(path.join(root, "views", "index.html"), "utf8");
  for (const ref of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
    if (/^(https?:|data:)/.test(ref)) continue;
    const target = path.join(root, "views", ref.replace(/^\.\//, ""));
    assert.equal(fsSync.existsSync(target), true, `视图引用了不存在的文件：${ref}`);
  }
});

// ── 入口模块层（宿主在独立进程里执行 main.js 后做的事） ─────────────────────

const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "scm-load-"));
const tmpHome = path.join(tmpRoot, "home");
fsSync.mkdirSync(tmpHome, { recursive: true });
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const moduleExports = require(path.join(root, "main.js"));

await test("入口导出 onLoad / onUnload / onPanelInvoke 三个函数", () => {
  assert.equal(typeof moduleExports.onLoad, "function");
  assert.equal(typeof moduleExports.onUnload, "function");
  assert.equal(typeof moduleExports.onPanelInvoke, "function");
});

// 宿主会注入全局 pi；这里给一个最小替身
globalThis.pi = {
  plugin: { getDataPath: async () => path.join(tmpRoot, "data"), getSettings: async () => ({}) },
  workspace: { get: async () => null },
  fs: { requestDirectory: async () => null },
};

await test("onLoad 在 15s 内完成且不抛（宿主超时会回滚整次加载）", async () => {
  const started = Date.now();
  await moduleExports.onLoad();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `onLoad 用了 ${elapsed}ms`);
});

await test("每个通道都返回 Promise、都带 ok 字段、都不抛异常", async () => {
  const channels = Object.keys(moduleExports.internals ? {} : {}); // 占位，下面直接列
  const table = [
    "scm.hello", "scm.env", "scm.prefs.get", "scm.prefs.set", "scm.ssh.status",
    "scm.ssh.genkey", "scm.ssh.writeConfig", "scm.ssh.test", "scm.gitee.token.status",
    "scm.gitee.token.set", "scm.gitee.token.clear", "scm.repos.list", "scm.clone.run",
    "scm.clone.status", "scm.pickDir",
  ];
  assert.equal(channels.length, 0);
  for (const channel of table) {
    const p = moduleExports.onPanelInvoke(channel, {});
    assert.equal(typeof p.then, "function", `${channel} 必须返回 Promise`);
    const res = await p; // 不抛就等于通过
    assert.equal(typeof res, "object", `${channel} 必须返回对象`);
    assert.ok("ok" in res, `${channel} 的返回值缺少 ok 字段`);
  }
});

await test("未知通道返回 UNSUPPORTED，而不是抛异常或挂住", async () => {
  const res = await moduleExports.onPanelInvoke("scm.does-not-exist", {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "UNSUPPORTED");
});

await test("载荷缺失/乱传不会让通道抛（面板第一次渲染就会这么调）", async () => {
  for (const channel of ["scm.prefs.set", "scm.clone.run", "scm.ssh.test", "scm.gitee.token.set"]) {
    const res = await moduleExports.onPanelInvoke(channel, undefined);
    assert.equal(typeof res, "object");
    assert.ok("ok" in res);
  }
});

await test("onUnload 在 5s 内完成且可重复调用", async () => {
  const started = Date.now();
  await moduleExports.onUnload();
  await moduleExports.onUnload();
  assert.ok(Date.now() - started < 5000);
});

fsSync.rmSync(tmpRoot, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed / ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed（加载契约）`);
