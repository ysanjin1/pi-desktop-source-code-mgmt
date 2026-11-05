/**
 * ③ 代码管理的回归：纯函数 + **真实 git 仓库**（全部在临时目录里，不联网、不碰你的仓库）。
 *
 * 覆盖的是本插件相对 Git Lens 的增量：>100MB 大文件识别与 .gitignore 治理、
 * revert / cherry-pick。暂存与提交属于 Git Lens 已有能力，这里不重复实现。
 *
 * 跑法：node tests/repo.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, "..");
const require = createRequire(import.meta.url);

const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "scm-repo-"));
const tmpHome = path.join(tmpRoot, "home");
const dataDir = path.join(tmpRoot, "data");
fsSync.mkdirSync(tmpHome, { recursive: true });
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const main = require(path.join(pluginRoot, "main.js"));
const {
  parsePorcelainZ,
  classifyChanges,
  formatBytes,
  ignorePatternFor,
  appendGitignore,
  parseGitLog,
} = main.internals;

globalThis.pi = {
  plugin: { getDataPath: async () => dataDir, getSettings: async () => ({}) },
  workspace: { get: async () => null },
  fs: { requestDirectory: async () => null },
};

// 必须调 onLoad：dataPath 由它设置，否则偏好/目录记忆根本落不了盘
await main.onLoad();

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

// ── 纯函数 ───────────────────────────────────────────────────────────────────

await test("parsePorcelainZ 解析普通条目与改名条目（-z 无引号转义）", () => {
  const raw = ["M  staged.txt", " M dirty.txt", "?? new.txt", "R  renamed.txt", "old.txt", "A  auto 新增.md", ""].join("\0");
  const entries = parsePorcelainZ(raw);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries[0], { x: "M", y: " ", path: "staged.txt" });
  assert.deepEqual(entries[1], { x: " ", y: "M", path: "dirty.txt" });
  assert.deepEqual(entries[2], { x: "?", y: "?", path: "new.txt" });
  assert.equal(entries[3].path, "renamed.txt");
  assert.equal(entries[3].origPath, "old.txt");
  assert.equal(entries[4].path, "auto 新增.md", "路径里的空格必须保留");
  assert.deepEqual(parsePorcelainZ(""), []);
});

await test("classifyChanges 按 XY 分类", () => {
  const c = classifyChanges([
    { x: "M", y: " " },
    { x: " ", y: "M" },
    { x: "?", y: "?" },
  ].map((e, i) => Object.assign({ path: "f" + i }, e)));
  assert.deepEqual(c.staged, ["f0"]);
  assert.deepEqual(c.unstaged, ["f1"]);
  assert.deepEqual(c.untracked, ["f2"]);
});

await test("formatBytes 人类可读", () => {
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(100 * 1024 * 1024), "100.0 MB");
  assert.equal(formatBytes(undefined), "0 B");
});

await test("ignorePatternFor：根目录文件只忽略自己，子目录忽略整个一级目录", () => {
  assert.equal(ignorePatternFor("huge.bin"), "huge.bin");
  assert.equal(ignorePatternFor("assets/huge.bin"), "assets/**");
  assert.equal(ignorePatternFor("a/b/c.bin"), "a/**");
  assert.equal(ignorePatternFor(""), "");
});

await test("appendGitignore：去重、保留 CRLF、末尾补空行", () => {
  const existing = "node_modules\r\n*.log\r\n";
  const out = appendGitignore(existing, ["*.log", "assets/**", "huge.bin"]);
  assert.deepEqual(out.added, ["assets/**", "huge.bin"]);
  assert.equal(out.changed, true);
  assert.equal(out.eol, "\r\n");
  assert.equal(/(^|[^\r])\n/.test(out.text), false, "不得引入裸 LF");
  assert.match(out.text, /assets\/\*\*\r\nhuge\.bin\r\n$/);

  const again = appendGitignore(out.text, ["assets/**", "huge.bin"]);
  assert.equal(again.changed, false, "重复调用不应再改动文件");
  assert.deepEqual(again.added, []);
});

await test("parseGitLog 解析 %x1f 分隔的四段", () => {
  const raw = ["abc123\x1f2026-11-05\x1fysan\x1ffeat: 干活", "def456\x1f2026-11-04\x1fother\x1ffix: 修一下"].join("\n");
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, "abc123");
  assert.equal(commits[0].date, "2026-11-05");
  assert.equal(commits[0].author, "ysan");
  assert.equal(commits[0].subject, "feat: 干活");
  assert.deepEqual(parseGitLog(""), []);
});

// ── 真实 git 仓库 ────────────────────────────────────────────────────────────

const repo = path.join(tmpRoot, "repo");
const git = (args, cwd = repo) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }),
  });

await test("非仓库目录 → isRepo:false（不报错、不抛）", async () => {
  const plain = path.join(tmpRoot, "plain");
  fsSync.mkdirSync(plain, { recursive: true });
  const res = await invoke("scm.repo.status", { dir: plain });
  assert.equal(res.ok, true);
  assert.equal(res.isRepo, false);
});

await test("相对路径被拒绝", async () => {
  const res = await invoke("scm.repo.status", { dir: "relative/dir" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "BAD_DIR");
});

await test("init 后能读到未跟踪文件、中文路径不乱码", async () => {
  fsSync.mkdirSync(repo, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.name", "Tester"]);
  git(["config", "user.email", "t@example.com"]);
  await fs.writeFile(path.join(repo, "说明 文档.md"), "# 你好\n", "utf8");
  const res = await invoke("scm.repo.status", { dir: repo });
  assert.equal(res.ok, true);
  assert.equal(res.isRepo, true);
  assert.equal(res.changes.untracked, 1);
  assert.equal(res.files[0].path, "说明 文档.md");
  assert.equal(res.files[0].kind, "untracked");
});

await test("大文件识别：阈值可覆盖，超过才报", async () => {
  const big = path.join(repo, "huge.bin");
  await fs.writeFile(big, Buffer.alloc(2 * 1024 * 1024, 7)); // 2MB
  const withLow = await invoke("scm.repo.status", { dir: repo, thresholdBytes: 1024 * 1024 });
  assert.equal(withLow.bigFiles.length, 1);
  assert.equal(withLow.bigFiles[0].path, "huge.bin");
  assert.match(withLow.bigFiles[0].size, /2\.0 MB/);

  const withHigh = await invoke("scm.repo.status", { dir: repo, thresholdBytes: 10 * 1024 * 1024 });
  assert.equal(withHigh.bigFiles.length, 0, "阈值 10MB 时 2MB 文件不算大文件");
});

await test("大文件写入 .gitignore：只忽略根目录那个文件，重复调用不再改", async () => {
  const first = await invoke("scm.repo.ignore", { dir: repo, thresholdBytes: 1024 * 1024 });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(first.added, ["huge.bin"]);
  const text = await fs.readFile(path.join(repo, ".gitignore"), "utf8");
  assert.match(text, /^huge\.bin$/m);

  const second = await invoke("scm.repo.ignore", { dir: repo, thresholdBytes: 1024 * 1024 });
  assert.equal(second.changed, false, "已在 .gitignore 里就不该再写");
});

await test("子目录大文件 → 忽略整个一级目录", async () => {
  fsSync.mkdirSync(path.join(repo, "assets"), { recursive: true });
  await fs.writeFile(path.join(repo, "assets", "video.mp4"), Buffer.alloc(2 * 1024 * 1024, 9));

  // 未跟踪目录必须逐个文件列出（git status 默认会折叠成 assets/，那样就漏了）
  const status = await invoke("scm.repo.status", { dir: repo, thresholdBytes: 1024 * 1024 });
  assert.ok(
    status.files.some((f) => f.path === "assets/video.mp4"),
    "未跟踪目录里的文件必须逐个出现，实际：" + JSON.stringify(status.files.map((f) => f.path)),
  );
  assert.ok(
    status.bigFiles.some((f) => f.path === "assets/video.mp4"),
    "未跟踪目录里的大文件也要被认出来",
  );

  const res = await invoke("scm.repo.ignore", { dir: repo, thresholdBytes: 1024 * 1024 });
  assert.equal(res.ok, true);
  assert.ok(res.added.includes("assets/**"), "应忽略整个一级目录，得到：" + JSON.stringify(res.added));
});

await test("提交后 log 能读到（含作者与日期）", async () => {
  git(["add", "说明 文档.md"]);
  git(["commit", "-q", "-m", "feat: 第一版说明"]);
  const res = await invoke("scm.repo.log", { dir: repo, count: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.commits.length, 1);
  assert.equal(res.commits[0].subject, "feat: 第一版说明");
  assert.equal(res.commits[0].author, "Tester");
  assert.match(res.commits[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

await test("revert 撤销最近一次提交，文件回到上一版", async () => {
  await fs.writeFile(path.join(repo, "说明 文档.md"), "# 你好\n第二行\n", "utf8");
  git(["add", "说明 文档.md"]);
  git(["commit", "-q", "-m", "feat: 加一行"]);
  const hash = git(["rev-parse", "HEAD"]).trim();

  const res = await invoke("scm.repo.revert", { dir: repo, hash });
  assert.equal(res.ok, true, res.message);
  const text = (await fs.readFile(path.join(repo, "说明 文档.md"), "utf8")).replace(/\r\n/g, "\n");
  assert.equal(text, "# 你好\n", "内容应回到加那一行之前");
});

await test("cherry-pick 把另一分支的提交带到当前分支", async () => {
  git(["checkout", "-q", "-b", "side"]);
  await fs.writeFile(path.join(repo, "side.txt"), "from side\n", "utf8");
  git(["add", "side.txt"]);
  git(["commit", "-q", "-m", "feat: side 分支的提交"]);
  const sideHash = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "-q", "master"]);

  const res = await invoke("scm.repo.cherryPick", { dir: repo, hash: sideHash });
  assert.equal(res.ok, true, res.message);
  const text = (await fs.readFile(path.join(repo, "side.txt"), "utf8")).replace(/\r\n/g, "\n");
  assert.equal(text, "from side\n");
});

await test("非法提交号被拒绝（不会把任意参数塞进 git）", async () => {
  const res = await invoke("scm.repo.revert", { dir: repo, hash: "--help" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "BAD_HASH");
});

await test("全新仓库：log 返回空列表而不是报错", async () => {
  const fresh = path.join(tmpRoot, "fresh");
  fsSync.mkdirSync(fresh, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: fresh, stdio: "ignore" });
  const res = await invoke("scm.repo.log", { dir: fresh });
  assert.equal(res.ok, true);
  assert.deepEqual(res.commits, []);
});

// ── v0.5.0：路径/分支/仓库名校验（纯函数） ─────────────────────────────────

const { isSafeRepoPath, isSafeBranchName, isSafeRepoName } = main.internals;

await test("isSafeRepoPath 拒绝绝对路径与 ..", () => {
  assert.equal(isSafeRepoPath("src/a.ts"), true);
  assert.equal(isSafeRepoPath("说明 文档.md"), true);
  assert.equal(isSafeRepoPath("../escape"), false);
  assert.equal(isSafeRepoPath("a/../../b"), false);
  assert.equal(isSafeRepoPath("C:/Windows/system32"), false);
  assert.equal(isSafeRepoPath("/etc/passwd"), false);
  assert.equal(isSafeRepoPath("\\\\server\\share"), false);
  assert.equal(isSafeRepoPath(""), false);
});

await test("isSafeBranchName 拒绝选项注入与非法形状", () => {
  assert.equal(isSafeBranchName("master"), true);
  assert.equal(isSafeBranchName("feature/x-1"), true);
  assert.equal(isSafeBranchName("-f"), false);
  assert.equal(isSafeBranchName("a..b"), false);
  assert.equal(isSafeBranchName("a b"), false);
  assert.equal(isSafeBranchName("x.lock"), false);
  assert.equal(isSafeBranchName(""), false);
});

await test("isSafeRepoName 只允许字母数字 . _ -", () => {
  assert.equal(isSafeRepoName("my-repo_1.0"), true);
  assert.equal(isSafeRepoName("a b"), false);
  assert.equal(isSafeRepoName("a/b"), false);
  assert.equal(isSafeRepoName(""), false);
});

// ── v0.5.0：暂存 / 提交 / 分支 / diff / 同步（真实仓库 + 本地裸远程，不联网） ──

const remote = path.join(tmpRoot, "remote.git");
const work = path.join(tmpRoot, "work");

async function gitC(args, cwd = work) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }),
  });
}

await test("准备：工作区 + 本地裸远程", async () => {
  execFileSync("git", ["init", "--bare", "-q", remote], { stdio: "ignore" });
  fsSync.mkdirSync(work, { recursive: true });
  await gitC(["init", "-q"]);
  await gitC(["config", "user.name", "Tester"]);
  await gitC(["config", "user.email", "t@example.com"]);
  await fs.writeFile(path.join(work, "a.txt"), "one\n", "utf8");
  await gitC(["add", "a.txt"]);
  await gitC(["commit", "-q", "-m", "init"]);
  await gitC(["remote", "add", "origin", remote]);
  await gitC(["push", "-q", "-u", "origin", "master"]);
});

await test("stage / unstage 生效，且空提交被明确拦下", async () => {
  await fs.writeFile(path.join(work, "b.txt"), "two\n", "utf8");
  const staged = await invoke("scm.repo.stage", { dir: work, paths: ["b.txt"] });
  assert.equal(staged.ok, true);
  let status = await invoke("scm.repo.status", { dir: work });
  assert.equal(status.changes.staged, 1);

  const empty = await invoke("scm.repo.commit", { dir: work, message: "   " });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "NO_MESSAGE");

  const un = await invoke("scm.repo.unstage", { dir: work, paths: ["b.txt"] });
  assert.equal(un.ok, true);
  status = await invoke("scm.repo.status", { dir: work });
  assert.equal(status.changes.staged, 0);

  const nothing = await invoke("scm.repo.commit", { dir: work, message: "chore: 空提交" });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, "NOTHING_STAGED", "没有暂存内容时必须明说，而不是让 git 报一句难懂的话");
});

await test("diff：已跟踪文件与未跟踪文件都能看", async () => {
  await fs.writeFile(path.join(work, "a.txt"), "one\nmodified\n", "utf8");
  const tracked = await invoke("scm.repo.diff", { dir: work, path: "a.txt" });
  assert.equal(tracked.ok, true);
  assert.match(tracked.diff, /\+modified/);

  const untracked = await invoke("scm.repo.diff", { dir: work, path: "b.txt" });
  assert.equal(untracked.ok, true);
  assert.match(untracked.diff, /^\+two$/m, "未跟踪文件应按全文新增展示");

  const bad = await invoke("scm.repo.diff", { dir: work, path: "../escape.txt" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "BAD_PATH");
});

await test("commit 成功后 log 能读到，commitDiff 能看内容", async () => {
  await invoke("scm.repo.stage", { dir: work, paths: ["a.txt", "b.txt"] });
  const res = await invoke("scm.repo.commit", { dir: work, message: "feat: 两个文件" });
  assert.equal(res.ok, true, res.message);
  assert.ok(res.hash);

  const log = await invoke("scm.repo.log", { dir: work, count: 3 });
  assert.equal(log.commits[0].subject, "feat: 两个文件");

  const diff = await invoke("scm.repo.commitDiff", { dir: work, hash: res.hash });
  assert.equal(diff.ok, true);
  assert.match(diff.diff, /\+two/);
});

await test("branches + checkout", async () => {
  const list = await invoke("scm.repo.branches", { dir: work });
  assert.equal(list.ok, true);
  assert.equal(list.current, "master");
  assert.ok(list.branches.some((b) => b.name === "master" && b.current));

  await gitC(["branch", "feature"]);
  const switched = await invoke("scm.repo.checkout", { dir: work, branch: "feature" });
  assert.equal(switched.ok, true, switched.message);
  assert.equal((await invoke("scm.repo.branches", { dir: work })).current, "feature");

  const bad = await invoke("scm.repo.checkout", { dir: work, branch: "-f" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "BAD_BRANCH");
  await gitC(["checkout", "-q", "master"]);
});

await test("push / pull / align / force 守卫（本地裸远程，不联网）", async () => {
  await fs.writeFile(path.join(work, "c.txt"), "three\n", "utf8");
  await invoke("scm.repo.stage", { dir: work, paths: ["c.txt"] });
  await invoke("scm.repo.commit", { dir: work, message: "feat: c" });

  const pushed = await invoke("scm.repo.push", { dir: work });
  assert.equal(pushed.ok, true, pushed.message);

  const pulled = await invoke("scm.repo.pull", { dir: work });
  assert.equal(pulled.ok, true, pulled.message);
  assert.match(pulled.message, /最新|已拉取/);

  // 强制推送/强制拉取/对齐都必须显式确认
  for (const channel of ["scm.repo.forcePush", "scm.repo.forcePull", "scm.repo.align"]) {
    const res = await invoke(channel, { dir: work });
    assert.equal(res.ok, false, channel + " 未确认时必须拒绝");
    assert.equal(res.code, "NEED_CONFIRM");
  }

  // 本地弄脏 + 多一个提交，然后对齐回到远程状态
  await fs.writeFile(path.join(work, "c.txt"), "dirty\n", "utf8");
  await gitC(["commit", "-qam", "wip: 本地脏提交"]);
  const aligned = await invoke("scm.repo.align", { dir: work, confirm: true });
  assert.equal(aligned.ok, true, aligned.message);
  const text = (await fs.readFile(path.join(work, "c.txt"), "utf8")).replace(/\r\n/g, "\n");
  assert.equal(text, "three\n", "对齐后本地应回到远程版本");
});

await test("pushStaged 只提交已暂存内容", async () => {
  await fs.writeFile(path.join(work, "staged.txt"), "s\n", "utf8");
  await fs.writeFile(path.join(work, "unstaged.txt"), "u\n", "utf8");
  await invoke("scm.repo.stage", { dir: work, paths: ["staged.txt"] });
  const res = await invoke("scm.repo.pushStaged", { dir: work, message: "feat: 只推暂存" });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.committed, true);
  const status = await invoke("scm.repo.status", { dir: work });
  assert.ok(status.files.some((f) => f.path === "unstaged.txt" && f.kind === "untracked"), "未暂存的文件不该被带走");
});

await test("repo.init：非仓库目录可初始化，已是仓库时不做改动", async () => {
  const fresh = path.join(tmpRoot, "initme");
  fsSync.mkdirSync(fresh, { recursive: true });
  const first = await invoke("scm.repo.init", { dir: fresh });
  assert.equal(first.ok, true, first.message);
  assert.equal(typeof first.hasIdentity, "boolean");
  const again = await invoke("scm.repo.init", { dir: fresh });
  assert.equal(again.already, true);
});

await test("dirs 记忆：添加 / 列出 / 移除（6a 只删记录不删目录）", async () => {
  const dir = path.join(tmpRoot, "work");
  const added = await invoke("scm.dirs.add", { dir });
  assert.equal(added.ok, true);
  assert.ok(added.dirs.includes(dir));
  const listed = await invoke("scm.dirs.list", {});
  assert.ok(listed.dirs.includes(dir));

  const bad = await invoke("scm.dirs.add", { dir: "relative" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "BAD_DIR");

  const removed = await invoke("scm.dirs.remove", { dir });
  assert.equal(removed.ok, true);
  assert.equal(removed.dirs.includes(dir), false);
  assert.equal(fsSync.existsSync(dir), true, "移除记录不能删掉实际目录");
});

// ── v0.6.0：本地仓库扫描（③ 要能看见磁盘上已有的仓库） ────────────────────

await test("scanRootForRepos：找到一级/二级仓库，跳过 node_modules 与过深目录", async () => {
  const { scanRootForRepos } = main.internals;
  const root = path.join(tmpRoot, "scan-root");
  const mk = (p) => fsSync.mkdirSync(p, { recursive: true });
  mk(path.join(root, "alpha", ".git"));
  mk(path.join(root, "beta", ".git"));
  mk(path.join(root, "node_modules", "evil", ".git")); // 噪音，必须跳过
  mk(path.join(root, "l1", "l2", "l3", ".git")); // 深度 3，不该命中

  const res = await scanRootForRepos(root);
  const names = res.found.map((f) => f.name).sort();
  assert.deepEqual(names, ["alpha", "beta"], "实际扫到：" + names.join(","));
  assert.ok(res.visited > 0);
});

await test("scm.repos.scan 指定根目录即可，返回仓库与统计", async () => {
  const root = path.join(tmpRoot, "scan-root");
  const res = await invoke("scm.repos.scan", { roots: [root] });
  assert.equal(res.ok, true);
  assert.equal(res.total, 2);
  assert.ok(res.repos.every((r) => r.path && r.name));
  assert.equal(res.stats.length, 1);
  assert.equal(res.stats[0].root, root);
});

await test("SCAN_SKIP 覆盖 node_modules / AppData 这类噪音目录", () => {
  const { SCAN_SKIP } = main.internals;
  for (const name of ["node_modules", "AppData", "dist", "build", ".git", "venv"]) {
    assert.ok(SCAN_SKIP.has(name), name + " 应被跳过");
  }
});

// ── v0.7.0：总览索引 ────────────────────────────────────────────────────────

const { parseGitHead, parseGitConfigRemote, normalizeRemoteUrl, agentHint, groupByRemote } = main.internals;

await test("parseGitHead / parseGitConfigRemote 直接读 .git 文件，不 fork git", () => {
  assert.deepEqual(parseGitHead("ref: refs/heads/main\n"), { branch: "main", detached: false });
  assert.equal(parseGitHead("a".repeat(40)).detached, true);
  const cfg = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/repo.git\n';
  assert.deepEqual(parseGitConfigRemote(cfg), { name: "origin", url: "git@github.com:me/repo.git" });
  assert.equal(parseGitConfigRemote("").url, "");
});

await test("normalizeRemoteUrl：ssh / https / .git / 大小写都算同一远程", () => {
  const a = normalizeRemoteUrl("git@github.com:Me/Repo.git");
  const b = normalizeRemoteUrl("https://github.com/me/repo");
  const c = normalizeRemoteUrl("https://user@github.com/me/repo.git/");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, "github.com/me/repo");
  assert.notEqual(normalizeRemoteUrl("git@gitee.com:me/repo.git"), a);
});

await test("agentHint 只按关键词提示，不下结论", () => {
  assert.equal(agentHint("C:/codex_cad", ""), "Codex");
  assert.equal(agentHint("/home/x/proj", "git@github.com:claude-tools/x.git"), "Claude");
  assert.equal(agentHint("/home/x/proj", "git@github.com:me/x.git"), "");
});

await test("groupByRemote 把同一远程的多个副本归到一组", () => {
  const groups = groupByRemote([
    { path: "a", remoteUrl: "git@github.com:me/x.git" },
    { path: "b", remoteUrl: "https://github.com/me/x" },
    { path: "c", remoteUrl: "git@github.com:me/y.git" },
    { path: "d", remoteUrl: "" },
  ]);
  assert.equal(groups.get("github.com/me/x").length, 2);
  assert.equal(groups.get("github.com/me/y").length, 1);
});

await test("scm.repos.index：两个副本被标成同一远程，分支/改动/最后提交都对", async () => {
  const root = path.join(tmpRoot, "index-root");
  fsSync.mkdirSync(root, { recursive: true });
  const bare = path.join(tmpRoot, "idx-remote.git");
  execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });

  const src = path.join(tmpRoot, "idx-src");
  fsSync.mkdirSync(src, { recursive: true });
  await gitC(["init", "-q"], src);
  await gitC(["config", "user.name", "Tester"], src);
  await gitC(["config", "user.email", "t@example.com"], src);
  await fs.writeFile(path.join(src, "readme.md"), "hi\n", "utf8");
  await gitC(["add", "."], src);
  await gitC(["commit", "-q", "-m", "init"], src);
  await gitC(["remote", "add", "origin", bare], src);
  await gitC(["push", "-q", "-u", "origin", "master"], src);

  for (const name of ["copyA", "copyB"]) {
    execFileSync("git", ["clone", "-q", bare, path.join(root, name)], { stdio: "ignore" });
  }
  await fs.writeFile(path.join(root, "copyA", "dirty.txt"), "x\n", "utf8");

  const res = await invoke("scm.repos.index", { roots: [root] });
  assert.equal(res.ok, true);
  assert.equal(res.repos.length, 2);
  assert.equal(res.duplicates.length, 1, "同一远程两份应成一组");
  assert.equal(res.duplicates[0].paths.length, 2);

  const a = res.repos.find((r) => r.name === "copyA");
  const b = res.repos.find((r) => r.name === "copyB");
  assert.equal(a.dirty, 1, "copyA 有 1 个未跟踪文件");
  assert.equal(b.dirty, 0);
  assert.ok(a.branch);
  assert.equal(a.lastCommit.subject, "init");
  assert.ok(a.duplicateOf, "重复副本要带标记");
});

// ── v0.8.0：agent 工作区与额外扫描根（修「识别不到 deepseek-harness 里的仓库」） ──

await test("parseWorkspacePaths 从 DSH 的 workspace.json 抽路径并反转义", () => {
  const text = JSON.stringify({
    global: { defaultWorkspaceId: "x" },
    items: [
      { path: "D:\\文档\\deepseek-harness\\default-workspace" },
      { path: "C:\\code\\a" },
      { path: "not-absolute" },
    ],
  });
  const paths = main.internals.parseWorkspacePaths(text);
  assert.ok(paths.includes("D:\\文档\\deepseek-harness\\default-workspace"));
  assert.ok(paths.includes("C:\\code\\a"));
  assert.equal(paths.includes("not-absolute"), false);
});

await test("DSH 工作区会被当扫描根：深 4 层的仓库也能找到", async () => {
  const wsRoot = path.join(tmpRoot, "deep", "a", "b");
  const repoPath = path.join(wsRoot, "inner-repo");
  fsSync.mkdirSync(path.join(repoPath, ".git"), { recursive: true });

  const dshDir = path.join(tmpHome, ".dsh", "storages");
  fsSync.mkdirSync(dshDir, { recursive: true });
  fsSync.writeFileSync(path.join(dshDir, "workspace.json"), JSON.stringify({ items: [{ path: wsRoot }] }), "utf8");

  const roots = await main.internals.defaultScanRoots();
  assert.ok(
    roots.some((r) => r.toLowerCase() === wsRoot.toLowerCase()),
    "DSH 工作区应进入扫描根，实际：" + roots.join(" | "),
  );
  const res = await invoke("scm.repos.index", {});
  assert.ok(
    res.repos.some((r) => r.path.toLowerCase() === repoPath.toLowerCase()),
    "工作区里的仓库应被扫到，实际：" + res.repos.map((r) => r.path).join(" | "),
  );
});

await test("额外扫描根：添加后进入扫描，移除后消失", async () => {
  const extra = path.join(tmpRoot, "extra-root");
  const inner = path.join(extra, "repo1");
  fsSync.mkdirSync(path.join(inner, ".git"), { recursive: true });

  const added = await invoke("scm.scan.addRoot", { dir: extra });
  assert.equal(added.ok, true);
  assert.ok(added.roots.includes(extra));
  assert.ok((await invoke("scm.scan.roots")).roots.includes(extra));

  const scan = await invoke("scm.repos.scan", {});
  assert.ok(scan.repos.some((r) => r.path.toLowerCase() === inner.toLowerCase()));

  const bad = await invoke("scm.scan.addRoot", { dir: "relative" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "BAD_DIR");

  const removed = await invoke("scm.scan.removeRoot", { dir: extra });
  assert.equal(removed.roots.includes(extra), false);
});

// ── v0.9.0：agent 工具（让 AI 在对话里直接读/操作仓库） ────────────────────

await test("agent 工具注册：两个工具带 schema/risk，且能被卸载", async () => {
  const registered = [];
  const unregistered = [];
  globalThis.pi.agent = {
    registerTool: async (tool) => registered.push(tool),
    unregisterTool: async (name) => unregistered.push(name),
  };
  const ok = await main.internals.registerAgentTools();
  assert.equal(ok, true);
  assert.deepEqual(registered.map((t) => t.name), ["GitRepo", "GitIndex"]);

  const repo = registered[0];
  assert.equal(typeof repo.execute, "function");
  assert.equal(repo.risk, "medium");
  assert.ok(repo.planSafeActions.includes("status"), "只读动作要能被 Plan 模式放行");
  assert.ok(repo.schema.properties.action.enum.includes("push"));
  assert.deepEqual(repo.schema.required, ["action"]);

  await main.internals.unregisterAgentTools();
  assert.deepEqual(unregistered, ["GitRepo", "GitIndex"]);
  delete globalThis.pi.agent;
});

await test("GitRepo 工具：status 省略 dir 时用面板上次操作的仓库", async () => {
  await invoke("scm.repo.status", { dir: work }); // 记录 lastRepo
  const res = await main.internals.GIT_REPO_TOOL.execute({ action: "status" });
  assert.equal(res.ok, true);
  assert.equal(res.isRepo, true);
  assert.ok(res.branch);
});

await test("GitRepo 工具：未知动作与破坏性动作都明确拒绝", async () => {
  const bad = await main.internals.GIT_REPO_TOOL.execute({ action: "drop-database", dir: work });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown action/);

  const align = await main.internals.GIT_REPO_TOOL.execute({ action: "align", dir: work });
  assert.equal(align.ok, false, "没确认就不许对齐");
  assert.match(align.error, /confirm/);

  const force = await main.internals.GIT_REPO_TOOL.execute({ action: "forcePush", dir: work });
  assert.equal(force.ok, false);
});

await test("GitRepo 工具：stage → commit → push 真跑通", async () => {
  await fs.writeFile(path.join(work, "agent.txt"), "from agent\n", "utf8");
  const staged = await main.internals.GIT_REPO_TOOL.execute({ action: "stage", dir: work, paths: ["agent.txt"] });
  assert.equal(staged.ok, true, staged.message);

  const committed = await main.internals.GIT_REPO_TOOL.execute({ action: "commit", dir: work, message: "feat: agent 提交" });
  assert.equal(committed.ok, true, committed.message);

  const pushed = await main.internals.GIT_REPO_TOOL.execute({ action: "push", dir: work });
  assert.equal(pushed.ok, true, pushed.message);

  const log = await main.internals.GIT_REPO_TOOL.execute({ action: "log", dir: work, count: 1 });
  assert.equal(log.commits[0].subject, "feat: agent 提交");
});

await test("GitIndex 工具：list 汇总本地仓库", async () => {
  const res = await main.internals.GIT_INDEX_TOOL.execute({ action: "list", limit: 10 });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.repos));
});

await main.onUnload();
fsSync.rmSync(tmpRoot, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed / ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed（③ 代码管理，临时仓库已清理）`);
