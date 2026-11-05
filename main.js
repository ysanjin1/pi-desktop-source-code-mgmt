"use strict";

/**
 * local.source-code-mgmt — ② SSH 密钥与连接 + ④ 克隆仓库
 *
 * 移植自 DSH 插件 source-code-mgmt 的 ②④ 两块，宿主换成 PI-Desktop：
 *   DSH：40 条 HTTP 路由（ctx.webServer.register）→ 这里改成 onPanelInvoke 的通道表
 *   视图：window.pluginBridge.invoke("scm.*", payload) → CHANNELS[name]
 *
 * 只依赖 Node 内置模块。唯一的网络访问是 Gitee OpenAPI（用你粘贴的令牌，仅 gitee.com）。
 *
 * 三条硬边界：
 *   1. 不拼 shell 字符串：所有外部命令走 execFile + 参数数组 + 显式 cwd。
 *   2. 写 ~/.ssh/config 只在按按钮时发生：先备份 → 就地改写目标 Host 块
 *      （不动其它块、保留文件自身换行符）→ chmod 0600。
 *   3. 每个平台的端口与密钥各自独立，取自该平台现有配置；改写一个平台
 *      绝不动另一个平台（两个平台常用不同密钥，串了就会弄坏认证）。
 *
 * 插件进程拿不到宿主环境变量（process.env.PATH 可能为空），因此 git / ssh / gh
 * 按「环境变量覆盖 → 已知安装位置 → Windows 注册表 → PATH → 裸命令名」解析，
 * 并在面板 ① 里如实显示解析方式；找不到就写找不到，不假装成功。
 */

const { execFile, execFileSync } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const VERSION = "0.9.3";
const HOME = os.homedir();
const SSH_DIR = path.join(HOME, ".ssh");
const SSH_CONFIG = path.join(SSH_DIR, "config");
const IS_WIN = process.platform === "win32";

const BIN_NAMES = ["git", "ssh", "ssh-keygen", "gh"];
const TIMEOUT = { probe: 12000, sshTest: 25000, gh: 25000, net: 9000, git: 20000 };
const DEFAULT_PORT = 443;
const REPO_LIMIT = 300;
const GITEE_PAGE_SIZE = 100;
const GITEE_MAX_PAGES = 3;
const CLONE_LOG_LIMIT = 20000;

/** 插件数据目录（onLoad 由宿主给出）：存偏好与 Gitee 令牌，0600。 */
let dataPath = null;

/**
 * 偏好只存「当前平台 + 克隆父目录」。
 * 刻意**不存端口**：两个平台的端口各自写在 ~/.ssh/config 里，配置才是权威。
 */
let prefs = { provider: "github", cloneParent: "" };

/** 二进制解析缓存：{ path, source } */
const binCache = new Map();

/** 克隆任务表：面板通道 30s 超时，克隆可能几分钟，所以起任务 + 轮询。 */
const cloneJobs = new Map();
let cloneSeq = 0;

// ── 二进制解析 ──────────────────────────────────────────────────────────────

/**
 * 同步读一个注册表值（只读，reg.exe 绝对路径、不经 shell、env 给空、丢弃 stderr）。
 * 为什么需要：本机 git 装在 E:\Git，PATH 又拿不到，只靠常见位置会误报缺失。
 */
function winRegValue(key, valueName) {
  try {
    const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    if (!fsSync.existsSync(reg)) return null;
    const args = ["query", key];
    if (valueName) args.push("/v", valueName);
    const out = execFileSync(reg, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of String(out).split(/\r?\n/)) {
      if (valueName && !line.includes(valueName)) continue;
      const m = /REG_SZ\s+(.+?)\s*$/.exec(line);
      if (m) return m[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** Windows：由注册表推出的候选可执行文件。 */
function windowsRegistryCandidates(name) {
  const out = [];
  if (name === "git") {
    for (const key of ["HKLM\\SOFTWARE\\GitForWindows", "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows"]) {
      const install = winRegValue(key, "InstallPath");
      if (install) out.push(path.join(install, "cmd", "git.exe"), path.join(install, "bin", "git.exe"));
    }
    const appPath = winRegValue("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\git.exe", "");
    if (appPath) out.push(appPath.replace(/^"|"$/g, ""));
  }
  if (name === "gh") {
    const appPath = winRegValue("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\gh.exe", "");
    if (appPath) out.push(appPath.replace(/^"|"$/g, ""));
  }
  return out;
}

/** 硬编码的常见安装位置（不含注册表结果）。 */
function candidatePaths(name) {
  const out = [];
  if (IS_WIN) {
    const localApp = path.join(HOME, "AppData", "Local");
    if (name === "git") {
      out.push(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
        "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        path.join(localApp, "Programs", "Git", "cmd", "git.exe"),
      );
    }
    if (name === "ssh" || name === "ssh-keygen") {
      out.push(
        path.join("C:\\Windows\\System32\\OpenSSH", name + ".exe"),
        path.join("C:\\Program Files\\Git", "usr", "bin", name + ".exe"),
        path.join("C:\\Program Files\\Git", "bin", name + ".exe"),
      );
    }
    if (name === "gh") {
      out.push(
        "C:\\Program Files\\GitHub CLI\\gh.exe",
        path.join(localApp, "Programs", "GitHub CLI", "gh.exe"),
        path.join(HOME, "scoop", "shims", "gh.exe"),
        "C:\\ProgramData\\chocolatey\\bin\\gh.exe",
      );
    }
    // winget / curl 也要能绝对路径解析：插件进程多半没有 PATH
    if (name === "winget") {
      out.push(
        path.join(localApp, "Microsoft", "WindowsApps", "winget.exe"),
        "C:\\Program Files\\WindowsApps\\winget.exe",
      );
    }
    if (name === "curl") {
      const root = (process.env && process.env.SystemRoot) || "C:\\Windows";
      out.push(path.join(root, "System32", "curl.exe"));
    }
    if (name === "node" || name === "npm") {
      const file = name === "npm" ? "npm.cmd" : "node.exe";
      out.push(
        "C:\\Program Files\\nodejs\\" + file,
        path.join(localApp, "Programs", "nodejs", file),
        path.join(HOME, "AppData", "Roaming", "npm", file),
        path.join(HOME, "scoop", "shims", file),
      );
    }
  } else {
    out.push(
      "/usr/bin/" + name,
      "/usr/local/bin/" + name,
      "/opt/homebrew/bin/" + name,
      "/bin/" + name,
      path.join(HOME, ".local", "bin", name),
    );
  }
  return out;
}

function findOnPath(name) {
  const envPath = (process.env && process.env.PATH) || "";
  if (!envPath) return null;
  const exts = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of envPath.split(IS_WIN ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (fsSync.existsSync(p)) return p;
    }
  }
  return null;
}

function resolveBin(name) {
  if (binCache.has(name)) return binCache.get(name);
  const envKey = "SCM_" + name.toUpperCase().replace(/-/g, "_");
  const override = process.env ? process.env[envKey] : undefined;
  let found = null;
  if (override && fsSync.existsSync(override)) found = { path: override, source: "env:" + envKey };
  if (!found) {
    for (const p of candidatePaths(name)) {
      if (fsSync.existsSync(p)) {
        found = { path: p, source: "known-location" };
        break;
      }
    }
  }
  if (!found && IS_WIN) {
    for (const p of windowsRegistryCandidates(name)) {
      if (fsSync.existsSync(p)) {
        found = { path: p, source: "registry" };
        break;
      }
    }
  }
  if (!found) {
    const onPath = findOnPath(name);
    if (onPath) found = { path: onPath, source: "PATH" };
  }
  const result = found || { path: null, source: "missing" };
  binCache.set(name, result);
  return result;
}

// ── 子进程 ──────────────────────────────────────────────────────────────────

function childEnv(options) {
  const env = Object.assign({}, process.env || {});
  if (!env.HOME) env.HOME = HOME;
  if (IS_WIN && !env.USERPROFILE) env.USERPROFILE = HOME;
  // Windows 下缺 SystemRoot/WINDIR 时子进程行为不可预期（实测 OpenSSH 会出现
  // 「有版本输出但退出码非零」），补上这两个基本量。
  if (IS_WIN) {
    if (!env.SystemRoot) env.SystemRoot = "C:\\Windows";
    if (!env.WINDIR) env.WINDIR = env.SystemRoot;
    if (!env.ComSpec) env.ComSpec = path.join(env.SystemRoot, "System32", "cmd.exe");
    // 实测：缺 ProgramData 时 Windows OpenSSH 会「无输出、退出 255」——
    // 外面看到的就是「未知失败」。这些量全部兜底，别让工具静默死掉。
    if (!env.ProgramData) env.ProgramData = "C:\\ProgramData";
    if (!env.ALLUSERSPROFILE) env.ALLUSERSPROFILE = env.ProgramData;
    if (!env.APPDATA) env.APPDATA = path.join(HOME, "AppData", "Roaming");
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(HOME, "AppData", "Local");
    if (!env.TEMP) env.TEMP = path.join(env.LOCALAPPDATA, "Temp");
    if (!env.TMP) env.TMP = env.TEMP;
  }
  // 永不交互：拿不到凭据就失败，不挂在等待输入上
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GCM_INTERACTIVE = "never";
  // 没有 PATH 时补一条最小 PATH：winget / curl / node 这些常常只能靠名字找到
  // （winget.exe 是「应用执行别名」，existsSync 会因 ACL 返回 false，只能靠 PATH 或真跑探测）
  if (IS_WIN && !env.PATH) {
    const localApp = path.join(HOME, "AppData", "Local");
    env.PATH = [
      path.join(env.SystemRoot, "System32"),
      env.SystemRoot,
      path.join(env.SystemRoot, "System32", "Wbem"),
      path.join(localApp, "Microsoft", "WindowsApps"),
      "C:\\Program Files\\nodejs",
      "C:\\Program Files\\Git\\cmd",
      path.join(HOME, ".local", "bin"),
    ].join(";");
  }
  if (options && options.useGitSsh) {
    const ssh = resolveBin("ssh");
    // Windows 上 Git 自带 MSYS ssh.exe 在 detached 进程里可能报
    // "couldn't create signal pipe, Win32 error 5"；优先指向系统 OpenSSH。
    if (ssh.path) env.GIT_SSH = ssh.path;
  }
  return env;
}

function run(binPath, args, options = {}) {
  // 只接受字符串：曾经把 resolveBin() 的整个 { path, source } 传进来，
  // 报错信息是「The "file" argument must be of type string」，与 git 无关，很误导。
  const bin = typeof binPath === "string" ? binPath : "";
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ code: -1, failed: true, stdout: "", stderr: "", errorMessage: "没有可执行文件" });
      return;
    }
    execFile(
      bin,
      args,
      {
        windowsHide: true,
        timeout: options.timeout || TIMEOUT.git,
        maxBuffer: 8 * 1024 * 1024,
        env: childEnv(options),
        cwd: options.cwd,
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
        const out = String(stdout || "");
        const errOut = String(stderr || "");
        resolve({
          code,
          failed: Boolean(error),
          stdout: out,
          stderr: errOut,
          // 只有「既没有任何输出、又是失败」时才兜入 Node 的 "Command failed: …"，
          // 否则它会把真实输出（如 ssh -V 的版本行）顶掉。
          errorMessage: !out && !errOut && error ? String(error.message || "") : "",
        });
      },
    );
  });
}

/** 输出尾部（给用户看时截断，别把整段日志灌进面板）。 */
function tail(text, limit = 800) {
  const s = String(text || "").trim();
  return s.length <= limit ? s : "…" + s.slice(-limit);
}

/** 一次调用的「人话」错误文本：stderr → stdout → Node 错误消息。 */
function combinedOutput(result) {
  const r = result || {};
  return r.stderr || r.stdout || r.errorMessage || "";
}

/** 从探测输出里挑「版本那一行」，滤掉 Node 的失败兜底消息。 */
function pickVersionLine(stdout, stderr) {
  const lines = `${stderr || ""}\n${stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Command failed:/i.test(line) && !/^spawn\s/i.test(line));
  return lines[0] || "";
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}

// ── 纯函数（tests/ 直接断言） ───────────────────────────────────────────────

/** 端口只认 22 / 443，其它一律回退 443。绝不用 parseInt（它会把 "22; rm -rf /" 读成 22）。 */
function normalizePort(value) {
  if (typeof value === "number") return value === 22 ? 22 : 443;
  const s = String(value === undefined || value === null ? "" : value).trim();
  return s === "22" ? 22 : 443;
}

function normalizeProvider(value) {
  return String(value || "").toLowerCase() === "gitee" ? "gitee" : "github";
}

function detectEol(text) {
  return String(text || "").includes("\r\n") ? "\r\n" : "\n";
}

/** provider → { provider, alias, label, hostFor(port) } */
function sshTarget(provider) {
  const p = normalizeProvider(provider);
  if (p === "gitee") {
    return { provider: p, alias: "gitee.com", label: "Gitee", hostFor: () => "gitee.com" };
  }
  return {
    provider: p,
    alias: "github.com",
    label: "GitHub",
    // 443 走 GitHub 官方支持的 ssh.github.com（绕开被封的 22），22 走标准端点
    hostFor: (port) => (normalizePort(port) === 443 ? "ssh.github.com" : "github.com"),
  };
}

const HOST_LINE = /^\s*Host\s+(.+?)\s*$/i;
const KEY_LINE = /^(\s*)([A-Za-z]+)(\s+)(.+?)\s*$/;
const CANONICAL_KEY = { hostname: "HostName", user: "User", identityfile: "IdentityFile", port: "Port" };

/** 切块：每个 Host 段的别名、行区间、字段（字段名小写）。 */
function parseSshConfig(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = HOST_LINE.exec(lines[i]);
    if (m) {
      if (current) {
        current.end = i;
        blocks.push(current);
      }
      current = { aliases: m[1].split(/\s+/).filter(Boolean), start: i, end: lines.length, fields: {} };
      continue;
    }
    if (!current) continue;
    const kv = KEY_LINE.exec(lines[i]);
    if (kv) current.fields[kv[2].toLowerCase()] = kv[4];
  }
  if (current) blocks.push(current);
  return blocks;
}

/** 精确匹配别名（大小写不敏感，但不做后缀匹配：github.com.evil 不算）。 */
function findHostBlock(text, alias) {
  const needle = String(alias || "").toLowerCase();
  return parseSshConfig(text).find((b) => b.aliases.some((a) => a.toLowerCase() === needle)) || null;
}

function isSafeKeyName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(name) && !name.startsWith("-");
}

/** 裸密钥名 → ~/.ssh/<name>（可移植，也不把绝对路径写进配置）。 */
function identityFor(keyName) {
  return "~/.ssh/" + (isSafeKeyName(keyName) ? keyName : "id_ed25519");
}

/** 裸名字补成 ~/.ssh/…；已经带 ~ 或路径的原样保留（别替用户重写别处的写法）。 */
function normalizeIdentity(value) {
  const s = String(value === undefined || value === null ? "" : value).trim();
  if (!s) return identityFor("id_ed25519");
  if (!s.includes("/") && !s.includes("\\") && !s.startsWith("~")) return identityFor(s);
  return s;
}

/** 从 IdentityFile 值反推密钥名：~/.ssh/gitee_x → gitee_x */
function keyNameFromIdentity(value) {
  const s = String(value || "").trim().replace(/^"|"$/g, "");
  const base = s.split(/[/\\]/).filter(Boolean).pop() || "";
  return base.replace(/\.pub$/i, "");
}

/**
 * 按平台挑密钥：先找名字里带该平台的（github / gitee），再 id_ed25519，最后字母序。
 * 不分平台地取字母序第一个是错的：本机一把 gitee_skill_patent、一把
 * id_ed25519_github_codexsync，那样会给 GitHub 选到 gitee 的钥匙。
 */
function pickKeyName(ed25519Names, provider) {
  const names = (Array.isArray(ed25519Names) ? ed25519Names : []).filter((n) => isSafeKeyName(n));
  if (!names.length) return "id_ed25519";
  const hint = normalizeProvider(provider) === "gitee" ? /gitee/i : /github/i;
  const forProvider = names.find((n) => hint.test(n));
  if (forProvider) return forProvider;
  if (names.includes("id_ed25519")) return "id_ed25519";
  return names.slice().sort()[0];
}

/**
 * 改写 provider 对应的 Host 块。
 * - 已有该 Host：逐键就地改写（保留键序、缩进、块内注释、未知字段）；缺的键补在块尾。
 * - 没有该 Host：追加到末尾。
 * 返回 { text, changed, created, eol }。其它 Host 块与文件换行符原样保留。
 *
 * identity 可以是裸密钥名（→ ~/.ssh/<name>）或配置里的路径（原样写回）。
 */
function upsertSshBlock(text, provider, port, identity) {
  const source = String(text || "");
  const eol = detectEol(source);
  const lines = source.length ? source.split(/\r?\n/) : [];
  const target = sshTarget(provider);
  const want = {
    hostname: target.hostFor(port),
    user: "git",
    identityfile: normalizeIdentity(identity),
    port: String(normalizePort(port)),
  };
  const block = findHostBlock(source, target.alias);

  if (!block) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(`Host ${target.alias}`);
    for (const key of Object.keys(want)) lines.push(`  ${CANONICAL_KEY[key]} ${want[key]}`);
    lines.push("");
    const next = lines.join(eol);
    return { text: next, changed: next !== source, created: true, eol };
  }

  const seen = new Set();
  for (let i = block.end - 1; i > block.start; i -= 1) {
    const kv = KEY_LINE.exec(lines[i]);
    if (!kv) continue;
    const key = kv[2].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(want, key)) continue;
    seen.add(key);
    lines[i] = `${kv[1]}${kv[2]}${kv[3]}${want[key]}`;
  }
  const missing = Object.keys(want).filter((k) => !seen.has(k));
  if (missing.length) {
    let insertAt = block.end;
    while (insertAt > block.start + 1 && lines[insertAt - 1] !== undefined && lines[insertAt - 1].trim() === "") {
      insertAt -= 1;
    }
    const indent = " ".repeat((lines[block.start].match(/^\s*/) || [""])[0].length + 2);
    lines.splice(insertAt, 0, ...missing.map((k) => `${indent}${CANONICAL_KEY[k]} ${want[k]}`));
  }
  const next = lines.join(eol);
  return { text: next, changed: next !== source, created: false, eol };
}

/** 去掉 ANSI 颜色码（Gitee 的 ssh 欢迎语带颜色，直接显示会是乱码）。 */
function stripAnsi(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * SSH 连接测试的判定。GitHub 认证成功也返回退出码 1（不提供 shell），
 * 所以只能看输出，不能只看退出码。
 */
function sshTestVerdict(result) {
  const r = result || {};
  // errorMessage 也要看：命令没输出就失败时（缺环境变量、被安全软件拦、被 kill），
  // 唯一的原因就在它里面 —— 忽略它就会把「为什么失败」变成「未知失败」。
  const out = stripAnsi(`${r.stdout || ""}\n${r.stderr || ""}\n${r.errorMessage || ""}`);
  const m = /^\s*Hi ([^\s!]+)[!,]/im.exec(out);
  const account = m ? m[1] : "";
  const authed = /successfully authenticated/i.test(out) || Boolean(account);
  if (authed) return { ok: true, account, message: account ? `已认证：${account}` : "已认证" };
  if (/permission denied/i.test(out)) {
    return { ok: false, account: "", message: "认证被拒：这把公钥没被该平台接受（未上传，或这台账号不认它）" };
  }
  if (/host key verification failed/i.test(out)) {
    return { ok: false, account: "", message: "主机指纹校验失败：known_hosts 里有冲突记录，需要先清理该主机的旧记录" };
  }
  if (/connection timed out|operation timed out|timed out/i.test(out)) {
    return { ok: false, account: "", message: "连接超时：该端口可能被封（22 被封时改用 443）" };
  }
  if (/connection refused/i.test(out)) return { ok: false, account: "", message: "连接被拒：端口不通，或代理/防火墙拦截" };
  if (/could not resolve|name or service not known/i.test(out)) {
    return { ok: false, account: "", message: "域名解析失败：DNS 或代理把连接吞了" };
  }
  if (/no such file|not found/i.test(out)) return { ok: false, account: "", message: "找不到 ssh 命令" };
  const visible = tail(`${r.stdout || ""}\n${r.stderr || ""}`, 300).trim();
  if (visible) return { ok: false, account: "", message: visible };
  // 真的一无所有时，至少把退出码交出去，别只说「未知失败」
  return {
    ok: false,
    account: "",
    message: `ssh 退出码 ${r.code === undefined ? "未知" : r.code}，没有任何输出（可能是环境变量不全或被安全软件拦截）`,
  };
}

/** GitHub CLI 的仓库列表 JSON → 统一形状；坏 JSON 返回空数组。 */
function parseGhRepoList(stdout) {
  let rows;
  try {
    rows = JSON.parse(String(stdout || "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.name === "string" && r.name)
    .map((r) => ({
      name: r.name,
      sshUrl: typeof r.sshUrl === "string" && r.sshUrl ? r.sshUrl : "",
      isPrivate: Boolean(r.isPrivate),
    }));
}

/** Gitee OpenAPI /user/repos → 统一形状（ssh_url 缺失时按全名拼）。 */
function parseGiteeRepos(stdout) {
  let rows;
  try {
    rows = JSON.parse(String(stdout || "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const name = typeof r.name === "string" ? r.name : typeof r.path === "string" ? r.path : "";
      if (!name) return null;
      const full = typeof r.full_name === "string" ? r.full_name : "";
      const owner = full.includes("/") ? full.split("/")[0] : typeof r.namespace === "object" && r.namespace && typeof r.namespace.path === "string" ? r.namespace.path : "";
      const sshUrl = typeof r.ssh_url === "string" && r.ssh_url ? r.ssh_url : owner ? `git@gitee.com:${owner}/${name}.git` : "";
      return { name, sshUrl, isPrivate: r.private === true || r.public === false };
    })
    .filter(Boolean);
}

const URL_SAFE = /^[A-Za-z0-9._~:/@%+\-\u4e00-\u9fa5]+$/;

/** 只接受 https(s) / ssh / git@host:path，且不含 shell 元字符。 */
function isAllowedRepoUrl(url) {
  const s = String(url || "").trim();
  if (!s || s.length > 512) return false;
  if (!URL_SAFE.test(s)) return false;
  if (/^(https?:\/\/|ssh:\/\/)[^\s/]+\/\S+$/.test(s)) return true;
  if (/^git@[A-Za-z0-9.-]+:[^\s/].+$/.test(s)) return true;
  return false;
}

/** 从仓库地址推导目录名：末段去掉 .git；拒绝 . / .. */
function repoNameFromUrl(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  const seg = s.split(/[/:]/).filter(Boolean).pop() || "";
  const name = seg.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === "." || name === "..") return "";
  return name;
}

// ── 偏好与数据文件 ──────────────────────────────────────────────────────────

function sanitizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    provider: normalizeProvider(src.provider),
    cloneParent: typeof src.cloneParent === "string" ? src.cloneParent : "",
    lastRepo: typeof src.lastRepo === "string" && path.isAbsolute(src.lastRepo) ? src.lastRepo : "",
  };
}

function dataFile(name) {
  return dataPath ? path.join(dataPath, name) : null;
}

async function readJsonFile(name, fallback) {
  const p = dataFile(name);
  if (!p) return fallback;
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function writePrivateFile(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await fs.writeFile(p, text, { mode: 0o600 });
  try {
    await fs.chmod(p, 0o600);
  } catch {
    /* Windows 上 chmod 基本无效 */
  }
}

async function persistPrefs() {
  const p = dataFile("prefs.json");
  if (!p) return;
  try {
    await writePrivateFile(p, JSON.stringify(prefs, null, 2));
  } catch {
    /* 落盘失败不影响本次使用 */
  }
}

// ── ① 环境检查 ──────────────────────────────────────────────────────────────

async function handleEnv(payload = {}) {
  if (payload.refresh) binCache.clear();
  const bins = {};
  for (const name of BIN_NAMES) {
    const r = resolveBin(name);
    bins[name] = { path: r.path, source: r.source };
  }
  // 版本行一律从两个流里挑且不看退出码（ssh 把版本写 stderr，退出码可能非零）
  const versions = {};
  if (bins.git.path) {
    const r = await run(bins.git.path, ["--version"], { timeout: TIMEOUT.probe });
    versions.git = pickVersionLine(r.stdout, r.stderr);
  }
  if (bins.ssh.path) {
    const r = await run(bins.ssh.path, ["-V"], { timeout: TIMEOUT.probe });
    versions.ssh = pickVersionLine(r.stdout, r.stderr) || r.errorMessage;
  }
  if (bins["ssh-keygen"].path) versions["ssh-keygen"] = "found";
  if (bins.gh.path) {
    const r = await run(bins.gh.path, ["--version"], { timeout: TIMEOUT.probe });
    versions.gh = pickVersionLine(r.stdout, r.stderr);
  }
  return {
    ok: true,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    home: HOME,
    sshDir: SSH_DIR,
    // 插件进程拿不到宿主环境变量：这一项如实暴露
    envPathPresent: Boolean(process.env && process.env.PATH),
    bins,
    versions,
  };
}

// ── ② SSH ───────────────────────────────────────────────────────────────────

async function listSshKeys() {
  let names = [];
  try {
    names = await fs.readdir(SSH_DIR);
  } catch {
    return { pubs: [], ed25519: [] };
  }
  const pubs = names.filter((n) => n.endsWith(".pub"));
  const ed25519 = [];
  for (const pub of pubs) {
    try {
      const text = await fs.readFile(path.join(SSH_DIR, pub), "utf8");
      if (/^ssh-ed25519\s/.test(text.trim())) ed25519.push(pub.slice(0, -4));
    } catch {
      /* 读不到就当不是 ed25519 */
    }
  }
  // 只有私钥没有 .pub 也算（用户可能删过 pub）
  for (const n of names) {
    if (n.startsWith("id_ed25519") && !n.endsWith(".pub") && !ed25519.includes(n)) ed25519.push(n);
  }
  return { pubs, ed25519 };
}

async function readSshConfigText() {
  try {
    return await fs.readFile(SSH_CONFIG, "utf8");
  } catch {
    return "";
  }
}

async function ghAccount() {
  const gh = resolveBin("gh");
  if (!gh.path) return { installed: false, login: "" };
  const r = await run(gh.path, ["api", "user", "--jq", ".login"], { timeout: TIMEOUT.gh });
  return { installed: true, login: r.failed ? "" : r.stdout.trim() };
}

async function handleSshStatus() {
  const keys = await listSshKeys();
  const configText = await readSshConfigText();

  const keyList = [];
  for (const name of keys.ed25519) {
    let pubkey = "";
    try {
      pubkey = (await fs.readFile(path.join(SSH_DIR, name + ".pub"), "utf8")).trim();
    } catch {
      pubkey = "";
    }
    keyList.push({ name, pubkey });
  }

  // 每个平台各自一份：配置是权威，只有配置里没写 IdentityFile 才用探测结果
  const providers = {};
  for (const provider of ["github", "gitee"]) {
    const block = findHostBlock(configText, sshTarget(provider).alias);
    const configuredIdentity = block && block.fields.identityfile ? block.fields.identityfile : "";
    const fromConfig = keyNameFromIdentity(configuredIdentity);
    const detected = pickKeyName(keys.ed25519, provider);
    providers[provider] = {
      configured: Boolean(block),
      hostName: block ? block.fields.hostname || "" : "",
      port: block ? normalizePort(block.fields.port) : DEFAULT_PORT,
      identityFile: configuredIdentity,
      keyName: fromConfig || detected,
      keySource: fromConfig ? "config" : keys.ed25519.length ? "detected" : "none",
      line: block ? block.start + 1 : 0,
    };
  }

  const gh = await ghAccount();
  return {
    ok: true,
    sshDir: SSH_DIR,
    configPath: SSH_CONFIG,
    configExists: Boolean(configText),
    keys: keyList,
    providers,
    blocks: providers,
    gh,
  };
}

async function handleGenKey(payload = {}) {
  const keyName = isSafeKeyName(payload.keyName) ? payload.keyName : "id_ed25519";
  const keygen = resolveBin("ssh-keygen");
  if (!keygen.path) return fail("NO_SSH_KEYGEN", "找不到 ssh-keygen：请先安装 OpenSSH 客户端");
  const priv = path.join(SSH_DIR, keyName);
  const pub = priv + ".pub";
  if (fsSync.existsSync(priv)) {
    let existing = "";
    try {
      existing = (await fs.readFile(pub, "utf8")).trim();
    } catch {
      existing = "";
    }
    return { ok: true, created: false, keyName, pubkey: existing, message: "已存在同名密钥，复用（不覆盖）" };
  }
  await fs.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  const r = await run(keygen.path, ["-t", "ed25519", "-N", "", "-C", "pi-desktop", "-f", priv, "-q"], {
    timeout: TIMEOUT.probe,
  });
  if (r.failed && !fsSync.existsSync(pub)) {
    return fail("GEN_KEY_FAILED", "生成密钥失败：" + tail(combinedOutput(r)), { raw: tail(r.stderr, 400) });
  }
  try {
    await fs.chmod(priv, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  let pubkey = "";
  try {
    pubkey = (await fs.readFile(pub, "utf8")).trim();
  } catch {
    pubkey = "";
  }
  return { ok: true, created: true, keyName, pubkey, message: "已生成 ed25519 密钥（无密码）" };
}

async function handleWriteConfig(payload = {}) {
  const provider = normalizeProvider(payload.provider !== undefined ? payload.provider : prefs.provider);
  const before = await readSshConfigText();
  const existing = findHostBlock(before, sshTarget(provider).alias);

  // 端口：调用方给了就用它；否则沿用该平台现有端口；都没有才 443。
  // 绝不拿另一个平台的端口当默认值。
  const port =
    payload.port !== undefined && payload.port !== null && payload.port !== ""
      ? normalizePort(payload.port)
      : existing && existing.fields.port
        ? normalizePort(existing.fields.port)
        : DEFAULT_PORT;

  // IdentityFile：显式给密钥名 → 用它；否则原样保留现有配置；都没有才用探测的
  let identity;
  let identitySource;
  if (isSafeKeyName(payload.keyName)) {
    identity = identityFor(payload.keyName);
    identitySource = "chosen";
  } else if (existing && existing.fields.identityfile) {
    identity = existing.fields.identityfile;
    identitySource = "kept";
  } else {
    const keys = await listSshKeys();
    identity = identityFor(pickKeyName(keys.ed25519, provider));
    identitySource = "detected";
  }

  const result = upsertSshBlock(before, provider, port, identity);
  if (!result.changed) {
    return {
      ok: true,
      changed: false,
      message: "配置已是目标状态，未改动文件",
      alias: sshTarget(provider).alias,
      port,
      identity,
      identitySource,
    };
  }

  await fs.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  // 先备份：这是本插件唯一会碰到的既有用户配置
  let backup = "";
  if (before) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    backup = `${SSH_CONFIG}.bak-${stamp}`;
    try {
      await fs.copyFile(SSH_CONFIG, backup);
    } catch {
      backup = "";
    }
  }
  // 原子写：临时文件 → 替换（Windows 上 rename 到已存在路径会失败，先 unlink）
  const tmp = `${SSH_CONFIG}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, result.text, { mode: 0o600 });
  try {
    if (fsSync.existsSync(SSH_CONFIG)) await fs.unlink(SSH_CONFIG);
    await fs.rename(tmp, SSH_CONFIG);
  } catch {
    await fs.writeFile(SSH_CONFIG, result.text, { mode: 0o600 });
    try {
      await fs.unlink(tmp);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
  }
  try {
    await fs.chmod(SSH_CONFIG, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  return {
    ok: true,
    changed: true,
    created: result.created,
    backup,
    alias: sshTarget(provider).alias,
    port,
    identity,
    identitySource,
    message: result.created ? "已追加 Host 块" : "已就地改写 Host 块",
  };
}

/**
 * 「测试连接」该连谁 —— 纯判定，便于单测（不联网）。
 *
 * 有配置块时必须连**别名**（git@github.com）：OpenSSH 按你输入的主机名匹配 Host 段，
 * 连 ssh.github.com 匹配不到 `Host github.com`，IdentityFile/Port 全不生效，
 * 结果是 Permission denied 而配置明明是对的。这也正是 git 实际走的路。
 * 只有当面板上的端口与配置不一致（用户在试还没写进配置的打算）才直连。
 */
function sshTestTargets(provider, block, explicitPort) {
  const configPort = block && block.fields && block.fields.port ? normalizePort(block.fields.port) : 0;
  const port = explicitPort !== null && explicitPort !== undefined ? normalizePort(explicitPort) : configPort || DEFAULT_PORT;
  const useAlias = Boolean(block) && (explicitPort === null || explicitPort === undefined || normalizePort(explicitPort) === configPort);
  const target = sshTarget(provider);
  return {
    mode: useAlias ? "config" : "direct",
    port,
    configPort,
    host: useAlias ? target.alias : target.hostFor(port),
  };
}

async function handleSshTest(payload = {}) {
  const provider = normalizeProvider(payload.provider !== undefined ? payload.provider : prefs.provider);
  const ssh = resolveBin("ssh");
  if (!ssh.path) return fail("NO_SSH", "找不到 ssh 命令：请先安装 OpenSSH 客户端");

  const before = await readSshConfigText();
  const block = findHostBlock(before, sshTarget(provider).alias);
  const explicitPort =
    payload.port !== undefined && payload.port !== null && payload.port !== "" ? normalizePort(payload.port) : null;
  const plan = sshTestTargets(provider, block, explicitPort);
  const { mode, port, host } = plan;

  const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12"];
  if (mode === "direct") args.push("-p", String(port));

  // 显式选了钥匙才 -i；config 模式下否则完全交给 ~/.ssh/config
  const keyName = isSafeKeyName(payload.keyName) ? payload.keyName : mode === "direct" ? keyNameFromIdentity(block && block.fields.identityfile) : "";
  if (keyName) {
    const keyPath = path.join(SSH_DIR, keyName);
    if (fsSync.existsSync(keyPath)) args.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
  }
  args.push("git@" + host);

  const r = await run(ssh.path, args, { timeout: TIMEOUT.sshTest });
  const verdict = sshTestVerdict(r);
  return {
    ok: verdict.ok,
    provider,
    port,
    host,
    mode,
    configPort: plan.configPort,
    account: verdict.account,
    code: r.code,
    message: verdict.message,
    // 一定要把真实输出带出来：空 detail 会让人无从下手
    detail: tail(stripAnsi(combinedOutput(r)), 600),
  };
}

// ── Gitee 令牌（④ 列仓库需要） ──────────────────────────────────────────────

const GITEE_TOKEN_FILE = "gitee-token.json";

async function readGiteeToken() {
  const saved = await readJsonFile(GITEE_TOKEN_FILE, {});
  return typeof saved.token === "string" && saved.token ? saved : { token: "", login: "" };
}

async function giteeFetch(pathname, token, timeout = TIMEOUT.net) {
  if (typeof fetch !== "function") throw new Error("当前运行时没有 fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch("https://gitee.com/api/v5" + pathname, {
      headers: {
        Authorization: "token " + token,
        Accept: "application/json",
        "User-Agent": "pi-desktop-source-code-mgmt/" + VERSION,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function handleGiteeTokenStatus() {
  const saved = await readGiteeToken();
  return { ok: true, configured: Boolean(saved.token), login: saved.login || "" };
}

async function handleGiteeTokenSet(payload = {}) {
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) return fail("EMPTY_TOKEN", "令牌为空");
  if (!/^[A-Za-z0-9]{5,128}$/.test(token)) return fail("BAD_TOKEN", "令牌格式不像 Gitee 私人访问令牌");
  let login = "";
  try {
    const user = JSON.parse(await giteeFetch("/user", token));
    login = typeof user.login === "string" ? user.login : "";
  } catch (error) {
    return fail("TOKEN_REJECTED", "令牌校验失败（网络或令牌无效）：" + (error.message || String(error)));
  }
  const p = dataFile(GITEE_TOKEN_FILE);
  if (!p) return fail("NO_DATA_DIR", "插件数据目录不可用");
  await writePrivateFile(p, JSON.stringify({ token, login, savedAt: new Date().toISOString() }, null, 2));
  return { ok: true, configured: true, login, message: login ? `已保存，账号 ${login}` : "已保存" };
}

async function handleGiteeTokenClear() {
  const p = dataFile(GITEE_TOKEN_FILE);
  if (p) {
    try {
      await fs.unlink(p);
    } catch {
      /* 本来就没有 */
    }
  }
  return { ok: true, configured: false, login: "" };
}

// ── ④ 克隆仓库 ──────────────────────────────────────────────────────────────

async function candidateRoots() {
  const roots = [];
  const push = (p) => {
    const s = typeof p === "string" ? p.trim() : "";
    if (!s || !path.isAbsolute(s)) return;
    if (roots.some((r) => r.toLowerCase() === s.toLowerCase())) return;
    roots.push(s);
  };
  push(prefs.cloneParent);
  try {
    const ws = await pi.workspace.get();
    push(ws && ws.path);
  } catch {
    /* 没有打开项目就没有工作区根 */
  }
  push(HOME);
  return roots.slice(0, 6);
}

function localHitFor(name, roots) {
  for (const root of roots) {
    const dir = path.join(root, name);
    if (fsSync.existsSync(path.join(dir, ".git"))) return { exists: true, isRepo: true, dir, root };
    if (fsSync.existsSync(dir)) return { exists: true, isRepo: false, dir, root };
  }
  return { exists: false, isRepo: false, dir: "", root: "" };
}

async function handleReposList(payload = {}) {
  const provider = normalizeProvider(payload.provider !== undefined ? payload.provider : prefs.provider);
  const roots = await candidateRoots();
  let repos = [];
  let note = "";

  if (provider === "github") {
    const gh = resolveBin("gh");
    if (!gh.path) return fail("NO_GH", "找不到 gh 命令：GitHub 列仓库需要先安装 GitHub CLI 并 gh auth login");
    const r = await run(gh.path, ["repo", "list", "--limit", String(REPO_LIMIT), "--json", "name,sshUrl,isPrivate"], {
      timeout: TIMEOUT.gh,
    });
    if (r.failed) {
      return fail("GH_FAILED", "gh repo list 失败：" + tail(combinedOutput(r), 400), { detail: tail(r.stderr, 500) });
    }
    repos = parseGhRepoList(r.stdout);
  } else {
    const saved = await readGiteeToken();
    if (!saved.token) return fail("NO_TOKEN", "Gitee 模式需要先粘贴私人访问令牌");
    for (let page = 1; page <= GITEE_MAX_PAGES; page += 1) {
      try {
        const text = await giteeFetch(`/user/repos?per_page=${GITEE_PAGE_SIZE}&page=${page}&sort=updated`, saved.token);
        const rows = parseGiteeRepos(text);
        repos.push(...rows);
        if (rows.length < GITEE_PAGE_SIZE) break;
      } catch (error) {
        if (page === 1) return fail("GITEE_FAILED", "Gitee 仓库列表获取失败：" + (error.message || String(error)));
        note = `第 ${page} 页拉取失败，列表可能不完整`;
        break;
      }
    }
  }

  const enriched = repos.map((repo) => Object.assign({}, repo, { local: localHitFor(repo.name, roots) }));

  // 扫描到的本地仓库也算「本地已有」：仓库可能根本不在 ④ 选的父目录里
  try {
    const scanned = await getScannedRepos(false);
    const byName = new Map();
    for (const item of scanned.repos) {
      const key = item.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, item);
    }
    for (const repo of enriched) {
      if (repo.local && repo.local.exists) continue;
      const hit = byName.get(repo.name.toLowerCase());
      if (hit) repo.local = { exists: true, isRepo: true, dir: hit.path, root: hit.root, scanned: true };
    }
  } catch {
    /* 扫描失败不影响列表本身 */
  }

  return { ok: true, provider, count: enriched.length, note, roots, repos: enriched.slice(0, REPO_LIMIT) };
}

async function handlePickDir() {
  try {
    if (!pi.fs || typeof pi.fs.requestDirectory !== "function") {
      return fail("NO_PICKER", "宿主没有提供目录选择器，请手动输入绝对路径");
    }
    const picked = await pi.fs.requestDirectory();
    const dir = typeof picked === "string" ? picked : picked && picked.path ? picked.path : "";
    if (!dir) return { ok: false, cancelled: true, message: "已取消" };
    return { ok: true, path: dir };
  } catch (error) {
    return fail("PICK_FAILED", "选择目录失败：" + (error && error.message ? error.message : String(error)));
  }
}

/** 克隆：起后台任务立刻返回 jobId，由视图轮询（避开面板通道 30s 超时）。 */
async function handleCloneRun(payload = {}) {
  const url = String(payload.url || "").trim();
  if (!isAllowedRepoUrl(url)) return fail("BAD_URL", "仓库地址不合法（只接受 https:// 或 git@host:path，且不含 shell 元字符）");
  const name = repoNameFromUrl(url);
  if (!name) return fail("BAD_NAME", "无法从地址推导出仓库名");

  const parent = typeof payload.parentDir === "string" ? payload.parentDir.trim() : "";
  if (!parent) return fail("NO_PARENT", "请先选择目标父目录");
  if (!path.isAbsolute(parent)) return fail("BAD_PARENT", "目标父目录必须是绝对路径");
  let stat;
  try {
    stat = await fs.stat(parent);
  } catch {
    return fail("NO_PARENT_DIR", "目标父目录不存在：" + parent);
  }
  if (!stat.isDirectory()) return fail("NOT_DIR", "目标路径不是目录：" + parent);

  const target = path.join(parent, name);
  if (fsSync.existsSync(target)) return fail("TARGET_EXISTS", `目标已存在，拒绝覆盖：${target}`, { target });

  const git = resolveBin("git");
  if (!git.path) return fail("NO_GIT", "找不到 git 命令");

  cloneSeq += 1;
  const jobId = `clone-${Date.now()}-${cloneSeq}`;
  const job = {
    id: jobId,
    url,
    name,
    parent,
    target,
    state: "running",
    startedAt: Date.now(),
    finishedAt: 0,
    log: "",
    ok: false,
    message: "",
  };
  cloneJobs.set(jobId, job);
  for (const [id, old] of cloneJobs) {
    if (Date.now() - old.startedAt > 3600 * 1000) cloneJobs.delete(id);
  }

  const child = execFile(
    git.path,
    ["clone", "--", url, target],
    { windowsHide: true, env: childEnv({ useGitSsh: true }), timeout: 30 * 60 * 1000 },
    (error, stdout, stderr) => {
      job.state = error ? "failed" : "done";
      job.finishedAt = Date.now();
      job.ok = !error;
      job.message = error ? tail(stderr || stdout, 400) || String(error.message || "失败") : "克隆完成";
      cloneJobs.set(jobId, job);
    },
  );
  const accrue = (chunk) => {
    job.log = (job.log + String(chunk)).slice(-CLONE_LOG_LIMIT);
  };
  if (child.stdout) child.stdout.on("data", accrue);
  if (child.stderr) child.stderr.on("data", accrue);
  child.on("error", (error) => {
    job.state = "failed";
    job.finishedAt = Date.now();
    job.ok = false;
    job.message = String(error && error.message ? error.message : error);
  });

  return { ok: true, jobId, name, target, message: "已开始克隆" };
}

function handleCloneStatus(payload = {}) {
  const job = cloneJobs.get(String(payload.jobId || ""));
  if (!job) return fail("NO_JOB", "找不到该克隆任务");
  return {
    ok: true,
    jobId: job.id,
    state: job.state,
    running: job.state === "running",
    done: job.state !== "running",
    succeeded: job.ok,
    name: job.name,
    target: job.target,
    message: job.message,
    log: tail(job.log, 1500),
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  };
}

// ── ③ 代码管理（只补 Git Lens 没有的：大文件治理 + revert / cherry-pick） ──

/** GitHub 单文件上限 100MB；超了 push 会被直接拒绝。 */
const BIG_FILE_THRESHOLD = 100 * 1024 * 1024;
const GIT_SAFE_ARGS = ["-c", "core.quotepath=false"];
const CHANGE_LIST_LIMIT = 500;

async function gitRun(dir, args, options = {}) {
  const bin = resolveBin("git");
  if (!bin.path) return { code: -1, failed: true, stdout: "", stderr: "", errorMessage: "找不到 git 命令" };
  return run(bin.path, [...GIT_SAFE_ARGS, ...args], {
    timeout: options.timeout || TIMEOUT.git,
    cwd: dir,
    useGitSsh: options.useGitSsh,
  });
}

/** `git status --porcelain -z` → [{x, y, path, origPath?}]（-z 不做引号转义，中文路径安全） */
function parsePorcelainZ(stdout) {
  const parts = String(stdout || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    if (x === "R" || x === "C") {
      out.push({ x, y, path: p, origPath: parts[i + 1] || "" });
      i += 1;
    } else {
      out.push({ x, y, path: p });
    }
  }
  return out;
}

/** 按 XY 分类。X=索引、Y=工作区；`??` 是未跟踪。 */
function classifyChanges(entries) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const e of entries || []) {
    if (e.x === "!" && e.y === "!") continue; // 被忽略
    if (e.x === "?" || e.y === "?") {
      untracked.push(e.path);
      continue;
    }
    if (e.x !== " ") staged.push(e.path);
    if (e.y !== " ") unstaged.push(e.path);
  }
  return { staged, unstaged, untracked };
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + " GB";
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + " MB";
  if (b >= 1024) return Math.round(b / 1024) + " KB";
  return b + " B";
}

/**
 * 大文件 → .gitignore 的模式：一级子目录里的文件忽略整个一级目录（整块不上传），
 * 根目录下的独立文件只忽略那一个文件。
 */
function ignorePatternFor(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : parts[0] + "/**";
}

/** 追加 .gitignore：去重、保留文件自身换行符、末尾补空行 */
function appendGitignore(existing, patterns) {
  const source = String(existing || "");
  const eol = detectEol(source);
  const lines = source.length ? source.split(/\r?\n/) : [];
  const have = new Set(lines.map((l) => l.trim()));
  const added = [];
  for (const raw of patterns || []) {
    const p = String(raw || "").trim();
    if (!p || have.has(p)) continue;
    have.add(p);
    added.push(p);
  }
  if (!added.length) return { text: source, added: [], changed: false, eol };
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  out.push(...added, "");
  const text = out.join(eol);
  return { text, added, changed: text !== source, eol };
}

/** 解析 git log（%x1f 分隔）*/
function parseGitLog(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.split("\x1f"))
    .filter((f) => f.length >= 4 && f[0])
    .map((f) => ({ hash: f[0], date: f[1], author: f[2], subject: f.slice(3).join("\x1f") }));
}

/** 目录 → 仓库根；不是仓库时给出 isRepo:false 而不是报错。 */
async function locateRepo(input) {
  const dir = typeof input === "string" ? input.trim() : "";
  if (!dir) return fail("NO_DIR", "请先选择仓库目录");
  if (!path.isAbsolute(dir)) return fail("BAD_DIR", "仓库目录必须是绝对路径");
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    return fail("NO_DIR", "目录不存在：" + dir);
  }
  if (!stat.isDirectory()) return fail("NOT_DIR", "不是目录：" + dir);
  const top = await gitRun(dir, ["rev-parse", "--show-toplevel"]);
  const root = top.failed ? "" : top.stdout.trim();
  return { ok: true, dir, root, isRepo: Boolean(root) };
}

async function handleRepoStatus(payload = {}) {
  const found = await locateRepo(payload.dir);
  if (!found.ok) return found;
  if (!found.isRepo) {
    return { ok: true, isRepo: false, dir: found.dir, message: "这个目录还不是 git 仓库" };
  }
  const dir = found.root;
  // 记住最近操作的仓库：agent 工具不传 dir 时用它
  if (prefs.lastRepo !== dir) {
    prefs.lastRepo = dir;
    persistPrefs().catch(() => {});
  }
  const threshold = Number(payload.thresholdBytes) > 0 ? Number(payload.thresholdBytes) : BIG_FILE_THRESHOLD;

  // --untracked-files=all：默认会把未跟踪的整个目录折叠成一条（assets/），
  // 那样新目录里的大文件就检测不到 —— 而这正是最常见的场景。
  const status = await gitRun(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (status.failed) return fail("GIT_STATUS_FAILED", "git status 失败：" + tail(combinedOutput(status), 300));

  const entries = parsePorcelainZ(status.stdout);
  const changes = classifyChanges(entries);

  const branchRes = await gitRun(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.failed ? "" : branchRes.stdout.trim();
  const remoteRes = await gitRun(dir, ["remote", "-v"]);
  const remote = remoteRes.failed
    ? ""
    : (remoteRes.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)[0] || "");

  let upstream = "";
  let ahead = 0;
  let behind = 0;
  const upRes = await gitRun(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upRes.failed && upRes.stdout.trim()) {
    upstream = upRes.stdout.trim();
    const countRes = await gitRun(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (!countRes.failed) {
      const m = /^(\d+)\s+(\d+)$/.exec(countRes.stdout.trim());
      if (m) {
        behind = Number(m[1]);
        ahead = Number(m[2]);
      }
    }
  }

  // 改名条目用新路径判断大小；已删除的文件不参与大文件判定
  const allPaths = [...new Set([...changes.staged, ...changes.unstaged, ...changes.untracked])].slice(0, CHANGE_LIST_LIMIT);
  const deleted = new Set(entries.filter((e) => e.x === "D" || e.y === "D").map((e) => e.path));
  const bigFiles = [];
  for (const rel of allPaths) {
    if (deleted.has(rel)) continue;
    try {
      const st = await fs.stat(path.join(dir, rel));
      if (st.isFile() && st.size > threshold) bigFiles.push({ path: rel, bytes: st.size, size: formatBytes(st.size) });
    } catch {
      /* 不存在的就当它不是大文件 */
    }
  }

  const files = entries.slice(0, CHANGE_LIST_LIMIT).map((e) => ({
    path: e.path,
    x: e.x,
    y: e.y,
    kind: e.x === "?" ? "untracked" : e.x !== " " ? "staged" : "modified",
  }));

  return {
    ok: true,
    isRepo: true,
    dir: found.dir,
    root: dir,
    branch,
    remote,
    upstream,
    ahead,
    behind,
    changes: {
      staged: changes.staged.length,
      unstaged: changes.unstaged.length,
      untracked: changes.untracked.length,
      total: entries.length,
    },
    files,
    bigFiles,
    thresholdBytes: threshold,
    truncated: entries.length > CHANGE_LIST_LIMIT,
  };
}

async function handleRepoIgnore(payload = {}) {
  const found = await locateRepo(payload.dir);
  if (!found.ok) return found;
  if (!found.isRepo) return fail("NOT_REPO", "这个目录还不是 git 仓库");

  const listing = await handleRepoStatus({ dir: payload.dir, thresholdBytes: payload.thresholdBytes });
  if (!listing.ok) return listing;
  const target = Array.isArray(payload.paths) && payload.paths.length
    ? payload.paths.filter((p) => typeof p === "string")
    : listing.bigFiles.map((f) => f.path);
  if (!target.length) return { ok: true, changed: false, added: [], message: "没有超过阈值的文件需要忽略" };

  const gitignorePath = path.join(found.root, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    existing = "";
  }
  const patterns = target.map(ignorePatternFor).filter(Boolean);
  const result = appendGitignore(existing, patterns);
  if (!result.changed) {
    return { ok: true, changed: false, added: [], message: "这些文件已经在 .gitignore 里了" };
  }
  await fs.writeFile(gitignorePath, result.text, { mode: 0o600 });
  return {
    ok: true,
    changed: true,
    added: result.added,
    gitignore: gitignorePath,
    message: `已写入 .gitignore：${result.added.join("、")}`,
  };
}

async function handleRepoLog(payload = {}) {
  const found = await locateRepo(payload.dir);
  if (!found.ok) return found;
  if (!found.isRepo) return fail("NOT_REPO", "这个目录还不是 git 仓库");
  const count = Math.min(Math.max(Number(payload.count) || 20, 1), 100);
  const res = await gitRun(found.root, [
    "log",
    "--date=short",
    "--pretty=format:%h%x1f%ad%x1f%an%x1f%s",
    "-n",
    String(count),
  ]);
  if (res.failed) {
    // 全新仓库没有任何提交：这不是错误
    const msg = combinedOutput(res);
    if (/does not have any commits yet|unknown revision|bad default revision/i.test(msg)) {
      return { ok: true, isRepo: true, commits: [], message: "还没有任何提交" };
    }
    return fail("GIT_LOG_FAILED", "git log 失败：" + tail(msg, 300));
  }
  return { ok: true, isRepo: true, commits: parseGitLog(res.stdout) };
}

/** revert / cherry-pick：会改写工作树，必须带 hash 确认；不替用户编造身份。 */
async function handleRepoRewrite(payload = {}, kind) {
  const found = await locateRepo(payload.dir);
  if (!found.ok) return found;
  if (!found.isRepo) return fail("NOT_REPO", "这个目录还不是 git 仓库");
  const hash = typeof payload.hash === "string" ? payload.hash.trim() : "";
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) return fail("BAD_HASH", "提交号不合法");

  const args =
    kind === "cherry-pick"
      ? ["cherry-pick", hash]
      : ["revert", "--no-edit", hash];
  const res = await gitRun(found.root, args, { timeout: 60000 });
  const output = combinedOutput(res);
  if (res.failed) {
    if (/please tell me who you are|empty ident name|unable to auto-detect email/i.test(output)) {
      return fail("NO_IDENTITY", "git 还没有配置提交身份，先在终端跑：git config --global user.name / user.email", {
        detail: tail(output, 400),
      });
    }
    if (/conflict/i.test(output)) {
      return fail("CONFLICT", "有冲突，需要手动解决（仓库保持原状，未自动继续）", { detail: tail(output, 600) });
    }
    return fail("REWRITE_FAILED", `${kind} 失败：` + tail(output, 400), { detail: tail(output, 600) });
  }
  return {
    ok: true,
    kind,
    hash,
    message: kind === "cherry-pick" ? `已 cherry-pick ${hash}` : `已 revert ${hash}`,
    detail: tail(output, 400),
  };
}

function handleRepoRevert(payload = {}) {
  return handleRepoRewrite(payload, "revert");
}

function handleRepoCherryPick(payload = {}) {
  return handleRepoRewrite(payload, "cherry-pick");
}

// ── ① 工具安装与更新（不降级：真跑安装器、真起终端） ──────────────────────

/** ⚠️ 唯一 1:1 不了的地方：PI-Desktop 没有「让宿主重启自己」的通道（DSH 有）。 */
const RESTART_HINT = "装完若面板仍显示缺失，请手动重启 PI-Desktop（插件进程没有重启宿主的通道）";

const GH_MIRRORS = [
  { id: "gh-proxy.com", prefix: "https://gh-proxy.com/", label: "gh-proxy.com（快，推荐）" },
  { id: "ghfast.top", prefix: "https://ghfast.top/", label: "ghfast.top（可用，较慢）" },
  { id: "ghproxy.net", prefix: "https://ghproxy.net/", label: "ghproxy.net（可用，较慢）" },
  { id: "official", prefix: "", label: "官网（可能很慢）" },
];

function ghMirrorById(id) {
  return GH_MIRRORS.find((m) => m.id === id) || GH_MIRRORS[0];
}

/**
 * gh 官方 msi / tar.gz 的下载地址；镜像就是「前缀 + 官方 URL」。
 * 纯函数，便于断言（拼错了会下载到 404 页面再拿去装，报错极难懂）。
 */
function ghDownloadUrl(version, platform, arch, mirrorId) {
  const osName = platform === "win32" ? "windows" : platform === "darwin" ? "macOS" : "linux";
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
  const file = platform === "win32" ? `gh_${version}_windows_${archName}.msi` : `gh_${version}_${osName}_${archName}.tar.gz`;
  const official = `https://github.com/cli/cli/releases/download/v${version}/${file}`;
  return ghMirrorById(mirrorId).prefix + official;
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * 每个工具的安装计划（纯函数）：命令、是否需要提权、以及给人看的说明。
 * 安装执行只认这张表里的 tool id，不接受任何外部拼进来的命令。
 */
function installPlan(tool, options = {}) {
  const platform = options.platform || process.platform;
  const hasWinget = Boolean(options.hasWinget);
  const mirror = ghMirrorById(options.mirror);
  const version = options.ghVersion || "";

  if (tool === "gh") {
    if (platform === "win32") {
      const url = version ? ghDownloadUrl(version, platform, process.arch, mirror.id) : "";
      return {
        tool,
        platform,
        method: version && mirror.prefix ? "msi-mirror" : "winget",
        command:
          version && mirror.prefix
            ? `curl.exe -L -o %TEMP%\\gh.msi "${url}" && msiexec /i %TEMP%\\gh.msi /qn /norestart`
            : "winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements",
        needsElevation: true,
        mirror: mirror.id,
        notes: version && mirror.prefix ? "走镜像下载官方 msi，再用 msiexec 静默安装" : "需要 winget",
        available: version && mirror.prefix ? true : hasWinget,
      };
    }
    if (platform === "darwin") {
      return {
        tool,
        platform,
        method: "brew",
        command: "brew install gh",
        needsElevation: false,
        mirror: "official",
        notes: "Homebrew 安装（无需 sudo）",
        available: Boolean(options.hasBrew),
      };
    }
    return {
      tool,
      platform,
      method: "tarball",
      command: "从官方 Release 解压到 ~/.local/bin（免 sudo）",
      needsElevation: false,
      mirror: mirror.id,
      notes: "免 sudo 用户级安装",
      available: true,
    };
  }

  if (tool === "git") {
    if (platform === "win32") {
      return {
        tool,
        platform,
        method: "winget",
        command: "winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements",
        needsElevation: true,
        mirror: "official",
        notes: "winget 安装 Git for Windows",
        available: hasWinget,
      };
    }
    if (platform === "darwin") {
      return {
        tool,
        platform,
        method: options.hasBrew ? "brew" : "xcode-clt",
        command: options.hasBrew ? "brew install git" : "xcode-select --install",
        needsElevation: false,
        mirror: "official",
        notes: options.hasBrew ? "Homebrew 安装" : "走系统命令行工具（含 git/ssh）",
        available: true,
      };
    }
    return {
      tool,
      platform,
      method: "package-manager",
      command: "apt-get install -y git / dnf install -y git / pacman -S --noconfirm git",
      needsElevation: true,
      mirror: "official",
      notes: "按发行版选包管理器；需要时先探测 sudo 是否免密",
      available: true,
    };
  }

  if (tool === "ssh") {
    if (platform === "win32") {
      return {
        tool,
        platform,
        method: "windows-capability",
        command: "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0",
        needsElevation: true,
        mirror: "official",
        notes: "Windows 内置可选功能（需要管理员）",
        available: true,
      };
    }
    if (platform === "darwin") {
      return { tool, platform, method: "builtin", command: "系统自带", needsElevation: false, mirror: "official", notes: "macOS 自带 ssh", available: true };
    }
    return {
      tool,
      platform,
      method: "package-manager",
      command: "apt-get install -y openssh-client / dnf install -y openssh-clients",
      needsElevation: true,
      mirror: "official",
      notes: "需要时先探测 sudo 是否免密",
      available: true,
    };
  }

  return null;
}

// ── 安装任务（job + 轮询，避开面板通道 30s 超时） ───────────────────────────

const toolJobs = new Map();
let toolJobSeq = 0;

function startToolJob(label, command, args, options = {}) {
  toolJobSeq += 1;
  const jobId = `tool-${Date.now()}-${toolJobSeq}`;
  const job = {
    id: jobId,
    label,
    state: "running",
    startedAt: Date.now(),
    finishedAt: 0,
    log: "",
    ok: false,
    message: "",
  };
  toolJobs.set(jobId, job);
  for (const [id, old] of toolJobs) {
    if (Date.now() - old.startedAt > 3600 * 1000) toolJobs.delete(id);
  }
  const child = execFile(
    command,
    args,
    { windowsHide: true, env: childEnv(), timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => {
      job.state = error ? "failed" : "done";
      job.finishedAt = Date.now();
      job.ok = !error;
      job.message = error ? tail(stderr || stdout, 500) || String(error.message || "失败") : "完成";
      toolJobs.set(jobId, job);
      binCache.clear(); // 装完立刻重新解析，别拿缓存骗自己
    },
  );
  const accrue = (chunk) => {
    job.log = (job.log + String(chunk)).slice(-CLONE_LOG_LIMIT);
  };
  if (child.stdout) child.stdout.on("data", accrue);
  if (child.stderr) child.stderr.on("data", accrue);
  child.on("error", (error) => {
    job.state = "failed";
    job.finishedAt = Date.now();
    job.ok = false;
    job.message = String(error && error.message ? error.message : error);
  });
  return job;
}

/** gh 最新稳定版（前缀 v 去掉）；网络失败返回空串，不假装成功。 */
async function latestGhVersion() {
  try {
    const res = await fetch("https://api.github.com/repos/cli/cli/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-desktop-source-code-mgmt/" + VERSION },
      signal: AbortSignal.timeout(TIMEOUT.net),
    });
    if (!res.ok) return "";
    const body = await res.json();
    return String(body.tag_name || "").replace(/^v/, "");
  } catch {
    return "";
  }
}

/** git 最新稳定版：git/git 没有 release，用 tags 并过滤预发布/RC。 */
async function latestGitVersion() {
  try {
    const res = await fetch("https://api.github.com/repos/git/git/tags?per_page=40", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-desktop-source-code-mgmt/" + VERSION },
      signal: AbortSignal.timeout(TIMEOUT.net),
    });
    if (!res.ok) return "";
    const body = await res.json();
    const stable = (Array.isArray(body) ? body : [])
      .map((t) => String(t.name || ""))
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .map((name) => name.slice(1))
      .sort((a, b) => compareVersions(b, a));
    return stable[0] || "";
  } catch {
    return "";
  }
}

/** 真跑一次来探测某个命令是否可用（拿不到 stat 的别名只能用这招）。 */
async function probeBinary(name, args) {
  const r = await run(name, args || ["--version"], { timeout: 8000 });
  const out = combinedOutput(r);
  if (r.failed && /ENOENT|not recognized|不是内部或外部命令/i.test(out + (r.errorMessage || ""))) return false;
  return !r.failed || Boolean(out);
}

async function handleToolsPlan(payload = {}) {
  const env = await handleEnv({ refresh: Boolean(payload.refresh) });
  const hasWinget = IS_WIN ? await probeBinary("winget.exe", ["--version"]) : false;
  const hasBrew = !IS_WIN ? await probeBinary("brew", ["--version"]) : false;
  const ghVersion = await latestGhVersion();
  const plans = {};
  for (const tool of BIN_NAMES) {
    if (tool === "ssh-keygen") continue;
    plans[tool] = Object.assign(
      { installed: Boolean(env.bins[tool] && env.bins[tool].path), version: env.versions[tool] || "" },
      installPlan(tool, { platform: process.platform, hasWinget, hasBrew, ghVersion, mirror: payload.mirror }),
    );
  }
  return {
    ok: true,
    env,
    plans,
    mirrors: GH_MIRRORS.map((m) => ({ id: m.id, label: m.label })),
    latest: { gh: ghVersion },
    restartHint: RESTART_HINT,
  };
}

async function handleToolInstall(payload = {}) {
  const tool = String(payload.tool || "");
  if (!BIN_NAMES.includes(tool)) return fail("BAD_TOOL", "未知工具");
  const hasWinget = IS_WIN ? await probeBinary("winget.exe", ["--version"]) : false;
  const ghVersion = tool === "gh" ? (payload.ghVersion ? String(payload.ghVersion) : await latestGhVersion()) : "";
  const plan = installPlan(tool, {
    platform: process.platform,
    hasWinget,
    hasBrew: !IS_WIN && Boolean(resolveBin("brew").path),
    ghVersion,
    mirror: payload.mirror,
  });
  if (!plan || !plan.available) {
    return fail("NOT_AVAILABLE", `当前平台没有可用的 ${tool} 安装方式（${plan ? plan.notes : "未支持"}）`);
  }

  // 只走这张表：命令与参数全部来自 installPlan，绝不拼接用户输入
  if (plan.method === "msi-mirror") {
    const url = ghDownloadUrl(ghVersion, process.platform, process.arch, plan.mirror);
    const msi = path.join(HOME, "AppData", "Local", "Temp", "pi-desktop-gh.msi");
    const curl = resolveBin("curl").path || "C:\\Windows\\System32\\curl.exe";
    const dl = startToolJob(`下载 gh ${ghVersion}（${plan.mirror}）`, curl, ["-L", "-o", msi, url]);
    return { ok: true, jobId: dl.id, plan, message: "已开始下载，下载完会继续安装（见任务日志）", next: { kind: "msi", path: msi } };
  }
  if (plan.method === "winget") {
    if (!hasWinget) return fail("NO_WINGET", "找不到 winget（Windows 10/11 自带），请手动安装或改用镜像下载");
    const job = startToolJob(`winget 安装 ${tool}`, "winget.exe", [
      "install",
      "--id",
      tool === "git" ? "Git.Git" : "GitHub.cli",
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
    return { ok: true, jobId: job.id, plan, message: "已开始安装（可能弹 UAC 提权窗口，请允许）" };
  }
  if (plan.method === "windows-capability") {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // 提权：Start-Process -Verb RunAs（会弹 UAC）
    const script = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'`;
    const job = startToolJob(`安装 OpenSSH 客户端（需要 UAC 提权）`, ps, ["-NoProfile", "-Command", script]);
    return { ok: true, jobId: job.id, plan, message: "已开始安装（会弹 UAC，请允许）" };
  }
  return fail("UNSUPPORTED_METHOD", `不支持的安装方式：${plan.method}（当前只实现了 Windows 的 winget / 镜像 msi / 内置功能）`);
}

/** 镜像下载完成后，用 msiexec 静默安装（单独一步，因为要等下载任务结束）。 */
async function handleToolInstallMsi(payload = {}) {
  const file = typeof payload.path === "string" ? payload.path : "";
  if (!file || !path.isAbsolute(file) || !/\.msi$/i.test(file)) return fail("BAD_MSI", "不是合法的 msi 路径");
  if (!fsSync.existsSync(file)) return fail("NO_MSI", "安装包不存在（下载可能失败）：" + file);
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // -EncodedCommand 免掉引号转义地狱；RunAs 会弹 UAC
  const inner = `Start-Process -FilePath msiexec.exe -ArgumentList '/i','${file.replace(/'/g, "''")}','/qn','/norestart' -Verb RunAs -Wait`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const job = startToolJob("msiexec 静默安装 gh（需要 UAC 提权）", ps, ["-NoProfile", "-EncodedCommand", encoded]);
  return { ok: true, jobId: job.id, message: "已开始安装（会弹 UAC，请允许）" };
}

function handleToolJob(payload = {}) {
  const job = toolJobs.get(String(payload.jobId || ""));
  if (!job) return fail("NO_JOB", "找不到该任务");
  return {
    ok: true,
    jobId: job.id,
    label: job.label,
    state: job.state,
    running: job.state === "running",
    done: job.state !== "running",
    succeeded: job.ok,
    message: job.message,
    log: tail(job.log, 2000),
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  };
}

async function handleCheckUpdate(payload = {}) {
  const tool = String(payload.tool || "");
  if (!["gh", "git"].includes(tool)) return fail("BAD_TOOL", "只支持检查 gh / git 的更新");
  const env = await handleEnv({ refresh: true });
  const current = env.versions[tool] || "";
  const latest = tool === "gh" ? await latestGhVersion() : await latestGitVersion();
  if (!latest) return fail("CHECK_FAILED", "读不到官方最新版本（网络不通或接口变了）");
  return {
    ok: true,
    tool,
    current,
    latest,
    hasUpdate: compareVersions(latest, current) > 0,
    // Linux 的 git 跟发行版走，拿官方版本对比会永远误报 —— 不显示更新
    note: tool === "git" && process.platform !== "win32" ? "Git 随系统/发行版更新，这里不做版本对比" : "",
  };
}

// ── ⑤ npm 发布向导（真跑 npm，不降级） ──────────────────────────────────────

const NPM_OFFICIAL_REGISTRY = "https://registry.npmjs.org";

/** npm 在 Windows 上是 .cmd，Node 不能直接 spawn；优先 node + npm-cli.js（无 shell）。 */
function npmRunner() {
  const node = resolveBin("node");
  const npmCmd = resolveBin("npm");
  if (npmCmd.path) {
    const dir = path.dirname(npmCmd.path);
    const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    const nodeExe = path.join(dir, "node.exe");
    if (fsSync.existsSync(cli) && fsSync.existsSync(nodeExe)) {
      return { kind: "node", node: nodeExe, cli };
    }
    return { kind: "cmd", npm: npmCmd.path };
  }
  if (node.path) {
    const cli = path.join(path.dirname(node.path), "node_modules", "npm", "bin", "npm-cli.js");
    if (fsSync.existsSync(cli)) return { kind: "node", node: node.path, cli };
  }
  return { kind: "missing" };
}

function runNpm(args, options = {}) {
  const runner = npmRunner();
  if (runner.kind === "node") {
    return run(runner.node, [runner.cli, ...args], { timeout: options.timeout || 120000, cwd: options.cwd });
  }
  if (runner.kind === "cmd") {
    return run("cmd.exe", ["/c", runner.npm, ...args], { timeout: options.timeout || 120000, cwd: options.cwd });
  }
  return Promise.resolve({ code: -1, failed: true, stdout: "", stderr: "", errorMessage: "找不到 npm" });
}

/** 把 npm config list 里的凭据抹掉（token / password / auth）。 */
function maskNpmConfig(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => (/authToken|_auth|password|token=/i.test(line) ? line.replace(/=\s*.+$/, "= ******") : line))
    .join("\n");
}

function parseNpmPack(stdout) {
  try {
    const rows = JSON.parse(String(stdout || "[]"));
    const first = Array.isArray(rows) ? rows[0] : rows;
    if (!first || typeof first !== "object") return null;
    return {
      name: first.name || "",
      version: first.version || "",
      filename: first.filename || "",
      files: Array.isArray(first.files) ? first.files.length : 0,
      size: Number(first.size) || 0,
      unpackedSize: Number(first.unpackedSize) || 0,
    };
  } catch {
    return null;
  }
}

async function handleNpmStatus(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  const runner = npmRunner();
  if (runner.kind === "missing") return fail("NO_NPM", "找不到 npm：请先安装 Node.js");
  if (dir && !path.isAbsolute(dir)) return fail("BAD_DIR", "目录必须是绝对路径");

  const registryRes = await runNpm(["config", "get", "registry"], { timeout: 30000 });
  const registry = registryRes.failed ? "" : registryRes.stdout.trim();
  const whoRes = await runNpm(["whoami", `--registry=${NPM_OFFICIAL_REGISTRY}`], { timeout: 60000 });
  const login = whoRes.failed ? "" : whoRes.stdout.trim();
  const listRes = await runNpm(["config", "list"], { timeout: 30000 });

  let hasPackageJson = false;
  let pkg = null;
  if (dir) {
    try {
      const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
      hasPackageJson = true;
      pkg = JSON.parse(raw);
    } catch {
      hasPackageJson = false;
    }
  }

  return {
    ok: true,
    runner: runner.kind,
    registry,
    mirrorConfigured: Boolean(registry) && !registry.startsWith(NPM_OFFICIAL_REGISTRY),
    publishRegistry: NPM_OFFICIAL_REGISTRY,
    login,
    loggedIn: Boolean(login),
    hasPackageJson,
    packageName: pkg ? pkg.name || "" : "",
    packageVersion: pkg ? pkg.version || "" : "",
    configMasked: maskNpmConfig(listRes.failed ? "" : listRes.stdout).slice(0, 4000),
  };
}

async function handleNpmPack(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  if (!dir || !path.isAbsolute(dir)) return fail("BAD_DIR", "请先选择包目录（绝对路径）");
  const res = await runNpm(["pack", "--dry-run", "--json"], { cwd: dir, timeout: 120000 });
  const info = parseNpmPack(res.stdout);
  if (!info) {
    return fail("PACK_FAILED", "npm pack --dry-run 失败：" + tail(combinedOutput(res), 400));
  }
  return { ok: true, dir, ...info };
}

async function handleNpmPublish(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  if (!dir || !path.isAbsolute(dir)) return fail("BAD_DIR", "请先选择包目录（绝对路径）");
  if (payload.confirm !== true) return fail("NEED_CONFIRM", "发布前必须确认（confirm: true）");

  const status = await handleNpmStatus({ dir });
  if (!status.ok) return status;
  if (!status.loggedIn) return fail("NOT_LOGGED_IN", "npm 还没登录：先点「打开终端登录」，或在终端跑 npm login");

  const runner = npmRunner();
  toolJobSeq += 1;
  const jobId = `npm-${Date.now()}-${toolJobSeq}`;
  const job = {
    id: jobId,
    label: `发布 ${status.packageName || "包"}@${status.packageVersion || "?"}`,
    state: "running",
    startedAt: Date.now(),
    finishedAt: 0,
    log: "",
    ok: false,
    message: "",
  };
  toolJobs.set(jobId, job);
  const args = ["publish", `--registry=${NPM_OFFICIAL_REGISTRY}`];
  const child =
    runner.kind === "node"
      ? execFile(runner.node, [runner.cli, ...args], { cwd: dir, windowsHide: true, env: childEnv(), timeout: 10 * 60 * 1000 }, done)
      : execFile("cmd.exe", ["/c", runner.npm, ...args], { cwd: dir, windowsHide: true, env: childEnv(), timeout: 10 * 60 * 1000 }, done);
  function done(error, stdout, stderr) {
    job.state = error ? "failed" : "done";
    job.finishedAt = Date.now();
    job.ok = !error;
    job.message = error ? tail(stderr || stdout, 500) || String(error.message || "失败") : "已发布";
    toolJobs.set(jobId, job);
  }
  const accrue = (chunk) => {
    job.log = (job.log + String(chunk)).slice(-CLONE_LOG_LIMIT);
  };
  if (child.stdout) child.stdout.on("data", accrue);
  if (child.stderr) child.stderr.on("data", accrue);
  return { ok: true, jobId, message: "已开始发布" };
}

/**
 * npm login 是交互式的（浏览器/一次性密码），必须在真实终端里跑。
 * 这里跟 DSH 原版一样起一个可见控制台：cmd /c start "" cmd /k npm login…，
 * 用它自己的 TTY 完成认证，插件不接触密码。
 */
async function handleNpmLogin(payload = {}) {
  if (!IS_WIN) return fail("PLATFORM_UNSUPPORTED", "当前只实现了 Windows 的终端启动");
  const dir = typeof payload.dir === "string" && path.isAbsolute(payload.dir) ? payload.dir : HOME;
  const inner = `npm login --registry=${NPM_OFFICIAL_REGISTRY}`;
  const child = execFile(
    "cmd.exe",
    ["/c", "start", "", "/d", dir, "cmd", "/k", inner],
    { windowsHide: false, env: childEnv(), timeout: 20000 },
    () => {},
  );
  child.on("error", () => {});
  return {
    ok: true,
    command: `cd /d "${dir}" && ${inner}`,
    message: "已在新终端窗口里运行 npm login（在那里完成登录即可，完成后点「重新检查」）",
  };
}

// ── ③ 代码管理：同步、暂存提交、分支、建库（对齐原版 40 条路由） ──────────

/** 仓库内相对路径：拒绝绝对路径与 ..（git 参数里绝不能出现能逃出仓库的路径） */
function isSafeRepoPath(p) {
  const s = String(p || "").trim();
  if (!s || s.length > 1024) return false;
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith("/") || s.startsWith("\\")) return false;
  return !s.split(/[\\/]/).includes("..");
}

function isSafeBranchName(name) {
  const s = String(name || "").trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(s)) return false;
  return !s.includes("..") && !s.startsWith("-") && !s.endsWith("/") && !s.endsWith(".lock");
}

function isSafeRepoName(name) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(String(name || "").trim());
}

/** 统一的「必须是仓库」前置。 */
async function requireRepo(input) {
  const found = await locateRepo(input);
  if (!found.ok) return { error: found };
  if (!found.isRepo) return { error: fail("NOT_REPO", "这个目录还不是 git 仓库（可以点「仅 git init」）") };
  return { root: found.root, dir: found.dir };
}

/** 没配 git 身份时的统一提示（不替用户伪造身份）。 */
function identityFail(output) {
  if (/please tell me who you are|empty ident name|unable to auto-detect email/i.test(output)) {
    return fail("NO_IDENTITY", "git 还没配置提交身份：先在终端跑 git config --global user.name / user.email", {
      detail: tail(output, 400),
    });
  }
  return null;
}

async function handleRepoDiff(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const rel = String(payload.path || "");
  if (!isSafeRepoPath(rel)) return fail("BAD_PATH", "文件路径不合法");

  const args = payload.staged ? ["diff", "--cached", "--", rel] : ["diff", "--", rel];
  let res = await gitRun(repo.root, args);
  if (res.failed) return fail("DIFF_FAILED", "git diff 失败：" + tail(combinedOutput(res), 300));

  // 未跟踪文件：git diff 不会有输出，改成「全文按新增」展示
  if (!res.stdout.trim() && !payload.staged) {
    try {
      const raw = await fs.readFile(path.join(repo.root, rel), "utf8");
      const capped = raw.length > 256 * 1024 ? raw.slice(0, 256 * 1024) : raw;
      const lines = capped.split(/\r?\n/).map((l) => "+" + l);
      res = { stdout: ["--- /dev/null", "+++ b/" + rel, ...lines].join("\n") };
    } catch {
      /* 二进制或读不到：保持空 diff */
    }
  }
  return { ok: true, path: rel, staged: Boolean(payload.staged), diff: res.stdout };
}

async function handleRepoStage(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const paths = Array.isArray(payload.paths) ? payload.paths.filter(isSafeRepoPath) : [];
  const args = paths.length ? ["add", "--", ...paths] : ["add", "-A"];
  const res = await gitRun(repo.root, args);
  if (res.failed) return fail("STAGE_FAILED", "git add 失败：" + tail(combinedOutput(res), 300));
  return { ok: true, staged: paths.length || "all", message: paths.length ? `已暂存 ${paths.length} 个文件` : "已暂存全部改动" };
}

async function handleRepoUnstage(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const paths = Array.isArray(payload.paths) ? payload.paths.filter(isSafeRepoPath) : [];
  const args = paths.length ? ["restore", "--staged", "--", ...paths] : ["reset"];
  const res = await gitRun(repo.root, args);
  if (res.failed) return fail("UNSTAGE_FAILED", "取消暂存失败：" + tail(combinedOutput(res), 300));
  return { ok: true, message: paths.length ? `已取消暂存 ${paths.length} 个文件` : "已取消全部暂存" };
}

async function handleRepoCommit(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) return fail("NO_MESSAGE", "提交信息不能为空");
  if (message.length > 5000) return fail("MESSAGE_TOO_LONG", "提交信息过长");

  // 先确认确实有已暂存内容，避免 git commit 报一句难懂的话
  const staged = await gitRun(repo.root, ["diff", "--cached", "--name-only"]);
  if (!staged.failed && !staged.stdout.trim()) {
    return fail("NOTHING_STAGED", "没有已暂存的改动：先勾选文件「暂存」再提交");
  }
  const res = await gitRun(repo.root, ["commit", "-m", message], { timeout: 60000 });
  if (res.failed) {
    return identityFail(combinedOutput(res)) || fail("COMMIT_FAILED", "提交失败：" + tail(combinedOutput(res), 400));
  }
  const hash = await gitRun(repo.root, ["rev-parse", "--short", "HEAD"]);
  return {
    ok: true,
    hash: hash.failed ? "" : hash.stdout.trim(),
    message: "已提交",
    detail: tail(combinedOutput(res), 400),
  };
}

async function handleRepoBranches(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const res = await gitRun(repo.root, ["branch", "--all", "--no-color", "--format=%(refname:short)"]);
  if (res.failed) return fail("BRANCH_FAILED", "git branch 失败：" + tail(combinedOutput(res), 300));
  const current = await gitRun(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branches = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => ({ name, current: name === (current.failed ? "" : current.stdout.trim()), remote: name.startsWith("origin/") }));
  return { ok: true, current: current.failed ? "" : current.stdout.trim(), branches };
}

async function handleRepoCheckout(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const branch = String(payload.branch || "").trim();
  if (!isSafeBranchName(branch)) return fail("BAD_BRANCH", "分支名不合法");
  const res = await gitRun(repo.root, ["checkout", branch], { timeout: 60000 });
  if (res.failed) return fail("CHECKOUT_FAILED", "切换分支失败：" + tail(combinedOutput(res), 400));
  return { ok: true, branch, message: `已切换到 ${branch}` };
}

async function handleRepoCommitDiff(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const hash = String(payload.hash || "").trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) return fail("BAD_HASH", "提交号不合法");
  const res = await gitRun(repo.root, ["show", "--format=", "--unified=3", hash]);
  if (res.failed) return fail("DIFF_FAILED", "读取提交 diff 失败：" + tail(combinedOutput(res), 300));
  return { ok: true, hash, diff: res.stdout };
}

// ── 同步（push / pull / 合并 / 强制 / 对齐） ────────────────────────────────

async function currentBranch(root) {
  const res = await gitRun(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.failed ? "" : res.stdout.trim();
}

async function handleRepoPush(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const branch = await currentBranch(repo.root);
  const res = await gitRun(repo.root, ["push"], { timeout: 180000, useGitSsh: true });
  if (res.failed) {
    const out = combinedOutput(res);
    return identityFail(out) || fail("PUSH_FAILED", "推送失败：" + tail(out, 400), {
      hint: /no upstream/i.test(out) ? "这个分支还没有上游：先 git push -u origin <branch>" : "",
    });
  }
  return { ok: true, branch, message: "已推送", detail: tail(combinedOutput(res), 400) };
}

/** 只提交「已暂存」的内容再推送（不把未暂存的东西一起带走）。 */
async function handleRepoPushStaged(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "";
  const staged = await gitRun(repo.root, ["diff", "--cached", "--name-only"]);
  if (staged.failed) return fail("GIT_FAILED", "读取暂存区失败：" + tail(combinedOutput(staged), 300));
  const hasStaged = Boolean(staged.stdout.trim());

  if (hasStaged) {
    const commitRes = await gitRun(repo.root, ["commit", "-m", message || "chore: update staged changes"], { timeout: 60000 });
    if (commitRes.failed) {
      return identityFail(combinedOutput(commitRes)) || fail("COMMIT_FAILED", "提交失败：" + tail(combinedOutput(commitRes), 400));
    }
  }
  const pushRes = await gitRun(repo.root, ["push"], { timeout: 180000, useGitSsh: true });
  if (pushRes.failed) return fail("PUSH_FAILED", "推送失败：" + tail(combinedOutput(pushRes), 400));
  return { ok: true, committed: hasStaged, message: hasStaged ? "已提交并推送（只含已暂存内容）" : "没有已暂存内容，已直接推送现有提交" };
}

async function handleRepoPull(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const res = await gitRun(repo.root, ["pull", "--ff-only"], { timeout: 180000, useGitSsh: true });
  if (res.failed) {
    const out = combinedOutput(res);
    return fail("PULL_FAILED", "拉取失败：" + tail(out, 400), {
      hint: /not possible to fast-forward|diverged/i.test(out) ? "本地与远程分叉了，需要合并或强制拉取" : "",
    });
  }
  return { ok: true, message: /Already up to date/i.test(combinedOutput(res)) ? "已是最新" : "已拉取", detail: tail(combinedOutput(res), 400) };
}

async function handleRepoMergePush(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const pull = await gitRun(repo.root, ["pull", "--rebase"], { timeout: 180000, useGitSsh: true });
  if (pull.failed) {
    const out = combinedOutput(pull);
    if (/conflict/i.test(out)) return fail("CONFLICT", "拉取时出现冲突，已停下来等你处理（仓库保持原状）", { detail: tail(out, 600) });
    return fail("MERGE_FAILED", "合并拉取失败：" + tail(out, 400));
  }
  const push = await gitRun(repo.root, ["push"], { timeout: 180000, useGitSsh: true });
  if (push.failed) return fail("PUSH_FAILED", "推送失败：" + tail(combinedOutput(push), 400));
  return { ok: true, message: "已拉取并推送" };
}

async function handleRepoForcePush(payload = {}) {
  if (payload.confirm !== true) return fail("NEED_CONFIRM", "强制推送会覆盖远程，必须显式确认");
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const branch = await currentBranch(repo.root);
  const res = await gitRun(repo.root, ["push", "--force", "origin", branch], { timeout: 180000, useGitSsh: true });
  if (res.failed) return fail("FORCE_PUSH_FAILED", "强制推送失败：" + tail(combinedOutput(res), 400));
  return { ok: true, branch, message: `已强制推送 ${branch}（远程被覆盖）` };
}

async function handleRepoForcePull(payload = {}) {
  if (payload.confirm !== true) return fail("NEED_CONFIRM", "强制拉取会覆盖本地改动，必须显式确认");
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const res = await gitRun(repo.root, ["pull", "--force"], { timeout: 180000, useGitSsh: true });
  if (res.failed) return fail("FORCE_PULL_FAILED", "强制拉取失败：" + tail(combinedOutput(res), 400));
  return { ok: true, message: "已强制拉取" };
}

/** 对齐：fetch + reset --hard origin/<branch>（本地完全回到远程状态，会丢本地改动）。 */
async function handleRepoAlign(payload = {}) {
  if (payload.confirm !== true) return fail("NEED_CONFIRM", "对齐会丢掉本地所有未提交改动，必须显式确认");
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const branch = await currentBranch(repo.root);
  if (!isSafeBranchName(branch)) return fail("BAD_BRANCH", "当前分支名不可用");
  const fetchRes = await gitRun(repo.root, ["fetch", "origin"], { timeout: 180000, useGitSsh: true });
  if (fetchRes.failed) return fail("FETCH_FAILED", "git fetch 失败：" + tail(combinedOutput(fetchRes), 400));
  const resetRes = await gitRun(repo.root, ["reset", "--hard", "origin/" + branch], { timeout: 60000 });
  if (resetRes.failed) return fail("ALIGN_FAILED", "对齐失败：" + tail(combinedOutput(resetRes), 400), {
    hint: /unknown revision|ambiguous argument/i.test(combinedOutput(resetRes)) ? `远程没有 ${branch} 分支` : "",
  });
  return { ok: true, branch, message: `已对齐到 origin/${branch}` };
}

// ── 建库：git init / 同名检测 / 新建仓库并推送 / 可见性 ─────────────────────

async function handleRepoInit(payload = {}) {
  const found = await locateRepo(payload.dir);
  if (!found.ok) return found;
  if (found.isRepo) return { ok: true, already: true, message: "已经是 git 仓库，未做改动" };
  const res = await gitRun(found.dir, ["init"]);
  if (res.failed) return fail("INIT_FAILED", "git init 失败：" + tail(combinedOutput(res), 300));
  const identity = await gitRun(found.dir, ["config", "user.email"]);
  return {
    ok: true,
    dir: found.dir,
    message: "已初始化仓库（未设置提交身份；提交前需要 git config user.name / user.email）",
    hasIdentity: !identity.failed && Boolean(identity.stdout.trim()),
  };
}

/** 同名仓库是否已存在于该平台（GitHub 走 gh，Gitee 走 OpenAPI）。 */
async function handleRepoExists(payload = {}) {
  const provider = normalizeProvider(payload.provider);
  const name = String(payload.name || "").trim();
  if (!isSafeRepoName(name)) return fail("BAD_NAME", "仓库名不合法");

  if (provider === "github") {
    const gh = resolveBin("gh");
    if (!gh.path) return fail("NO_GH", "找不到 gh 命令");
    const login = await ghAccount();
    if (!login.login) return fail("NOT_LOGGED_IN", "gh 未登录：先 gh auth login");
    const res = await run(gh.path, ["repo", "view", `${login.login}/${name}`, "--json", "name,visibility"], { timeout: TIMEOUT.gh });
    if (res.failed) return { ok: true, exists: false, name, owner: login.login };
    let visibility = "";
    try {
      visibility = JSON.parse(res.stdout).visibility || "";
    } catch {
      visibility = "";
    }
    return { ok: true, exists: true, name, owner: login.login, visibility };
  }

  const saved = await readGiteeToken();
  if (!saved.token) return fail("NO_TOKEN", "Gitee 模式需要先配置私人访问令牌");
  if (!saved.login) return fail("NO_LOGIN", "令牌还没校验过账号，请重新保存一次令牌");
  try {
    const text = await giteeFetch(`/repos/${encodeURIComponent(saved.login)}/${encodeURIComponent(name)}`, saved.token);
    const body = JSON.parse(text);
    return { ok: true, exists: true, name, owner: saved.login, visibility: body.private ? "private" : "public" };
  } catch (error) {
    if (String(error.message || "").includes("404")) return { ok: true, exists: false, name, owner: saved.login };
    return fail("CHECK_FAILED", "查询 Gitee 仓库失败：" + (error.message || String(error)));
  }
}

/** 新建远程仓库并推送。GitHub: gh repo create --source=. --push；Gitee: OpenAPI + SSH remote + push。 */
async function handleRepoCreate(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const provider = normalizeProvider(payload.provider);
  const isPrivate = payload.private !== false;
  const existing = await handleRepoExists({ provider, name: payload.name || path.basename(repo.root) });
  if (!existing.ok) return existing;
  const name = String(payload.name || path.basename(repo.root)).trim();
  if (!isSafeRepoName(name)) return fail("BAD_NAME", `仓库名不合法：${name}`);
  if (existing.exists) return fail("ALREADY_EXISTS", `同名仓库已存在：${existing.owner}/${name}`, { visibility: existing.visibility });

  // 全新目录没有任何提交时，先做一个初始提交，否则推送会报 "no commits found"
  const head = await gitRun(repo.root, ["rev-parse", "--verify", "HEAD"]);
  if (head.failed) {
    await gitRun(repo.root, ["add", "-A"]);
    const first = await gitRun(repo.root, ["commit", "-m", "chore: initial commit"], { timeout: 60000 });
    if (first.failed) {
      return identityFail(combinedOutput(first)) || fail("COMMIT_FAILED", "创建初始提交失败：" + tail(combinedOutput(first), 400));
    }
  }

  if (provider === "github") {
    const gh = resolveBin("gh");
    if (!gh.path) return fail("NO_GH", "找不到 gh 命令");
    const args = ["repo", "create", name, isPrivate ? "--private" : "--public", "--source=.", "--push"];
    const res = await run(gh.path, args, { timeout: 300000, cwd: repo.root, useGitSsh: true });
    if (res.failed) return fail("CREATE_FAILED", "gh repo create 失败：" + tail(combinedOutput(res), 500));
    return { ok: true, provider, name, private: isPrivate, message: `已创建 ${name} 并推送`, detail: tail(combinedOutput(res), 300) };
  }

  const saved = await readGiteeToken();
  if (!saved.token) return fail("NO_TOKEN", "Gitee 模式需要先配置私人访问令牌");
  if (!saved.login) return fail("NO_LOGIN", "令牌还没校验过账号，请重新保存一次令牌");
  try {
    await giteeFetch(
      "/user/repos?" +
        new URLSearchParams({ name, private: isPrivate ? "true" : "false", auto_init: "false" }).toString(),
      saved.token,
      20000,
    );
  } catch (error) {
    return fail("CREATE_FAILED", "Gitee 建仓失败：" + (error.message || String(error)), { detail: tail(error.body || "", 400) });
  }
  const remoteUrl = `git@gitee.com:${saved.login}/${name}.git`;
  const hasOrigin = await gitRun(repo.root, ["remote", "get-url", "origin"]);
  if (hasOrigin.failed) {
    const add = await gitRun(repo.root, ["remote", "add", "origin", remoteUrl]);
    if (add.failed) return fail("REMOTE_FAILED", "设置远程失败：" + tail(combinedOutput(add), 300));
  }
  const push = await gitRun(repo.root, ["push", "-u", "origin", "HEAD"], { timeout: 300000, useGitSsh: true });
  if (push.failed) return fail("PUSH_FAILED", "推送失败：" + tail(combinedOutput(push), 500), { remoteUrl });
  return { ok: true, provider, name, private: isPrivate, remoteUrl, message: `已在 Gitee 建仓并推送：${saved.login}/${name}` };
}

async function handleRepoVisibility(payload = {}) {
  const repo = await requireRepo(payload.dir);
  if (repo.error) return repo.error;
  const provider = normalizeProvider(payload.provider);
  const isPrivate = payload.private !== false;
  const name = String(payload.name || path.basename(repo.root));
  if (!isSafeRepoName(name)) return fail("BAD_NAME", "仓库名不合法");

  if (provider === "github") {
    const gh = resolveBin("gh");
    if (!gh.path) return fail("NO_GH", "找不到 gh 命令");
    const login = await ghAccount();
    if (!login.login) return fail("NOT_LOGGED_IN", "gh 未登录");
    const res = await run(gh.path, ["repo", "edit", `${login.login}/${name}`, isPrivate ? "--visibility=private" : "--visibility=public"], {
      timeout: TIMEOUT.gh,
    });
    if (res.failed) return fail("VISIBILITY_FAILED", "修改可见性失败：" + tail(combinedOutput(res), 400));
    return { ok: true, name, private: isPrivate, message: `已改为${isPrivate ? "私有" : "公开"}` };
  }

  const saved = await readGiteeToken();
  if (!saved.token || !saved.login) return fail("NO_TOKEN", "Gitee 模式需要先配置并校验令牌");
  try {
    await giteeFetch(
      `/repos/${encodeURIComponent(saved.login)}/${encodeURIComponent(name)}?` +
        new URLSearchParams({ private: isPrivate ? "true" : "false" }).toString(),
      saved.token,
      20000,
    );
  } catch (error) {
    return fail("VISIBILITY_FAILED", "修改可见性失败：" + (error.message || String(error)));
  }
  return { ok: true, name, private: isPrivate, message: `已改为${isPrivate ? "私有" : "公开"}` };
}

// ── 工作区与自定义目录记忆 ─────────────────────────────────────────────────

const DIRS_FILE = "dirs.json";
const ROOTS_FILE = "roots.json";

async function handleScanRootsList() {
  const saved = await readJsonFile(ROOTS_FILE, { roots: [] });
  const roots = Array.isArray(saved.roots) ? saved.roots.filter((r) => typeof r === "string" && path.isAbsolute(r)) : [];
  const agent = await agentWorkspaceRoots();
  return { ok: true, roots, agentRoots: agent };
}

async function handleScanRootsAdd(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  if (!dir || !path.isAbsolute(dir)) return fail("BAD_DIR", "扫描根必须是绝对路径");
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return fail("NOT_DIR", "不是目录：" + dir);
  } catch {
    return fail("NO_DIR", "目录不存在：" + dir);
  }
  const saved = await readJsonFile(ROOTS_FILE, { roots: [] });
  const roots = Array.isArray(saved.roots) ? saved.roots : [];
  if (!roots.some((r) => r.toLowerCase() === dir.toLowerCase())) roots.unshift(dir);
  const trimmed = roots.slice(0, 20);
  const p = dataFile(ROOTS_FILE);
  if (p) await writePrivateFile(p, JSON.stringify({ roots: trimmed }, null, 2));
  scanCache = { at: 0, data: null };
  return { ok: true, roots: trimmed };
}

async function handleScanRootsRemove(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  const saved = await readJsonFile(ROOTS_FILE, { roots: [] });
  const roots = (Array.isArray(saved.roots) ? saved.roots : []).filter((r) => r.toLowerCase() !== dir.toLowerCase());
  const p = dataFile(ROOTS_FILE);
  if (p) await writePrivateFile(p, JSON.stringify({ roots }, null, 2));
  scanCache = { at: 0, data: null };
  return { ok: true, roots, message: "已移除该扫描根" };
}

async function handleDirsList() {
  const saved = await readJsonFile(DIRS_FILE, { dirs: [] });
  const dirs = Array.isArray(saved.dirs) ? saved.dirs.filter((d) => typeof d === "string" && path.isAbsolute(d)) : [];
  let workspace = "";
  try {
    const ws = await pi.workspace.get();
    workspace = ws && ws.path ? ws.path : "";
  } catch {
    workspace = "";
  }
  return { ok: true, workspace, dirs, cloneParent: prefs.cloneParent };
}

async function handleDirsAdd(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  if (!dir || !path.isAbsolute(dir)) return fail("BAD_DIR", "目录必须是绝对路径");
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return fail("NOT_DIR", "不是目录：" + dir);
  } catch {
    return fail("NO_DIR", "目录不存在：" + dir);
  }
  const saved = await readJsonFile(DIRS_FILE, { dirs: [] });
  const dirs = Array.isArray(saved.dirs) ? saved.dirs : [];
  if (!dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) dirs.unshift(dir);
  const trimmed = dirs.slice(0, 20);
  const p = dataFile(DIRS_FILE);
  if (p) await writePrivateFile(p, JSON.stringify({ dirs: trimmed }, null, 2));
  scanCache = { at: 0, data: null };
  return { ok: true, dirs: trimmed };
}

async function handleDirsRemove(payload = {}) {
  const dir = typeof payload.dir === "string" ? payload.dir.trim() : "";
  const saved = await readJsonFile(DIRS_FILE, { dirs: [] });
  const dirs = (Array.isArray(saved.dirs) ? saved.dirs : []).filter((d) => d.toLowerCase() !== dir.toLowerCase());
  const p = dataFile(DIRS_FILE);
  if (p) await writePrivateFile(p, JSON.stringify({ dirs }, null, 2));
  return { ok: true, dirs, message: "已从列表移除（未删文件夹）" };
}

// ── 本地仓库扫描（③ 要能看见磁盘上已有的仓库） ────────────────────────────

/** 扫描时跳过的目录名：进去只会白白耗时，或者根本不是项目。 */
const SCAN_SKIP = new Set([
  "node_modules", ".git", ".svn", ".hg", ".cache", ".npm", ".vscode", ".idea", ".venv", "venv",
  "AppData", "Windows", "$Recycle.Bin", "System Volume Information", "Program Files", "Program Files (x86)",
  "ProgramData", "dist", "build", "obj", "target", "vendor", ".gradle", ".nuxt", ".next",
]);
const SCAN_BUDGET_MS = 1500;
const SCAN_MAX_DIRS = 4000;
const SCAN_DEPTH = 2;

/** 从 agent 的工作区配置文本里抽绝对路径（DSH 的 workspace.json 就是 `"path": "..."`）。 */
function parseWorkspacePaths(text) {
  const out = [];
  const re = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const raw = m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    if (raw && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))) out.push(raw);
  }
  return [...new Set(out)];
}

/**
 * 各 agent 登记过的工作区目录。
 * 为什么需要：仓库常常在「某个 agent 的工作区」里，深度能到 4 层
 * （如 D:\文档\deepseek-harness\default-workspace\dsh-mainline），
 * 只靠盘根 2 层永远扫不到。把工作区本身当根就只剩 1 层。
 */
async function agentWorkspaceRoots() {
  const candidates = [
    path.join(HOME, ".dsh", "storages", "workspace.json"), // DSH
  ];
  const out = [];
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, "utf8");
      for (const p of parseWorkspacePaths(text)) out.push(p);
    } catch {
      /* 没装或没建过工作区 */
    }
  }
  return out;
}
function scanRootCandidates() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const s = path.resolve(p);
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  return { add, out };
}

async function defaultScanRoots() {
  const { add, out } = scanRootCandidates();
  try {
    const ws = await pi.workspace.get();
    if (ws && ws.path) add(ws.path);
  } catch {
    /* 没有打开项目就没有工作区 */
  }
  add(prefs.cloneParent);
  const saved = await readJsonFile(DIRS_FILE, { dirs: [] });
  for (const d of Array.isArray(saved.dirs) ? saved.dirs : []) add(d);

  // 各 agent 登记过的工作区（DSH 记在 ~/.dsh/storages/workspace.json）：
  // 仓库常在里面好几层（…\default-workspace\dsh-mainline），把工作区本身当根就只剩 1 层
  for (const root of await agentWorkspaceRoots()) add(root);
  // 用户在「总览」里手动加的额外扫描根
  const extra = await readJsonFile(ROOTS_FILE, { roots: [] });
  for (const root of Array.isArray(extra.roots) ? extra.roots : []) add(root);

  // 常见位置
  add(path.join(HOME, "code"));
  add(path.join(HOME, "projects"));
  add(path.join(HOME, "workspace"));
  add(path.join(HOME, "Documents", "GitHub"));
  add(path.join(HOME, "Desktop"));
  if (IS_WIN) {
    add(path.join(HOME, "git"));
    for (const drive of ["C", "D", "E", "F"]) {
      add(`${drive}:\\code`);
      add(`${drive}:\\Code`);
      add(`${drive}:\\projects`);
      add(`${drive}:\\workspace`);
    }
  } else {
    add(path.join(HOME, "src"));
    add("/opt/code");
  }
  add(HOME);
  // 盘根本身也要扫（深度 1）：很多人的仓库就摆在 C:\codex_xxx、D:\proj_xxx 这种位置，
  // 不在任何「工作区/常用目录」里 —— 只扫固定目录就会漏掉它们。
  if (IS_WIN) {
    for (const drive of ["C", "D", "E", "F", "G"]) add(`${drive}:\\`);
  }
  // 只保留真实存在的目录（未插的盘、不存在的路径直接丢掉）
  const existing = [];
  for (const dir of out) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) existing.push(dir);
    } catch {
      /* 不存在就跳过 */
    }
  }
  return existing.slice(0, 16);
}

/**
 * 在给定根目录下找 git 仓库（深度 ≤ 2，带时间与数量预算）。
 * 命中条件是子目录里有 .git（目录或 worktree 的 .git 文件都算）。
 */
async function scanRootForRepos(root, options = {}) {
  const depth = options.depth || SCAN_DEPTH;
  const budget = options.budgetMs || SCAN_BUDGET_MS;
  const started = Date.now();
  const found = [];
  let visited = 0;
  let queue = [{ dir: root, level: 0 }];

  while (queue.length) {
    if (Date.now() - started > budget || visited > SCAN_MAX_DIRS) break;
    const next = [];
    for (const item of queue) {
      visited += 1;
      let entries;
      try {
        entries = await fs.readdir(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = new Set(entries.map((e) => e.name));
      if (names.has(".git")) {
        found.push({ path: item.dir, name: path.basename(item.dir), root });
        continue; // 仓库内部不用再往下找
      }
      if (item.level >= depth) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || SCAN_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        next.push({ dir: path.join(item.dir, entry.name), level: item.level + 1 });
      }
    }
    queue = next;
  }
  return { found, visited, elapsedMs: Date.now() - started };
}

async function scanLocalRepos(options = {}) {
  const roots = Array.isArray(options.roots) && options.roots.length ? options.roots : await defaultScanRoots();
  const seen = new Set();
  const repos = [];
  const stats = [];
  for (const root of roots) {
    // 盘根下探两层：既能找到 C:\codex_xxx，也能找到 D:\work\proj 这种；
    // 系统目录已在 SCAN_SKIP 里排除，另有时间/数量预算兜底。
    const isDriveRoot = /^[A-Za-z]:[\\/]?$/.test(root);
    const res = await scanRootForRepos(root, { budgetMs: options.budgetMs, depth: isDriveRoot ? 2 : SCAN_DEPTH });
    let added = 0;
    for (const repo of res.found) {
      const key = repo.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(repo);
      added += 1;
    }
    stats.push({ root, found: added, visited: res.visited, elapsedMs: res.elapsedMs });
  }
  return { ok: true, roots, repos: repos.slice(0, 200), total: repos.length, stats };
}

async function handleReposScan(payload = {}) {
  return scanLocalRepos({ roots: Array.isArray(payload.roots) ? payload.roots : null, budgetMs: payload.budgetMs });
}

/** 扫描结果缓存 60s：④ 的「本地已有」判定也要用，不能每次点都全盘扫。 */
let scanCache = { at: 0, data: null };
async function getScannedRepos(force) {
  if (!force && scanCache.data && Date.now() - scanCache.at < 60000) return scanCache.data;
  const data = await scanLocalRepos({});
  scanCache = { at: Date.now(), data };
  return data;
}

// ── 全部本地仓库总览（把散落在各处的仓库汇总成一张表） ────────────────────

/** 直接读 .git/HEAD 拿分支名，省一次 git 进程。 */
function parseGitHead(text) {
  const s = String(text || "").trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(s);
  if (m) return { branch: m[1], detached: false };
  if (/^[0-9a-f]{40}$/.test(s)) return { branch: "", detached: true };
  return { branch: "", detached: false };
}

/** 从 .git/config 里取 origin 的 url（也可能是第一个远程）。 */
function parseGitConfigRemote(text) {
  const src = String(text || "");
  const blocks = src.split(/^\[/m);
  let firstAny = "";
  for (const block of blocks) {
    const header = /^remote\s+"([^"]+)"/.exec(block);
    if (!header) continue;
    const url = /^\s*url\s*=\s*(.+)$/m.exec(block);
    if (!url) continue;
    const remoteUrl = url[1].trim();
    if (header[1] === "origin") return { name: "origin", url: remoteUrl };
    if (!firstAny) firstAny = remoteUrl;
  }
  return firstAny ? { name: "origin", url: firstAny } : { name: "", url: "" };
}

/** 远程地址归一化：ssh/https、有无 .git、大小写差异都算同一个远程。 */
function normalizeRemoteUrl(url) {
  let s = String(url || "").trim();
  if (!s) return "";
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(s);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}`;
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(s);
  if (https) return `${https[1].toLowerCase()}/${https[2].toLowerCase()}`;
  return s.toLowerCase();
}

/** 「这个仓库可能是谁拉下来的」——只看路径/远程里的关键词，纯提示，不下结论。 */
function agentHint(repoPath, remoteUrl) {
  const haystack = `${repoPath} ${remoteUrl}`.toLowerCase();
  for (const [key, label] of [
    ["codex", "Codex"],
    ["claude", "Claude"],
    ["copilot", "Copilot"],
    ["cursor", "Cursor"],
    ["gemini", "Gemini"],
    ["pi-desktop", "PI-Desktop"],
  ]) {
    if (haystack.includes(key)) return label;
  }
  return "";
}

/** 同一远程的多个本地副本 —— 这正是「不同 agent 各拉一份」的典型后果。 */
function groupByRemote(repos) {
  const map = new Map();
  for (const repo of repos || []) {
    const key = normalizeRemoteUrl(repo.remoteUrl);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(repo.path);
  }
  return map;
}

async function readRepoFacts(repoPath) {
  const gitDir = path.join(repoPath, ".git");
  let head = { branch: "", detached: false };
  let remote = { name: "", url: "" };
  try {
    head = parseGitHead(await fs.readFile(path.join(gitDir, "HEAD"), "utf8"));
  } catch {
    /* worktree 的 .git 是文件，读不到 HEAD 就去问 git */
  }
  try {
    remote = parseGitConfigRemote(await fs.readFile(path.join(gitDir, "config"), "utf8"));
  } catch {
    /* 同上 */
  }
  if (!head.branch) {
    const b = await gitRun(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!b.failed) head = { branch: b.stdout.trim(), detached: false };
  }
  if (!remote.url) {
    const r = await gitRun(repoPath, ["remote", "-v"]);
    const first = r.failed ? "" : r.stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) remote = { name: first.split(/\s+/)[0], url: first.split(/\s+/)[1] };
  }

  let dirty = 0;
  const st = await gitRun(repoPath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!st.failed) dirty = st.stdout.split(/\r?\n/).filter((l) => l.trim()).length;

  let lastCommit = null;
  const lg = await gitRun(repoPath, ["log", "-1", "--date=short", "--pretty=format:%h%x1f%ad%x1f%an%x1f%s"]);
  if (!lg.failed && lg.stdout.trim()) {
    const parts = lg.stdout.split("\x1f");
    if (parts.length >= 4) lastCommit = { hash: parts[0], date: parts[1], author: parts[2], subject: parts.slice(3).join("\x1f") };
  }

  let ahead = 0;
  let behind = 0;
  const counts = await gitRun(repoPath, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!counts.failed) {
    const m = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
    if (m) {
      behind = Number(m[1]);
      ahead = Number(m[2]);
    }
  }

  return {
    path: repoPath,
    name: path.basename(repoPath),
    branch: head.branch || (head.detached ? "（detached）" : ""),
    remoteName: remote.name,
    remoteUrl: remote.url,
    dirty,
    ahead,
    behind,
    lastCommit,
    hint: agentHint(repoPath, remote.url),
  };
}

/** 并发上限，避免几十个仓库同时 fork 一堆 git 进程。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { path: items[index].path, name: items[index].name, error: String((error && error.message) || error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function handleReposIndex(payload = {}) {
  const scan = await scanLocalRepos({
    roots: Array.isArray(payload.roots) && payload.roots.length ? payload.roots : null,
    budgetMs: payload.budgetMs,
  });
  const base = scan.repos.slice(0, Number(payload.limit) || 80);
  const detailed = await mapLimit(base, 5, (repo) => readRepoFacts(repo.path));

  const groups = groupByRemote(detailed);
  const duplicates = [];
  for (const [remoteKey, paths] of groups) {
    if (paths.length > 1) duplicates.push({ remoteKey, paths });
  }
  const dupPaths = new Set(duplicates.flatMap((d) => d.paths));

  return {
    ok: true,
    roots: scan.roots,
    stats: scan.stats,
    total: scan.total,
    listed: detailed.length,
    truncated: scan.total > detailed.length,
    duplicates,
    repos: detailed.map((repo) => Object.assign({}, repo, { duplicateOf: dupPaths.has(repo.path) ? normalizeRemoteUrl(repo.remoteUrl) : "" })),
  };
}

// ── Agent 工具（让 AI 在对话里直接读/操作仓库） ────────────────────────────

/** 工具用哪个仓库：显式 dir 优先，否则用上次在面板里操作过的仓库。 */
async function resolveToolDir(args = {}) {
  const explicit = typeof args.dir === "string" ? args.dir.trim() : "";
  if (explicit) return explicit;
  if (prefs.lastRepo && fsSync.existsSync(prefs.lastRepo)) return prefs.lastRepo;
  return "";
}

function needDirMessage() {
  return "缺少 dir：请给出仓库绝对路径，或先在面板 ③ 页选一个仓库（总览页可以扫描本地仓库）";
}

const GIT_READ_ACTIONS = ["status", "diff", "log", "branches", "bigFiles"];

async function runGitRepoAction(args = {}) {
  const action = String(args.action || "").trim();
  const dir = await resolveToolDir(args);
  const allowed = [
    ...GIT_READ_ACTIONS,
    "stage", "unstage", "commit", "checkout", "push", "pull", "mergePush",
    "pushStaged", "align", "init", "createRepo", "setVisibility", "revert", "cherryPick", "ignoreBig",
  ];
  if (!allowed.includes(action)) {
    return { ok: false, error: `unknown action "${action}"; use ${allowed.join(", ")}` };
  }
  if (!dir && action !== "init") return { ok: false, error: needDirMessage() };

  switch (action) {
    case "status": {
      const res = await handleRepoStatus({ dir, thresholdBytes: args.thresholdBytes });
      if (!res.ok) return res;
      // 给模型瘦身：只保留判断需要的字段
      return {
        ok: true,
        isRepo: res.isRepo,
        root: res.root,
        branch: res.branch,
        remote: res.remote,
        upstream: res.upstream,
        ahead: res.ahead,
        behind: res.behind,
        changes: res.changes,
        bigFiles: (res.bigFiles || []).map((f) => ({ path: f.path, size: f.size })),
        files: (res.files || []).slice(0, 50),
        truncated: res.truncated,
      };
    }
    case "diff": {
      const res = await handleRepoDiff({ dir, path: args.path, staged: args.staged });
      if (!res.ok) return res;
      return { ok: true, path: res.path, staged: res.staged, diff: tail(res.diff, 12000) };
    }
    case "log": {
      const res = await handleRepoLog({ dir, count: args.count });
      return res;
    }
    case "branches":
      return handleRepoBranches({ dir });
    case "bigFiles": {
      const res = await handleRepoStatus({ dir, thresholdBytes: args.thresholdBytes });
      if (!res.ok) return res;
      return { ok: true, thresholdBytes: res.thresholdBytes, bigFiles: res.bigFiles };
    }
    case "stage":
      return handleRepoStage({ dir, paths: args.paths });
    case "unstage":
      return handleRepoUnstage({ dir, paths: args.paths });
    case "commit":
      return handleRepoCommit({ dir, message: args.message });
    case "checkout":
      return handleRepoCheckout({ dir, branch: args.branch });
    case "push":
      return handleRepoPush({ dir });
    case "pull":
      return handleRepoPull({ dir });
    case "mergePush":
      return handleRepoMergePush({ dir });
    case "pushStaged":
      return handleRepoPushStaged({ dir, message: args.message });
    case "align":
    case "forcePush":
    case "forcePull": {
      // 破坏性操作：要求显式 confirm，缺了就直接拒绝并把风险说清楚
      if (args.confirm !== true) {
        return {
          ok: false,
          error: `${action} 会改写${action === "align" ? "本地工作区" : "远程/本地历史"}，必须先向用户确认，然后用 confirm: true 重试`,
        };
      }
      if (action === "align") return handleRepoAlign({ dir, confirm: true });
      if (action === "forcePush") return handleRepoForcePush({ dir, confirm: true });
      return handleRepoForcePull({ dir, confirm: true });
    }
    case "init":
      return handleRepoInit({ dir: dir || (typeof args.dir === "string" ? args.dir.trim() : "") });
    case "createRepo":
      return handleRepoCreate({
        dir,
        name: args.name,
        private: args.private !== false,
        provider: args.provider ? normalizeProvider(args.provider) : prefs.provider,
      });
    case "setVisibility":
      return handleRepoVisibility({
        dir,
        name: args.name,
        private: args.private !== false,
        provider: args.provider ? normalizeProvider(args.provider) : prefs.provider,
      });
    case "revert":
      return handleRepoRevert({ dir, hash: args.hash });
    case "cherryPick":
      return handleRepoCherryPick({ dir, hash: args.hash });
    case "ignoreBig":
      return handleRepoIgnore({ dir, thresholdBytes: args.thresholdBytes });
    default:
      return { ok: false, error: "unreachable" };
  }
}

async function runGitIndexAction(args = {}) {
  const action = String(args.action || "").trim();
  if (action === "list") {
    const res = await handleReposIndex({ limit: args.limit || 40 });
    if (!res.ok) return res;
    return {
      ok: true,
      total: res.total,
      listed: res.listed,
      truncated: res.truncated,
      duplicates: res.duplicates,
      repos: res.repos.map((r) => ({
        path: r.path,
        branch: r.branch,
        dirty: r.dirty,
        ahead: r.ahead,
        behind: r.behind,
        remoteUrl: r.remoteUrl,
        duplicateOf: r.duplicateOf,
        lastCommit: r.lastCommit ? `${r.lastCommit.date} ${r.lastCommit.author} ${r.lastCommit.subject}` : "",
        hint: r.hint,
      })),
    };
  }
  if (action === "clone") {
    const started = await handleCloneRun({ url: args.url, parentDir: args.parentDir });
    if (!started.ok) return started;
    // 工具调用有超时，但克隆要更久：这里等最多 100s，超时就告诉模型稍后用 status 看结果
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const job = cloneJobs.get(started.jobId);
      if (!job) return { ok: false, error: "克隆任务丢失" };
      if (job.state !== "running") {
        return {
          ok: job.ok,
          jobId: started.jobId,
          target: job.target,
          message: job.message,
          log: tail(job.log, 2000),
        };
      }
    }
    return {
      ok: true,
      pending: true,
      jobId: started.jobId,
      target: started.target,
      message: "克隆仍在进行，稍后可以检查目标目录，或在面板 ④ 页看进度",
    };
  }
  return { ok: false, error: `unknown action "${action}"; use list, clone` };
}

const GIT_REPO_TOOL = {
  name: "GitRepo",
  description: [
    "读/操作一个本地 git 仓库。",
    "读取类：status（分支/改动/领先落后/大文件）、diff（单文件，可 staged）、log、branches、bigFiles。",
    "写入类：stage、unstage、commit（需 message）、checkout（需 branch）、push、pull、mergePush、pushStaged、init、createRepo（新建远程仓库并推送）、setVisibility、revert、cherryPick、ignoreBig。",
    "align / forcePush / forcePull 会改写工作区或历史，必须先向用户确认，再用 confirm: true 调用。",
    "dir 省略时用面板里上次操作的仓库；不确定用哪个就先调 GitIndex 的 list。",
  ].join(" "),
  risk: "medium",
  planSafeActions: GIT_READ_ACTIONS,
  schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "status", "diff", "log", "branches", "bigFiles",
          "stage", "unstage", "commit", "checkout", "push", "pull", "mergePush", "pushStaged",
          "align", "forcePush", "forcePull", "init", "createRepo", "setVisibility", "revert", "cherryPick", "ignoreBig",
        ],
        description: "要执行的动作",
      },
      dir: { type: "string", description: "仓库绝对路径；省略则用面板上次操作的仓库" },
      path: { type: "string", description: "action=diff 时的仓库内相对路径" },
      staged: { type: "boolean", description: "action=diff 时看已暂存版本" },
      paths: { type: "array", items: { type: "string" }, description: "action=stage/unstage 时的路径列表；省略=全部" },
      message: { type: "string", description: "commit / pushStaged 的提交信息" },
      branch: { type: "string", description: "action=checkout 的目标分支" },
      hash: { type: "string", description: "revert / cherryPick 的提交号" },
      name: { type: "string", description: "createRepo / setVisibility 的仓库名（默认取目录名）" },
      private: { type: "boolean", description: "createRepo / setVisibility 是否私有（默认 true）" },
      provider: { type: "string", enum: ["github", "gitee"], description: "平台（默认用面板里选的）" },
      count: { type: "number", description: "action=log 的条数（默认 20）" },
      thresholdBytes: { type: "number", description: "大文件阈值（默认 100MB）" },
      confirm: { type: "boolean", description: "align / forcePush / forcePull 必须为 true" },
    },
    required: ["action"],
  },
  execute: runGitRepoAction,
};

const GIT_INDEX_TOOL = {
  name: "GitIndex",
  description: [
    "汇总本机的 git 仓库：list 返回扫描到的仓库（路径/分支/改动/领先落后/远程/重复副本），clone 把远程仓库克隆到指定目录。",
    "同一个远程出现多个本地副本时 duplicateOf 会标出来——通常意味着不同工具各拉了一份，可以据此提示用户清理。",
  ].join(" "),
  risk: "medium",
  planSafeActions: ["list"],
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "clone"], description: "list=汇总本地仓库，clone=克隆远程仓库" },
      url: { type: "string", description: "action=clone 的仓库地址（https 或 git@host:path）" },
      parentDir: { type: "string", description: "action=clone 的目标父目录（绝对路径）" },
      limit: { type: "number", description: "action=list 最多返回多少个仓库（默认 40）" },
    },
    required: ["action"],
  },
  execute: runGitIndexAction,
};

async function registerAgentTools() {
  if (!pi.agent || typeof pi.agent.registerTool !== "function") return false;
  await pi.agent.registerTool(GIT_REPO_TOOL);
  await pi.agent.registerTool(GIT_INDEX_TOOL);
  return true;
}

async function unregisterAgentTools() {
  if (!pi.agent || typeof pi.agent.unregisterTool !== "function") return;
  for (const name of [GIT_REPO_TOOL.name, GIT_INDEX_TOOL.name]) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* 已经没了就算了 */
    }
  }
}

// ── 偏好 ────────────────────────────────────────────────────────────────────

async function handlePrefsGet() {
  return { ok: true, prefs };
}

async function handlePrefsSet(payload = {}) {
  const next = sanitizePrefs({
    provider: payload.provider !== undefined ? payload.provider : prefs.provider,
    cloneParent: payload.cloneParent !== undefined ? payload.cloneParent : prefs.cloneParent,
  });
  if (next.cloneParent && !path.isAbsolute(next.cloneParent)) return fail("BAD_DIR", "目录必须是绝对路径");
  prefs = next;
  await persistPrefs();
  scanCache = { at: 0, data: null };
  return { ok: true, prefs };
}

// ── 通道表 / 生命周期 ───────────────────────────────────────────────────────

const CHANNELS = {
  "scm.hello": async () => ({ ok: true, version: VERSION, platform: process.platform }),
  "scm.env": handleEnv,
  "scm.prefs.get": handlePrefsGet,
  "scm.prefs.set": handlePrefsSet,
  "scm.ssh.status": handleSshStatus,
  "scm.ssh.genkey": handleGenKey,
  "scm.ssh.writeConfig": handleWriteConfig,
  "scm.ssh.test": handleSshTest,
  "scm.gitee.token.status": handleGiteeTokenStatus,
  "scm.gitee.token.set": handleGiteeTokenSet,
  "scm.gitee.token.clear": handleGiteeTokenClear,
  "scm.repos.list": handleReposList,
  "scm.clone.run": handleCloneRun,
  "scm.clone.status": handleCloneStatus,
  "scm.pickDir": handlePickDir,
  "scm.repo.status": handleRepoStatus,
  "scm.repo.ignore": handleRepoIgnore,
  "scm.repo.log": handleRepoLog,
  "scm.repo.revert": handleRepoRevert,
  "scm.repo.cherryPick": handleRepoCherryPick,
  "scm.tools.plan": handleToolsPlan,
  "scm.tool.install": handleToolInstall,
  "scm.tool.installMsi": handleToolInstallMsi,
  "scm.tool.job": handleToolJob,
  "scm.tools.checkUpdate": handleCheckUpdate,
  "scm.npm.status": handleNpmStatus,
  "scm.npm.pack": handleNpmPack,
  "scm.npm.publish": handleNpmPublish,
  "scm.npm.login": handleNpmLogin,
  "scm.npm.job": handleToolJob,
  // ③ 同步 / 暂存提交 / 分支 / 建库 / 目录记忆（对齐原版路由）
  "scm.repos.scan": handleReposScan,
  "scm.repos.index": handleReposIndex,
  "scm.scan.roots": handleScanRootsList,
  "scm.scan.addRoot": handleScanRootsAdd,
  "scm.scan.removeRoot": handleScanRootsRemove,
  "scm.repo.diff": handleRepoDiff,
  "scm.repo.stage": handleRepoStage,
  "scm.repo.unstage": handleRepoUnstage,
  "scm.repo.commit": handleRepoCommit,
  "scm.repo.branches": handleRepoBranches,
  "scm.repo.checkout": handleRepoCheckout,
  "scm.repo.commitDiff": handleRepoCommitDiff,
  "scm.repo.push": handleRepoPush,
  "scm.repo.pushStaged": handleRepoPushStaged,
  "scm.repo.pull": handleRepoPull,
  "scm.repo.mergePush": handleRepoMergePush,
  "scm.repo.forcePush": handleRepoForcePush,
  "scm.repo.forcePull": handleRepoForcePull,
  "scm.repo.align": handleRepoAlign,
  "scm.repo.init": handleRepoInit,
  "scm.repo.exists": handleRepoExists,
  "scm.repo.create": handleRepoCreate,
  "scm.repo.visibility": handleRepoVisibility,
  "scm.dirs.list": handleDirsList,
  "scm.dirs.add": handleDirsAdd,
  "scm.dirs.remove": handleDirsRemove,
};

async function onPanelInvoke(channel, payload) {
  const handler = Object.prototype.hasOwnProperty.call(CHANNELS, channel) ? CHANNELS[channel] : null;
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload || {});
  } catch (error) {
    return fail("EXCEPTION", (error && error.message) || String(error));
  }
}

async function onLoad() {
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null;
  }
  if (dataPath) {
    try {
      await fs.mkdir(dataPath, { recursive: true, mode: 0o700 });
    } catch {
      /* 建不出来就既不读也不写偏好 */
    }
    prefs = sanitizePrefs(await readJsonFile("prefs.json", prefs));
  }
  binCache.clear();
  // 注册 agent 工具：失败（宿主没提供 pi.agent 或权限没批）不影响面板使用
  try {
    await registerAgentTools();
  } catch {
    /* 面板仍可用 */
  }
}

async function onUnload() {
  await unregisterAgentTools();
  cloneJobs.clear();
  binCache.clear();
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  internals: {
    normalizePort,
    normalizeProvider,
    detectEol,
    sshTarget,
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
    parsePorcelainZ,
    classifyChanges,
    formatBytes,
    ignorePatternFor,
    appendGitignore,
    parseGitLog,
    installPlan,
    ghDownloadUrl,
    ghMirrorById,
    GH_MIRRORS,
    parseVersion,
    compareVersions,
    maskNpmConfig,
    parseNpmPack,
    npmRunner,
    isSafeRepoPath,
    isSafeBranchName,
    isSafeRepoName,
    scanRootForRepos,
    defaultScanRoots,
    SCAN_SKIP,
    getScannedRepos,
    parseGitHead,
    parseGitConfigRemote,
    normalizeRemoteUrl,
    agentHint,
    groupByRemote,
    parseWorkspacePaths,
    agentWorkspaceRoots,
    GIT_REPO_TOOL,
    GIT_INDEX_TOOL,
    registerAgentTools,
    unregisterAgentTools,
  },
};
