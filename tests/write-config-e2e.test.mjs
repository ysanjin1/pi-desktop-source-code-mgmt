/**
 * host 侧端到端：在**临时 HOME** 里真跑 onLoad + 面板通道。
 *
 * 为什么必须这么测：本插件唯一会写用户既有文件的地方就是 ~/.ssh/config。
 * 把 USERPROFILE/HOME 指向临时目录后再 require main.js，SSH_DIR 就落在临时目录里
 * —— 于是「首次创建 / 幂等 / 切端口就地改写 / 先备份 / 只动一个 Host 块」这些
 * 承诺都是被真实文件读写验过的，而且**全程不碰你真实的 ~/.ssh/config**。
 *
 * 跑法：node tests/write-config-e2e.test.mjs
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, "..");

// ── 先把 HOME 指到临时目录，再加载 main.js（模块顶层会计算 SSH_DIR） ──
const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "scm-home-"));
const tmpHome = path.join(tmpRoot, "home");
const dataDir = path.join(tmpRoot, "data");
fsSync.mkdirSync(tmpHome, { recursive: true });
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const require = createRequire(import.meta.url);
const main = require(path.join(pluginRoot, "main.js"));

const sshDir = path.join(tmpHome, ".ssh");
const configPath = path.join(sshDir, "config");

// 宿主替身：只提供本插件真正用到的那几个 API
globalThis.pi = {
  plugin: { getDataPath: async () => dataDir, getSettings: async () => ({}) },
  workspace: { get: async () => null },
  fs: { requestDirectory: async () => ({ path: path.join(tmpRoot, "picked") }) },
};

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

const invoke = (channel, payload) => main.onPanelInvoke(channel, payload);
const hostLineCount = (text, alias) =>
  text.split(/\r?\n/).filter((line) => new RegExp(`^\\s*Host\\s+.*\\b${alias}\\b`, "i").test(line)).length;
const backups = () => (fsSync.existsSync(sshDir) ? fsSync.readdirSync(sshDir).filter((n) => n.includes(".bak-")) : []);

await main.onLoad();

await test("onLoad 不写任何文件（没按按钮就不该动磁盘）", () => {
  assert.equal(fsSync.existsSync(configPath), false, "onLoad 不得创建 ~/.ssh/config");
});

await test("scm.env 返回真实解析结果，且四个工具都有明确的 source", async () => {
  const res = await invoke("scm.env", {});
  assert.equal(res.ok, true);
  assert.equal(typeof res.envPathPresent, "boolean");
  for (const name of ["git", "ssh", "ssh-keygen", "gh"]) {
    assert.ok(res.bins[name], `缺少 ${name} 的解析结果`);
    assert.ok(
      ["missing", "known-location", "registry", "PATH"].includes(res.bins[name].source) || res.bins[name].source.startsWith("env:"),
      `意外的 source：${res.bins[name].source}`,
    );
    if (res.bins[name].path) assert.equal(fsSync.existsSync(res.bins[name].path), true, `${name} 的路径必须真实存在`);
  }
});

await test("未知通道返回 UNSUPPORTED（不抛异常、不让面板卡死）", async () => {
  const res = await invoke("scm.nope", {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "UNSUPPORTED");
});

await test("scm.ssh.writeConfig 首次写入：建文件 + 内容正确 + 不产生备份", async () => {
  const res = await invoke("scm.ssh.writeConfig", { provider: "github", port: 443, keyName: "id_ed25519" });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.changed, true);
  assert.equal(res.created, true);
  const text = await fs.readFile(configPath, "utf8");
  assert.match(text, /^Host github\.com$/m);
  assert.match(text, /^\s+HostName ssh\.github\.com$/m);
  assert.match(text, /^\s+Port 443$/m);
  assert.match(text, /^\s+IdentityFile ~\/\.ssh\/id_ed25519$/m);
  assert.equal(backups().length, 0, "首次创建时没有原文件可备份");
});

await test("scm.ssh.writeConfig 幂等：同样的参数第二次不改文件、不产生新备份", async () => {
  const before = await fs.readFile(configPath, "utf8");
  const res = await invoke("scm.ssh.writeConfig", { provider: "github", port: 443, keyName: "id_ed25519" });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.equal(backups().length, 0);
});

await test("scm.ssh.writeConfig 切端口：就地改写 + 先备份 + 仍只有一个 Host 块", async () => {
  const res = await invoke("scm.ssh.writeConfig", { provider: "github", port: 22, keyName: "id_ed25519" });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.ok(res.backup, "改写既有文件前必须备份");
  assert.equal(fsSync.existsSync(res.backup), true);
  assert.equal(backups().length, 1);
  const text = await fs.readFile(configPath, "utf8");
  assert.match(text, /HostName github\.com$/m, "22 端口应写标准端点");
  assert.match(text, /Port 22$/m);
  assert.equal(hostLineCount(text, "github\\.com"), 1, "不允许出现重复块");
});

await test("scm.ssh.writeConfig 追加 Gitee 块后，GitHub 块不受影响", async () => {
  const res = await invoke("scm.ssh.writeConfig", { provider: "gitee", port: 443, keyName: "gitee_ed25519" });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  const text = await fs.readFile(configPath, "utf8");
  assert.equal(hostLineCount(text, "github\\.com"), 1);
  assert.equal(hostLineCount(text, "gitee\\.com"), 1);
  assert.match(text, /Port 22$/m, "GitHub 块应还是 22");
});

await test("scm.ssh.status 读回真实文件：两个平台块的状态都正确", async () => {
  const res = await invoke("scm.ssh.status", {});
  assert.equal(res.ok, true);
  assert.equal(res.configExists, true);
  assert.equal(res.blocks.github.configured, true);
  assert.equal(res.blocks.github.port, 22);
  assert.equal(res.blocks.gitee.configured, true);
  assert.equal(res.blocks.gitee.port, 443);
  assert.equal(res.blocks.gitee.identityFile, "~/.ssh/gitee_ed25519");
});

await test("写坏目标端口不会污染配置（脏值回退 443）", async () => {
  const res = await invoke("scm.ssh.writeConfig", { provider: "gitee", port: "22; rm -rf /", keyName: "gitee_ed25519" });
  assert.equal(res.ok, true);
  const text = await fs.readFile(configPath, "utf8");
  const giteeBlock = text.slice(text.indexOf("Host gitee.com"));
  assert.match(giteeBlock, /Port 443/);
  assert.equal(/rm -rf/.test(text), false);
});

await test("手写的非法 keyName 不会写出 ~/.ssh 之外（回退默认名）", async () => {
  const res = await invoke("scm.ssh.writeConfig", { provider: "gitee", port: 443, keyName: "../../evil" });
  assert.equal(res.ok, true);
  const text = await fs.readFile(configPath, "utf8");
  assert.equal(/evil/.test(text), false);
  assert.match(text, /IdentityFile ~\/\.ssh\/id_ed25519/);
});

await test("权限：config 与 prefs 是 0600（POSIX 上严格校验）", async () => {
  await invoke("scm.prefs.set", { provider: "github", port: 443, cloneParent: "" });
  const prefsPath = path.join(dataDir, "prefs.json");
  assert.equal(fsSync.existsSync(prefsPath), true);
  if (process.platform !== "win32") {
    assert.equal(fsSync.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fsSync.statSync(prefsPath).mode & 0o777, 0o600);
  }
});

await test("prefs 往返：写入后能读回，且不再保存端口", async () => {
  await invoke("scm.prefs.set", { provider: "gitee", cloneParent: tmpHome });
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, "prefs.json"), "utf8"));
  assert.equal(saved.provider, "gitee");
  assert.equal(saved.cloneParent, tmpHome);
  assert.equal("port" in saved, false, "端口属于各平台配置，不该存进全局偏好");
  const got = await invoke("scm.prefs.get", {});
  assert.equal(got.prefs.provider, "gitee");
});

// ── v0.2.0：两个平台各用各的密钥/端口，改写一个不能动到另一个 ──────────────
//
// 真实场景：本机 github 用 id_ed25519_github_codexsync:443、gitee 用
// gitee_skill_patent:22。老实现只有一个全局「密钥 + 端口」，按一次写入就会把
// GitHub 的 IdentityFile 换成 gitee 那把，直接弄坏 GitHub 认证。

const SEED = [
  "Host gitee.com",
  "  Hostname gitee.com",
  "  Port 22",
  "  User git",
  "  IdentityFile ~/.ssh/gitee_skill_patent",
  "",
  "Host github.com",
  "  HostName ssh.github.com",
  "  Port 443",
  "  User git",
  "  IdentityFile ~/.ssh/id_ed25519_github_codexsync",
  "",
].join("\n");

const seedConfig = async () => {
  await fs.mkdir(sshDir, { recursive: true });
  await fs.writeFile(configPath, SEED, "utf8");
  return fs.readFile(configPath, "utf8");
};

await test("status 按平台报密钥：github 与 gitee 各是自己配置里的那把", async () => {
  await seedConfig();
  const res = await invoke("scm.ssh.status", {});
  assert.equal(res.ok, true);
  assert.equal(res.providers.github.keyName, "id_ed25519_github_codexsync");
  assert.equal(res.providers.github.keySource, "config");
  assert.equal(res.providers.github.port, 443);
  assert.equal(res.providers.gitee.keyName, "gitee_skill_patent");
  assert.equal(res.providers.gitee.port, 22);
  assert.ok(res.keys.length >= 0, "keys 必须是数组（本机有没有钥匙都不该抛）");
});

await test("不指定 keyName 时保留现有 IdentityFile，绝不换成别处那把", async () => {
  await seedConfig();
  const res = await invoke("scm.ssh.writeConfig", { provider: "github" });
  assert.equal(res.ok, true);
  assert.equal(res.identitySource, "kept");
  assert.equal(res.identity, "~/.ssh/id_ed25519_github_codexsync");
  const text = await fs.readFile(configPath, "utf8");
  assert.match(text, /Host github\.com\n(?:.*\n)*? {2}IdentityFile ~\/\.ssh\/id_ed25519_github_codexsync/);
  assert.equal(/Host github[\s\S]*?gitee_skill_patent/.test(text.split("Host gitee.com")[1] || text), false, "GitHub 块里不得出现 gitee 的钥匙");
});

await test("不指定端口时沿用该平台现有端口（443 不会被拉回 22）", async () => {
  await seedConfig();
  const res = await invoke("scm.ssh.writeConfig", { provider: "gitee" });
  assert.equal(res.ok, true);
  assert.equal(res.port, 22, "Gitee 现有是 22，应保持 22");
  const text = await fs.readFile(configPath, "utf8");
  const githubBlock = text.slice(text.indexOf("Host github.com"));
  assert.match(githubBlock, /Port 443/, "GitHub 的 443 不该被 Gitee 的 22 带跑");
});

await test("写一个平台后，另一个平台的整块内容逐字不变", async () => {
  await seedConfig();
  const before = await fs.readFile(configPath, "utf8");
  const beforeGithub = before.slice(before.indexOf("Host github.com"));
  await invoke("scm.ssh.writeConfig", { provider: "gitee", port: 443 });
  const after = await fs.readFile(configPath, "utf8");
  const afterGithub = after.slice(after.indexOf("Host github.com"));
  assert.equal(afterGithub, beforeGithub, "改写 Gitee 不允许动到 GitHub 块");
});

await test("显式指定 keyName 时才替换密钥（chosen）", async () => {
  await seedConfig();
  const res = await invoke("scm.ssh.writeConfig", { provider: "github", keyName: "gitee_skill_patent" });
  assert.equal(res.ok, true);
  assert.equal(res.identitySource, "chosen");
  assert.equal(res.identity, "~/.ssh/gitee_skill_patent");
});


await test("prefs 拒绝相对路径（目录必须是绝对路径）", async () => {
  const res = await invoke("scm.prefs.set", { cloneParent: "relative/dir" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "BAD_DIR");
});

await test("克隆守卫：坏地址 / 相对目录 / 不存在目录 / 目标已存在，全部在起 git 之前拦下", async () => {
  const bad = await invoke("scm.clone.run", { url: "https://x/y; rm -rf /", parentDir: tmpHome });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "BAD_URL", bad.code);

  const noAbs = await invoke("scm.clone.run", { url: "git@github.com:a/b.git", parentDir: "relative" });
  assert.equal(noAbs.ok, false);
  assert.equal(noAbs.code, "BAD_PARENT");

  const missing = await invoke("scm.clone.run", { url: "git@github.com:a/b.git", parentDir: path.join(tmpRoot, "nope") });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NO_PARENT_DIR");

  fsSync.mkdirSync(path.join(tmpHome, "b"), { recursive: true });
  const exists = await invoke("scm.clone.run", { url: "git@github.com:a/b.git", parentDir: tmpHome });
  assert.equal(exists.ok, false);
  assert.equal(exists.code, "TARGET_EXISTS", "已存在同名目录时必须拒绝，绝不覆盖");
});

await test("scm.clone.status 对未知 jobId 返回 NO_JOB", async () => {
  const res = await invoke("scm.clone.status", { jobId: "nope" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "NO_JOB");
});

await test("scm.pickDir 走宿主选择器并返回路径", async () => {
  const res = await invoke("scm.pickDir", {});
  assert.equal(res.ok, true);
  assert.equal(res.path, path.join(tmpRoot, "picked"));
});

await main.onUnload();
await fs.rm(tmpRoot, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed / ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed（临时 HOME：${tmpHome}，已清理）`);
