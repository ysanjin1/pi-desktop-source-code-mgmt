/**
 * 纯函数回归。跑法：node tests/helpers.test.mjs
 *
 * 这些是「改了会静默出错」的地方：SSH config 的就地改写（重复块 / 吞掉别的 Host /
 * 把 CRLF 改成 LF）、URL 校验（拼出来一条能塞进 git 的参数）、判定逻辑（GitHub
 * 认证成功也返回退出码 1）。都有断言兜着，改错立刻挂。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { internals } = require(path.join(here, "..", "main.js"));

const {
  normalizePort,
  sshTarget,
  detectEol,
  parseSshConfig,
  findHostBlock,
  isSafeKeyName,
  identityFor,
  normalizeIdentity,
  keyNameFromIdentity,
  upsertSshBlock,
  sshTestVerdict,
  sshTestTargets,
  stripAnsi,
  parseGhRepoList,
  parseGiteeRepos,
  isAllowedRepoUrl,
  repoNameFromUrl,
  pickKeyName,
  sanitizePrefs,
  tail,
  combinedOutput,
  pickVersionLine,
  installPlan,
  ghDownloadUrl,
  parseVersion,
  compareVersions,
  maskNpmConfig,
  parseNpmPack,
} = internals;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
  }
}

const countHostLines = (text, alias) =>
  text.split(/\r?\n/).filter((line) => new RegExp(`^\\s*Host\\s+.*\\b${alias}\\b`, "i").test(line)).length;

// ── normalizePort ───────────────────────────────────────────────────────────

test("normalizePort 只放行 22/443，其余回退 443", () => {
  assert.equal(normalizePort(22), 22);
  assert.equal(normalizePort("22"), 22);
  assert.equal(normalizePort(443), 443);
  assert.equal(normalizePort("443"), 443);
  assert.equal(normalizePort(" 22 "), 22);
  assert.equal(normalizePort(2222), 443);
  assert.equal(normalizePort(0), 443);
  assert.equal(normalizePort(-22), 443);
  assert.equal(normalizePort(undefined), 443);
  assert.equal(normalizePort(null), 443);
  assert.equal(normalizePort("abc"), 443);
  assert.equal(normalizePort("22; rm -rf /"), 443);
});

// ── sshTarget ───────────────────────────────────────────────────────────────

test("sshTarget：443 走 ssh.github.com，22 走 github.com，Gitee 两者都用自身域名", () => {
  const gh = sshTarget("github");
  assert.equal(gh.alias, "github.com");
  assert.equal(gh.hostFor(443), "ssh.github.com");
  assert.equal(gh.hostFor(22), "github.com");
  assert.equal(gh.hostFor("bogus"), "ssh.github.com");

  const gitee = sshTarget("gitee");
  assert.equal(gitee.alias, "gitee.com");
  assert.equal(gitee.hostFor(443), "gitee.com");
  assert.equal(gitee.hostFor(22), "gitee.com");

  // 未知 provider 归 GitHub（不把脏值写进配置）
  assert.equal(sshTarget("bitbucket").provider, "github");
});

// ── detectEol ───────────────────────────────────────────────────────────────

test("detectEol 跟随文件自身换行符", () => {
  assert.equal(detectEol("a\r\nb"), "\r\n");
  assert.equal(detectEol("a\nb"), "\n");
  assert.equal(detectEol(""), "\n");
});

// ── parseSshConfig ──────────────────────────────────────────────────────────

const SAMPLE = [
  "# 我的 dotfiles",
  "Host github.com",
  "  HostName ssh.github.com",
  "  User git",
  "  IdentityFile ~/.ssh/github_ed25519",
  "  Port 443",
  "",
  "Host gitee.com",
  "  HostName gitee.com",
  "  User git",
  "  Port 22",
  "",
  "Host work",
  "  HostName git.corp.example",
  "  User deploy",
  "",
].join("\n");

test("parseSshConfig 切块、取字段、支持单行多别名", () => {
  const blocks = parseSshConfig(SAMPLE);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0].aliases, ["github.com"]);
  assert.equal(blocks[0].fields.hostname, "ssh.github.com");
  assert.equal(blocks[0].fields.port, "443");
  assert.equal(blocks[2].fields.hostname, "git.corp.example");

  const multi = parseSshConfig("Host a b c\n  User git\n");
  assert.deepEqual(multi[0].aliases, ["a", "b", "c"]);

  // 字段名大小写不敏感（OpenSSH 如此）
  const upper = parseSshConfig("Host x\n  HOSTNAME y\n  PORT 22\n");
  assert.equal(upper[0].fields.hostname, "y");
  assert.equal(upper[0].fields.port, "22");
});

test("findHostBlock 精确匹配别名（不误吞 github.com.evil）", () => {
  assert.ok(findHostBlock(SAMPLE, "github.com"));
  assert.ok(findHostBlock(SAMPLE, "GITHUB.COM"), "别名匹配应大小写不敏感");
  assert.equal(findHostBlock(SAMPLE, "github.com.evil"), null);
  assert.equal(findHostBlock(SAMPLE, "gitlab.com"), null);
});

// ── upsertSshBlock ──────────────────────────────────────────────────────────

test("upsertSshBlock：空文件里新建块", () => {
  const out = upsertSshBlock("", "github", 443, "id_ed25519");
  assert.equal(out.created, true);
  assert.equal(out.changed, true);
  assert.match(out.text, /^Host github\.com$/m);
  assert.match(out.text, /^\s+HostName ssh\.github\.com$/m);
  assert.match(out.text, /^\s+IdentityFile ~\/\.ssh\/id_ed25519$/m);
  assert.match(out.text, /^\s+Port 443$/m);
});

test("upsertSshBlock：幂等 —— 同样的输入第二次不算改动", () => {
  const first = upsertSshBlock("", "github", 443, "id_ed25519");
  const second = upsertSshBlock(first.text, "github", 443, "id_ed25519");
  assert.equal(second.changed, false, "第二次不应产生改动");
  assert.equal(second.text, first.text);
});

test("upsertSshBlock：443 → 22 就地改写，不产生重复块、不动其它 Host", () => {
  const before = ["Host github.com", "  HostName ssh.github.com", "  User git", "  Port 443", "", "Host work", "  HostName git.corp.example", ""].join("\n");
  const out = upsertSshBlock(before, "github", 22, "id_ed25519");
  assert.equal(out.changed, true);
  assert.equal(out.created, false);
  assert.equal(countHostLines(out.text, "github\\.com"), 1, "不允许出现重复的 Host github.com 块");
  assert.match(out.text, /HostName github\.com$/m, "22 端口应用标准端点");
  assert.match(out.text, /Port 22$/m);
  assert.match(out.text, /Host work\n {2}HostName git\.corp\.example/, "其它 Host 块必须原样保留");
});

test("upsertSshBlock：保留块内注释与未知字段", () => {
  const before = [
    "Host github.com",
    "  # 这是我的个人 key",
    "  User git",
    "  Compression yes",
    "  Port 443",
    "",
  ].join("\n");
  const out = upsertSshBlock(before, "github", 443, "id_ed25519");
  assert.match(out.text, /# 这是我的个人 key/, "块内注释不能被吞");
  assert.match(out.text, /Compression yes/, "无关字段必须保留");
  assert.match(out.text, /IdentityFile ~\/\.ssh\/id_ed25519/, "缺的键要补上");
});

test("upsertSshBlock：CRLF 文件改写后仍是 CRLF（不产生混合换行）", () => {
  const before = "Host github.com\r\n  HostName ssh.github.com\r\n  User git\r\n  Port 443\r\n";
  const out = upsertSshBlock(before, "github", 22, "id_ed25519");
  assert.equal(out.eol, "\r\n");
  assert.ok(out.text.includes("\r\n"), "应保留 CRLF");
  assert.equal(/(^|[^\r])\n/.test(out.text), false, "不得出现裸 LF（混合换行会在 dotfiles 里炸出整段 diff）");
  assert.match(out.text, /Port 22\r\n/);
});

test("upsertSshBlock：追加 Gitee 块不影响 GitHub 块", () => {
  const gh = upsertSshBlock("", "github", 443, "id_ed25519").text;
  const both = upsertSshBlock(gh, "gitee", 443, "id_ed25519");
  assert.equal(both.created, true);
  assert.equal(countHostLines(both.text, "github\\.com"), 1);
  assert.equal(countHostLines(both.text, "gitee\\.com"), 1);
  assert.match(both.text, /Host gitee\.com\n {2}HostName gitee\.com/);

  // 再改 GitHub 端口时 Gitee 块必须纹丝不动
  const after = upsertSshBlock(both.text, "github", 22, "id_ed25519");
  const giteeBlock = after.text.slice(after.text.indexOf("Host gitee.com"));
  assert.match(giteeBlock, /HostName gitee\.com/);
  assert.equal(/Port 22/.test(giteeBlock.split("Host ")[1] || ""), false, "Gitee 块不该被改成 22");
});

test("upsertSshBlock：整份样本配置里只改目标块", () => {
  const out = upsertSshBlock(SAMPLE, "gitee", 443, "gitee_ed25519");
  assert.equal(countHostLines(out.text, "gitee\\.com"), 1);
  // 缺的键补在块尾（顺序无关，OpenSSH 不看顺序），已有的键就地改写
  const giteeStart = out.text.indexOf("Host gitee.com");
  const giteeBlock = out.text.slice(giteeStart, out.text.indexOf("Host work", giteeStart));
  assert.match(giteeBlock, /HostName gitee\.com/);
  assert.match(giteeBlock, /IdentityFile ~\/\.ssh\/gitee_ed25519/);
  assert.match(giteeBlock, /Port 443/);
  assert.match(giteeBlock, /User git/);
  assert.ok(out.text.includes("# 我的 dotfiles"), "文件头注释保留");
  assert.match(out.text, /Host work\n {2}HostName git\.corp\.example\n {2}User deploy/, "第三个块原样保留");
});

// ── 密钥名 ──────────────────────────────────────────────────────────────────

test("isSafeKeyName 拒绝路径穿越与选项注入", () => {
  assert.equal(isSafeKeyName("id_ed25519"), true);
  assert.equal(isSafeKeyName("github_ed25519"), true);
  assert.equal(isSafeKeyName("../escape"), false);
  assert.equal(isSafeKeyName("a/b"), false);
  assert.equal(isSafeKeyName("a b"), false);
  assert.equal(isSafeKeyName("-rf"), false);
  assert.equal(isSafeKeyName(""), false);
  assert.equal(isSafeKeyName(null), false);
  assert.equal(isSafeKeyName("x".repeat(65)), false);
});

test("identityFor 只写 ~/.ssh/<name>，坏名字回退默认", () => {
  assert.equal(identityFor("id_ed25519"), "~/.ssh/id_ed25519");
  assert.equal(identityFor("../../etc/passwd"), "~/.ssh/id_ed25519");
});

test("pickKeyName 按平台挑：github / gitee 各挑名字里带自己名字的钥匙", () => {
  // 本机真实情形：一把 gitee_skill_patent、一把 id_ed25519_github_codexsync，
  // 没有 id_ed25519。老实现不分平台，会给 GitHub 选出 gitee 那把。
  const keys = ["gitee_skill_patent", "id_ed25519_github_codexsync"];
  assert.equal(pickKeyName(keys, "github"), "id_ed25519_github_codexsync");
  assert.equal(pickKeyName(keys, "gitee"), "gitee_skill_patent");
  // 平台名都没出现时退回 id_ed25519，再退回字母序
  assert.equal(pickKeyName(["work", "alpha"], "github"), "alpha");
  assert.equal(pickKeyName(["work", "id_ed25519"], "github"), "id_ed25519");
  assert.equal(pickKeyName(["gitee_x", "id_ed25519"], "gitee"), "gitee_x");
  assert.equal(pickKeyName([], "github"), "id_ed25519");
  assert.equal(pickKeyName(null, "gitee"), "id_ed25519");
});

test("normalizeIdentity：裸名字补 ~/.ssh/，已有路径原样保留", () => {
  assert.equal(normalizeIdentity("id_ed25519"), "~/.ssh/id_ed25519");
  assert.equal(normalizeIdentity("gitee_skill_patent"), "~/.ssh/gitee_skill_patent");
  // 别人写的路径不要替它重写
  assert.equal(normalizeIdentity("~/.ssh/github_ed25519"), "~/.ssh/github_ed25519");
  assert.equal(normalizeIdentity("C:/keys/github"), "C:/keys/github");
  assert.equal(normalizeIdentity("%d/.ssh/id_ed25519"), "%d/.ssh/id_ed25519");
  assert.equal(normalizeIdentity(""), "~/.ssh/id_ed25519");
});

test("keyNameFromIdentity 从配置值反推密钥名", () => {
  assert.equal(keyNameFromIdentity("~/.ssh/gitee_skill_patent"), "gitee_skill_patent");
  assert.equal(keyNameFromIdentity("~/.ssh/id_ed25519_github_codexsync"), "id_ed25519_github_codexsync");
  assert.equal(keyNameFromIdentity("C:\\Users\\me\\.ssh\\work"), "work");
  assert.equal(keyNameFromIdentity("~/.ssh/x.pub"), "x");
  assert.equal(keyNameFromIdentity(""), "");
});

// ── sshTestVerdict ──────────────────────────────────────────────────────────

test("sshTestVerdict：GitHub 认证成功返回退出码 1 也算成功", () => {
  const v = sshTestVerdict({
    code: 1,
    stdout: "",
    stderr: "Hi Zhucy123! You've successfully authenticated, but GitHub does not provide shell access.",
  });
  assert.equal(v.ok, true);
  assert.equal(v.account, "Zhucy123");
  assert.match(v.message, /已认证/);
});

test("sshTestVerdict：Gitee 退出码 0 的成功", () => {
  const v = sshTestVerdict({ code: 0, stdout: "Hi someone! You've successfully authenticated, but Gitee.com does not provide shell access.", stderr: "" });
  assert.equal(v.ok, true);
  assert.equal(v.account, "someone");
});

test("sshTestVerdict：失败场景给可操作提示", () => {
  const denied = sshTestVerdict({ code: 255, stdout: "", stderr: "git@github.com: Permission denied (publickey)." });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /公钥/);

  const timeout = sshTestVerdict({ code: 255, stdout: "", stderr: "ssh: connect to host ssh.github.com port 22: Connection timed out" });
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /443/, "22 被封时要提示改用 443");

  const refused = sshTestVerdict({ code: 255, stdout: "", stderr: "Connection refused" });
  assert.equal(refused.ok, false);

  const junk = sshTestVerdict({ code: -1, stdout: "", stderr: "" });
  assert.equal(junk.ok, false, "拿不准时不能谎报成功");
});

// ── 仓库地址与列表 ──────────────────────────────────────────────────────────

test("isAllowedRepoUrl 只放行 https/ssh 与 git@host:path", () => {
  assert.equal(isAllowedRepoUrl("https://github.com/a/b.git"), true);
  assert.equal(isAllowedRepoUrl("https://gitee.com/a/b"), true);
  assert.equal(isAllowedRepoUrl("git@github.com:a/b.git"), true);
  assert.equal(isAllowedRepoUrl("ssh://git@host:22/a/b.git"), true);
  assert.equal(isAllowedRepoUrl("https://github.com/a/b; rm -rf /"), false);
  assert.equal(isAllowedRepoUrl("https://github.com/a/b && whoami"), false);
  assert.equal(isAllowedRepoUrl("git@host:a b"), false);
  assert.equal(isAllowedRepoUrl("file:///c:/windows/system32"), false);
  assert.equal(isAllowedRepoUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedRepoUrl("$(whoami)"), false);
  assert.equal(isAllowedRepoUrl("`id`"), false);
  assert.equal(isAllowedRepoUrl(""), false);
  assert.equal(isAllowedRepoUrl("https://" + "a".repeat(600)), false);
});

test("repoNameFromUrl 推导目录名并拒绝 ..", () => {
  assert.equal(repoNameFromUrl("git@github.com:a/b.git"), "b");
  assert.equal(repoNameFromUrl("https://gitee.com/a/my.repo.git/"), "my.repo");
  assert.equal(repoNameFromUrl("https://github.com/a/b"), "b");
  assert.equal(repoNameFromUrl(""), "");
  assert.equal(repoNameFromUrl("https://github.com/a/.."), "");
  assert.equal(repoNameFromUrl("https://github.com/a/."), "");
});

test("parseGhRepoList 容错：坏 JSON / 缺字段都不抛", () => {
  const rows = parseGhRepoList(JSON.stringify([
    { name: "alpha", sshUrl: "git@github.com:me/alpha.git", isPrivate: true },
    { name: "", sshUrl: "x" },
    null,
    { name: "beta", sshUrl: "", isPrivate: false },
  ]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "alpha", sshUrl: "git@github.com:me/alpha.git", isPrivate: true });
  assert.equal(rows[1].sshUrl, "");
  assert.deepEqual(parseGhRepoList("not json"), []);
  assert.deepEqual(parseGhRepoList(""), []);
});

test("parseGiteeRepos 缺 ssh_url 时按 full_name 拼，并容忍 public 字段", () => {
  const rows = parseGiteeRepos(JSON.stringify([
    { name: "gamma", full_name: "me/gamma", public: false },
    { path: "delta", full_name: "me/delta", public: true },
    { name: "", full_name: "me/x" },
  ]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "gamma");
  assert.equal(rows[0].sshUrl, "git@gitee.com:me/gamma.git");
  assert.equal(rows[0].isPrivate, true);
  assert.equal(rows[1].isPrivate, false);
  assert.deepEqual(parseGiteeRepos("null"), []);
});

// ── prefs ───────────────────────────────────────────────────────────────────

test("sanitizePrefs 收敛脏值（且不再保存端口）", () => {
  assert.deepEqual(sanitizePrefs({ provider: "gitee", port: 22, cloneParent: "C:\\work" }), {
    provider: "gitee",
    cloneParent: "C:\\work",
    lastRepo: "",
  });
  assert.deepEqual(sanitizePrefs({ provider: "evil", port: "9999", cloneParent: 42 }), {
    provider: "github",
    cloneParent: "",
    lastRepo: "",
  });
  assert.deepEqual(sanitizePrefs(null), { provider: "github", cloneParent: "", lastRepo: "" });
  // 端口被刻意丢弃：两个平台的端口各自在 ~/.ssh/config 里，配置才是权威
  assert.equal("port" in sanitizePrefs({ port: 22 }), false);
  // lastRepo 只接受绝对路径
  assert.equal(sanitizePrefs({ lastRepo: "relative/dir" }).lastRepo, "");
  assert.equal(sanitizePrefs({ lastRepo: "C:\\repo" }).lastRepo, "C:\\repo");
});

// ── 「测试连接」该连谁（v0.2.1） ─────────────────────────────────────────────

const GH_BLOCK = {
  aliases: ["github.com"],
  start: 0,
  end: 6,
  fields: { hostname: "ssh.github.com", port: "443", identityfile: "~/.ssh/id_ed25519_github_codexsync" },
};

test("sshTestTargets：有配置且端口一致 → 连别名，让 config 生效", () => {
  const plan = sshTestTargets("github", GH_BLOCK, 443);
  assert.equal(plan.mode, "config");
  assert.equal(plan.host, "github.com", "必须连别名，不是块里的 HostName ssh.github.com");
  assert.equal(plan.port, 443);
  const auto = sshTestTargets("github", GH_BLOCK, null);
  assert.equal(auto.mode, "config");
  assert.equal(auto.host, "github.com");
});

test("sshTestTargets：端口与配置不一致 → 直连对应端点", () => {
  const plan = sshTestTargets("github", GH_BLOCK, 22);
  assert.equal(plan.mode, "direct");
  assert.equal(plan.host, "github.com");
  assert.equal(plan.port, 22);
  assert.equal(sshTestTargets("github", GH_BLOCK, 443).mode, "config", "同值应回到 config 模式");
});

test("sshTestTargets：没有配置块 → 直连该端口的端点", () => {
  assert.deepEqual(sshTestTargets("github", null, null), {
    mode: "direct",
    port: 443,
    configPort: 0,
    host: "ssh.github.com",
  });
  assert.equal(sshTestTargets("github", null, 22).host, "github.com");
  const gitee = sshTestTargets("gitee", null, 22);
  assert.equal(gitee.host, "gitee.com");
  assert.equal(gitee.mode, "direct");
});

test("sshTestVerdict：命令没有输出时也要给出原因，不再只说「未知失败」", () => {
  const silent = sshTestVerdict({ code: 255, stdout: "", stderr: "" });
  assert.equal(silent.ok, false);
  assert.match(silent.message, /255/);
  assert.doesNotMatch(silent.message, /未知失败/);

  const withErr = sshTestVerdict({ code: 255, stdout: "", stderr: "", errorMessage: "Command failed: ssh -T git@github.com" });
  assert.match(withErr.message, /ssh/i, "至少要把 Node 的错误消息透出来");
});

test("sshTestVerdict：Gitee 带 ANSI 颜色的欢迎语也能认出账号", () => {
  const line =
    "Hi \u001b[36;01m会飞的羊(@sanjinxinxinxin)\u001b[0m! You've \u001b[32msuccessfully\u001b[0m authenticated, but GITEE.COM does not provide shell access.";
  const v = sshTestVerdict({ code: 0, stdout: line });
  assert.equal(v.ok, true);
  assert.equal(v.account, "会飞的羊(@sanjinxinxinxin)");
  assert.doesNotMatch(v.message, /\u001b/);
});

test("sshTestVerdict：known_hosts 冲突给人话提示", () => {
  const v = sshTestVerdict({ code: 255, stdout: "Host key verification failed.", stderr: "" });
  assert.equal(v.ok, false);
  assert.match(v.message, /known_hosts|指纹/);
});

// ── 版本行提取（v0.1.1：ssh 把版本写 stderr、退出码可能非零） ──────────────

test("pickVersionLine：ssh -V 的版本在 stderr 上也能取到", () => {
  const line = pickVersionLine("", "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\r\n");
  assert.equal(line, "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2");
});

test("pickVersionLine：不把 Node 的 Command failed / spawn ENOENT 当版本", () => {
  assert.equal(pickVersionLine("", "Command failed: C:\\Windows\\System32\\OpenSSH\\ssh.exe -V"), "");
  assert.equal(pickVersionLine("", "spawn ssh ENOENT"), "");
  // 真版本行即使混在噪音里也要挑出来
  assert.equal(
    pickVersionLine("Command failed: x -V\nOpenSSH_for_Windows_9.5p2", ""),
    "OpenSSH_for_Windows_9.5p2",
  );
});

test("pickVersionLine：git / gh 的 stdout 首行", () => {
  assert.equal(pickVersionLine("git version 2.53.0.windows.2\n", ""), "git version 2.53.0.windows.2");
  assert.equal(pickVersionLine("gh version 2.103.3 (2026-10-26)\nrelease notes follow\n", ""), "gh version 2.103.3 (2026-10-26)");
});

test("combinedOutput：stderr → stdout → Node 错误消息 的优先级", () => {
  assert.equal(combinedOutput({ stderr: "e", stdout: "o", errorMessage: "m" }), "e");
  assert.equal(combinedOutput({ stderr: "", stdout: "o", errorMessage: "m" }), "o");
  assert.equal(combinedOutput({ stderr: "", stdout: "", errorMessage: "m" }), "m");
  assert.equal(combinedOutput({}), "");
});

// ── ① 安装计划与下载地址（v0.4.0：不降级，真跑安装器） ────────────────────

test("installPlan：Windows 的 gh 有版本+镜像 → 走镜像 msi，需要提权", () => {
  const plan = installPlan("gh", { platform: "win32", hasWinget: true, ghVersion: "2.103.3", mirror: "gh-proxy.com" });
  assert.equal(plan.method, "msi-mirror");
  assert.equal(plan.needsElevation, true);
  assert.equal(plan.available, true);
  assert.match(plan.command, /msiexec \/i/);
  assert.match(plan.command, /^curl\.exe/);
});

test("installPlan：Windows 的 gh 没版本 → 退 winget，没 winget 就标不可用", () => {
  const withWinget = installPlan("gh", { platform: "win32", hasWinget: true, ghVersion: "", mirror: "official" });
  assert.equal(withWinget.method, "winget");
  assert.equal(withWinget.available, true);
  const without = installPlan("gh", { platform: "win32", hasWinget: false, ghVersion: "", mirror: "official" });
  assert.equal(without.available, false, "没有 winget 又拿不到版本时必须明说不可用，不能假装能装");
});

test("installPlan：各平台的 git / ssh", () => {
  assert.equal(installPlan("git", { platform: "win32", hasWinget: true }).available, true);
  assert.equal(installPlan("git", { platform: "darwin", hasBrew: true }).method, "brew");
  assert.equal(installPlan("git", { platform: "darwin", hasBrew: false }).method, "xcode-clt");
  assert.equal(installPlan("git", { platform: "linux" }).method, "package-manager");
  assert.equal(installPlan("ssh", { platform: "win32" }).method, "windows-capability");
  assert.equal(installPlan("ssh", { platform: "darwin" }).method, "builtin");
  assert.equal(installPlan("ssh", { platform: "linux" }).needsElevation, true);
  assert.equal(installPlan("npm", { platform: "win32" }), null, "未知工具必须返回 null，不能编一个计划出来");
});

test("ghDownloadUrl：按平台/架构拼官方地址，镜像只是前缀", () => {
  assert.equal(
    ghDownloadUrl("2.103.3", "win32", "x64", "official"),
    "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_amd64.msi",
  );
  assert.equal(
    ghDownloadUrl("2.103.3", "linux", "x64", "ghfast.top"),
    "https://ghfast.top/https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz",
  );
  assert.equal(
    ghDownloadUrl("2.103.3", "darwin", "arm64", "official"),
    "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_macOS_arm64.tar.gz",
  );
  // 未知镜像 id 要回退到第一个，不能拼出一个空前缀的怪地址
  assert.ok(ghDownloadUrl("1.0.0", "win32", "x64", "不存在的镜像").startsWith("https://gh-proxy.com/"));
});

test("parseVersion / compareVersions", () => {
  assert.deepEqual(parseVersion("gh version 2.103.3 (2026-10-26)"), [2, 103, 3]);
  assert.equal(parseVersion("no digits"), null);
  assert.equal(compareVersions("2.103.3", "2.97.0"), 1);
  assert.equal(compareVersions("2.50.0", "2.53.0"), -1);
  assert.equal(compareVersions("2.53.0", "2.53.0"), 0);
  assert.equal(compareVersions("bogus", "1.0.0"), 0, "解析不出来时按相等处理，不谎报有更新");
});

// ── ⑤ npm 向导的纯函数 ─────────────────────────────────────────────────────

test("maskNpmConfig 抹掉凭据但保留 registry", () => {
  const masked = maskNpmConfig(
    ["//registry.npmjs.org/:_authToken=abc123", "registry=https://registry.npmjs.org/", "_password=secret"].join("\n"),
  );
  assert.doesNotMatch(masked, /abc123/);
  assert.doesNotMatch(masked, /secret/);
  assert.match(masked, /_authToken= \*\*\*\*\*\*/);
  assert.match(masked, /registry=https:\/\/registry\.npmjs\.org\//);
});

test("parseNpmPack 兼容数组与对象两种输出", () => {
  const arr = parseNpmPack(JSON.stringify([{ name: "a", version: "1.0.0", filename: "a-1.0.0.tgz", files: [{}, {}], size: 2048, unpackedSize: 4096 }]));
  assert.equal(arr.name, "a");
  assert.equal(arr.files, 2);
  assert.equal(arr.size, 2048);
  const obj = parseNpmPack(JSON.stringify({ name: "b", version: "2.0.0", files: [] }));
  assert.equal(obj.name, "b");
  assert.equal(obj.files, 0);
  assert.equal(parseNpmPack("not json"), null);
  assert.equal(parseNpmPack("[]"), null);
});

// ── 结果 ────────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed / ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed`);
