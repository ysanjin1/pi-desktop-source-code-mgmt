"use strict";

/**
 * local.source-code-mgmt — 面板视图
 *
 * 通道：window.pluginBridge.invoke("scm.*", payload) → main.js 的 CHANNELS。
 * 宿主给自定义通道的转发超时是 30s，所以克隆这类长任务不会在这里干等：
 * scm.clone.run 立刻返回 jobId，这里低频轮询 scm.clone.status。
 *
 * 所有用户可见文本都走 textContent / createElement，不拼 innerHTML。
 */

const $ = (id) => document.getElementById(id);

const bridge = () => (window.pluginBridge && typeof window.pluginBridge.invoke === "function" ? window.pluginBridge : null);

async function invoke(channel, payload) {
  const b = bridge();
  if (!b) return { ok: false, code: "NO_BRIDGE", message: "面板通道不可用（请从工作面板里打开本视图）" };
  try {
    const res = await b.invoke(channel, payload || {});
    return res && typeof res === "object" ? res : { ok: false, code: "BAD_RESPONSE", message: String(res) };
  } catch (error) {
    return { ok: false, code: "INVOKE_FAILED", message: (error && error.message) || String(error) };
  }
}

const state = {
  provider: "github",
  // 每个平台各自一份端口/密钥：都来自该平台的现有配置，配置才是权威。
  // 不再用一个全局 port —— 那样改一个平台会顺手把另一个平台也改掉。
  github: { port: 443, keyName: "", keySource: "none" },
  gitee: { port: 443, keyName: "", keySource: "none" },
  env: null,
  ssh: null,
  cloneJob: null,
  pollTimer: null,
  busy: false,
};

/** 当前平台的端口/密钥状态 */
const provState = () => state[state.provider] || state.github;

// ── 小工具 ──────────────────────────────────────────────────────────────────

function banner(message, tone) {
  const el = $("banner");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = "banner" + (tone ? " " + tone : "");
}

function setNote(id, message, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.className = "note" + (tone ? " " + tone : "");
}

function setBusy(busy) {
  state.busy = busy;
  for (const btn of document.querySelectorAll("button.btn")) btn.disabled = busy;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

async function copyText(text) {
  if (!text) return false;
  const b = bridge();
  if (b) {
    try {
      const res = await b.invoke("clipboard.writeText", { text });
      if (!res || res.ok !== false) return true;
    } catch {
      /* 落到下面的兜底 */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = $("pubkey");
    if (area) {
      area.focus();
      area.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ── 分段 / 分页切换 ─────────────────────────────────────────────────────────

function switchPane(pane) {
  for (const btn of document.querySelectorAll("#tabs button, .tabs button")) {
    btn.setAttribute("aria-selected", btn.dataset.pane === pane ? "true" : "false");
  }
  for (const section of document.querySelectorAll(".pane")) {
    section.hidden = section.id !== "pane-" + pane;
  }
  // 第一次进 ③ 时顺手扫一次本地仓库（之后按缓存，点按钮才强制重扫）
  if (pane === "repo") scanRepos(false).catch(() => {});
  if (pane === "all") {
    loadScanRoots().catch(() => {});
    loadIndex(false).catch(() => {});
  }
}

async function switchProvider(provider) {
  state.provider = provider === "gitee" ? "gitee" : "github";
  for (const btn of document.querySelectorAll("#providers button")) {
    btn.setAttribute("aria-selected", btn.dataset.provider === state.provider ? "true" : "false");
  }
  $("tokenCard").hidden = state.provider !== "gitee";
  $("btnListRepos").textContent = state.provider === "gitee" ? "列出 Gitee 账号下的仓库" : "列出 GitHub 账号下的仓库";
  $("repoList").replaceChildren();
  $("repoNote").textContent = "";
  await invoke("scm.prefs.set", { provider: state.provider });
  if (state.provider === "gitee") await loadTokenStatus();
  await loadSshStatus();
}

// ── ① 环境 ──────────────────────────────────────────────────────────────────

let toolJobTimer = null;

function renderEnv(res) {
  const env = res.env || {};
  const plans = res.plans || {};
  const list = $("envBins");
  list.replaceChildren();
  const order = ["git", "ssh", "ssh-keygen", "gh"];
  for (const name of order) {
    const bin = (env.bins && env.bins[name]) || { path: null, source: "missing" };
    const plan = plans[name];
    const li = el("li");
    li.appendChild(el("span", "dot " + (bin.path ? "ok" : "err")));
    li.appendChild(el("span", "bin-name", name));
    const version = (env.versions && env.versions[name]) || "";
    li.appendChild(el("span", "bin-ver", bin.path ? version || bin.path : "缺失"));
    if (bin.path) li.title = `${bin.path}\n解析方式：${bin.source}`;

    if (!bin.path && plan && plan.available) {
      const install = el("button", "btn small", "安装");
      install.type = "button";
      install.title = plan.command || "";
      install.addEventListener("click", () => installTool(name));
      li.appendChild(install);
    }
    if (!bin.path && plan && !plan.available) {
      li.appendChild(el("span", "tag local", plan.notes || "无可用安装方式"));
    }
    if (bin.path && (name === "git" || name === "gh")) {
      const upd = el("button", "btn small", "检查更新");
      upd.type = "button";
      upd.addEventListener("click", () => checkUpdate(name, upd));
      li.appendChild(upd);
    }
    list.appendChild(li);
  }
  $("envMeta").textContent = `${env.platform} · ${env.arch} · ${env.sshDir}`;
  const missing = order.filter((n) => !env.bins || !env.bins[n] || !env.bins[n].path);
  if (!env.envPathPresent) {
    setNote("envNote", "插件进程里没有 PATH：工具只能靠已知安装位置与注册表解析。若显示缺失但命令行能用，说明装在非标准位置 —— 设置环境变量 SCM_GIT / SCM_SSH / SCM_GH 指向可执行文件即可。", "warn");
  } else if (missing.length) {
    setNote("envNote", `未找到：${missing.join("、")}。git 与 ssh 是 ② 的前提；gh 只有 GitHub 列仓库需要。`, "warn");
  } else {
    setNote("envNote", "四个工具都可用。");
  }
  const sel = $("ghMirror");
  if (!sel.options.length && Array.isArray(res.mirrors)) {
    for (const m of res.mirrors) {
      const o = el("option", null, m.label);
      o.value = m.id;
      sel.appendChild(o);
    }
  }
}

async function loadEnv(refresh) {
  const mirror = $("ghMirror") && $("ghMirror").value ? $("ghMirror").value : undefined;
  const res = await invoke("scm.tools.plan", { refresh: Boolean(refresh), mirror });
  if (!res.ok) {
    setNote("envNote", res.message || "环境检查失败", "err");
    return;
  }
  state.tools = res;
  renderEnv(res);
}

async function installTool(tool) {
  setBusy(true);
  setNote("toolProgress", `正在准备安装 ${tool}…`);
  try {
    const res = await invoke("scm.tool.install", { tool, mirror: $("ghMirror").value });
    if (!res.ok) {
      setNote("toolProgress", res.message || "安装失败", "err");
      return;
    }
    setNote("toolProgress", `${res.message}\n计划：${res.plan ? res.plan.command : ""}`);
    pollToolJob(res.jobId, res.next);
  } finally {
    setBusy(false);
  }
}

function pollToolJob(jobId, next) {
  if (toolJobTimer) clearTimeout(toolJobTimer);
  const started = Date.now();
  const tick = async () => {
    const res = await invoke("scm.tool.job", { jobId });
    if (!res.ok) {
      setNote("toolProgress", res.message || "任务丢失", "err");
      return;
    }
    const secs = Math.round(res.elapsedMs / 1000);
    if (res.done) {
      if (!res.succeeded) {
        setNote("toolProgress", `✗ ${res.label} 失败（${secs}s）\n${res.message || ""}`, "err");
        return;
      }
      if (next && next.kind === "msi") {
        setNote("toolProgress", "下载完成，开始静默安装（会弹 UAC）…");
        const step = await invoke("scm.tool.installMsi", { path: next.path });
        if (!step.ok) {
          setNote("toolProgress", step.message || "安装失败", "err");
          return;
        }
        pollToolJob(step.jobId, null);
        return;
      }
      setNote("toolProgress", `✓ ${res.label} 完成（${secs}s）\n${(state.tools && state.tools.restartHint) || ""}`, "ok");
      await loadEnv(true);
      return;
    }
    setNote("toolProgress", `${res.label} … ${secs}s\n${(res.log || "").slice(-500)}`);
    if (Date.now() - started > 20 * 60 * 1000) {
      setNote("toolProgress", "耗时过长，已停止跟踪（安装可能仍在后台进行）", "warn");
      return;
    }
    toolJobTimer = setTimeout(tick, 1200);
  };
  toolJobTimer = setTimeout(tick, 800);
}

async function checkUpdate(tool, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "检查中…";
  try {
    const res = await invoke("scm.tools.checkUpdate", { tool });
    if (!res.ok) {
      banner(res.message || "检查更新失败", "err");
      return;
    }
    if (res.note) {
      banner(res.note, "warn");
      return;
    }
    if (!res.hasUpdate) {
      banner(`${tool} 已是最新（${res.current || "?"}）`, "ok");
      return;
    }
    if (!window.confirm(`${tool} 有新版本：${res.current} → ${res.latest}\n\n现在更新？`)) return;
    await installTool(tool);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ── ② SSH ───────────────────────────────────────────────────────────────────

async function loadSshStatus() {
  const res = await invoke("scm.ssh.status");
  if (!res.ok) {
    setNote("sshWriteResult", res.message || "读取 SSH 状态失败", "err");
    return;
  }
  state.ssh = res;
  renderSshBlocks(res);
  // 每个平台各自一份状态（端口 + 密钥都取自该平台现有配置）
  for (const provider of ["github", "gitee"]) {
    const p = (res.providers && res.providers[provider]) || {};
    state[provider] = {
      port: p.port === 22 ? 22 : 443,
      keyName: p.keyName || "",
      keySource: p.keySource || "none",
      configured: Boolean(p.configured),
      identityFile: p.identityFile || "",
    };
  }
  syncSshControls();
}

function renderSshBlocks(res) {
  const blocks = $("sshBlocks");
  blocks.replaceChildren();
  for (const provider of ["github", "gitee"]) {
    const p = (res.providers && res.providers[provider]) || { configured: false };
    const li = el("li");
    li.appendChild(el("span", "dot " + (p.configured ? "ok" : "err")));
    li.appendChild(el("span", "bin-name", provider === "gitee" ? "Gitee" : "GitHub"));
    li.appendChild(
      el(
        "span",
        "bin-ver",
        p.configured ? `${p.hostName}:${p.port}${p.identityFile ? " · " + p.identityFile : ""}` : "未配置",
      ),
    );
    blocks.appendChild(li);
  }
  if (res.gh && res.gh.installed) {
    const li = el("li");
    li.appendChild(el("span", "dot " + (res.gh.login ? "ok" : "err")));
    li.appendChild(el("span", "bin-name", "gh"));
    li.appendChild(el("span", "bin-ver", res.gh.login ? "已登录：" + res.gh.login : "未登录（gh auth login）"));
    blocks.appendChild(li);
  }
  $("sshConfigPath").textContent = res.configPath + (res.configExists ? "" : "（文件尚不存在，写入时会创建）");
}

/** 把当前平台的端口/密钥同步到控件（切平台、刷新状态都走这里） */
function syncSshControls() {
  const cur = provState();
  $("portSelect").value = String(cur.port === 22 ? 22 : 443);

  const keys = (state.ssh && state.ssh.keys) || [];
  const select = $("keySelect");
  select.replaceChildren();
  // 默认项 = 不改密钥（沿用配置）。这是唯一安全的默认值。
  const keep = el("option", null, cur.keySource === "config" ? `沿用配置：${cur.keyName}` : "沿用配置（不指定密钥）");
  keep.value = "";
  select.appendChild(keep);
  for (const key of keys) {
    const opt = el("option", null, key.name + (cur.keyName === key.name && cur.keySource !== "config" ? "（探测）" : ""));
    opt.value = key.name;
    select.appendChild(opt);
  }
  select.value = "";

  const sourceText =
    cur.keySource === "config" ? "来自现有配置" : cur.keySource === "detected" ? "探测所得（配置里没写）" : "未找到";
  $("keySummary").textContent = cur.keyName ? `${cur.keyName} · ${sourceText}` : "未找到 ed25519 密钥";
  renderPubkey();
}

/** 公钥区跟随密钥下拉：选谁看谁；「沿用配置」时看当前平台配置的那把 */
function renderPubkey() {
  const keys = (state.ssh && state.ssh.keys) || [];
  const chosen = $("keySelect").value;
  const name = chosen || provState().keyName;
  const hit = keys.find((k) => k.name === name);
  $("pubkey").value = (hit && hit.pubkey) || "";
}

async function genKey() {
  setBusy(true);
  banner("");
  try {
    const res = await invoke("scm.ssh.genkey", { keyName: $("keySelect").value || "id_ed25519" });
    if (!res.ok) {
      banner(res.message || "生成密钥失败", "err");
      return;
    }
    banner(res.message || "已完成", "ok");
    await loadSshStatus();
  } finally {
    setBusy(false);
  }
}

async function writeConfig() {
  const cur = provState();
  const isGitee = state.provider === "gitee";
  const alias = isGitee ? "gitee.com" : "github.com";
  const host = isGitee ? "gitee.com" : cur.port === 22 ? "github.com" : "ssh.github.com";
  const chosen = $("keySelect").value;
  const identity = chosen ? `~/.ssh/${chosen}` : cur.identityFile || `~/.ssh/${cur.keyName || "id_ed25519"}`;
  const keepNote = chosen ? "" : "\n\n（IdentityFile 沿用你现有配置，不会被替换成别处的密钥）";
  const ok = window.confirm(
    `将把 ~/.ssh/config 里的 Host ${alias} 改为：\n\n  HostName ${host}\n  Port ${cur.port}\n  IdentityFile ${identity}${keepNote}\n\n只改这一个 Host 块（不产生重复块、不动其它 Host、保留文件换行符），改写前会把原文件备份在同目录。继续？`,
  );
  if (!ok) return;
  setBusy(true);
  banner("");
  try {
    const payload = { provider: state.provider, port: cur.port };
    if (chosen) payload.keyName = chosen;
    const res = await invoke("scm.ssh.writeConfig", payload);
    if (!res.ok) {
      setNote("sshWriteResult", res.message || "写入失败", "err");
      return;
    }
    setNote(
      "sshWriteResult",
      res.changed ? `${res.message}${res.backup ? "；原文件已备份到 " + res.backup : ""}` : res.message,
      res.changed ? "ok" : "",
    );
    await loadSshStatus();
  } finally {
    setBusy(false);
  }
}

async function sshTest() {
  const cur = provState();
  const chosen = $("keySelect").value;
  setBusy(true);
  setNote("sshTestResult", "正在测试连接…");
  try {
    const payload = { provider: state.provider, port: cur.port };
    // 只有显式选了某把钥匙才强制 -i；否则让 ssh 按 ~/.ssh/config 自己选
    if (chosen) payload.keyName = chosen;
    const res = await invoke("scm.ssh.test", payload);
    const via = res.mode === "config" ? `按 ~/.ssh/config（${res.host}）` : `直连 ${res.host}:${res.port}`;
    if (res.ok) {
      setNote("sshTestResult", `✓ ${res.message}\n${via}`, "ok");
    } else {
      setNote("sshTestResult", `✗ ${res.message}\n${via}${res.detail ? "\n" + res.detail : ""}`, "err");
    }
  } finally {
    setBusy(false);
  }
}

// ── Gitee 令牌 ──────────────────────────────────────────────────────────────

async function loadTokenStatus() {
  const res = await invoke("scm.gitee.token.status");
  if (!res.ok) return;
  $("giteeWho").textContent = res.configured ? (res.login ? "已保存：" + res.login : "已保存") : "未配置";
}

async function saveToken() {
  const token = $("giteeToken").value.trim();
  if (!token) {
    setNote("cloneParentNote", "令牌为空", "err");
    return;
  }
  setBusy(true);
  try {
    const res = await invoke("scm.gitee.token.set", { token });
    if (!res.ok) {
      banner(res.message || "保存失败", "err");
      return;
    }
    $("giteeToken").value = "";
    banner(res.message || "已保存", "ok");
    await loadTokenStatus();
  } finally {
    setBusy(false);
  }
}

async function clearToken() {
  setBusy(true);
  try {
    await invoke("scm.gitee.token.clear");
    banner("已清除 Gitee 令牌", "ok");
    await loadTokenStatus();
  } finally {
    setBusy(false);
  }
}

// ── ④ 克隆 ──────────────────────────────────────────────────────────────────

async function pickDir() {
  setBusy(true);
  try {
    const res = await invoke("scm.pickDir");
    if (!res.ok) {
      if (!res.cancelled) setNote("cloneParentNote", res.message || "选择目录失败", "err");
      return;
    }
    $("cloneParent").value = res.path;
    setNote("cloneParentNote", "已选择：" + res.path);
    await invoke("scm.prefs.set", { cloneParent: res.path, provider: state.provider });
  } finally {
    setBusy(false);
  }
}

async function saveParent(value) {
  const dir = String(value || "").trim();
  const res = await invoke("scm.prefs.set", { cloneParent: dir, provider: state.provider });
  if (!res.ok) {
    setNote("cloneParentNote", res.message || "目录无效", "err");
    return;
  }
  setNote("cloneParentNote", dir ? "已记住：" + dir : "");
}

async function listRepos() {
  setBusy(true);
  banner("");
  $("repoNote").textContent = state.provider === "gitee" ? "正在拉取 Gitee 列表…" : "正在拉取 gh 列表…";
  try {
    const res = await invoke("scm.repos.list", { provider: state.provider });
    const list = $("repoList");
    list.replaceChildren();
    if (!res.ok) {
      $("repoNote").textContent = "";
      list.appendChild(el("li", "empty", res.message || "获取失败"));
      return;
    }
    $("repoNote").textContent = `共 ${res.count} 个${res.note ? "（" + res.note + "）" : ""}`;
    if (!res.count) {
      list.appendChild(el("li", "empty", "这个账号下没有仓库"));
      return;
    }
    for (const repo of res.repos) {
      const li = el("li");
      li.appendChild(el("span", "repo-name", repo.name));
      if (repo.isPrivate) li.appendChild(el("span", "tag private", "私有"));
      const local = repo.local || {};
      if (local.exists) {
        li.appendChild(el("span", "tag local", local.isRepo ? "本地已有" : "同名目录"));
        li.title = local.dir || "";
      } else {
        const btn = el("button", "btn small", "克隆");
        btn.type = "button";
        btn.addEventListener("click", () => startClone(repo.sshUrl || "", btn));
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  } finally {
    setBusy(false);
  }
}

async function startClone(url, btn) {
  const parent = $("cloneParent").value.trim();
  if (!parent) {
    setNote("cloneProgress", "请先选择目标父目录", "err");
    switchPane("clone");
    return;
  }
  if (btn) btn.disabled = true;
  state.cloneJob = null;
  setNote("cloneProgress", "正在开始克隆…");
  const res = await invoke("scm.clone.run", { url, parentDir: parent });
  if (!res.ok) {
    setNote("cloneProgress", res.message || "克隆失败", "err");
    if (btn) btn.disabled = false;
    return;
  }
  setNote("cloneProgress", `克隆 ${res.name} → ${res.target}\n已开始，正在等待…`);
  pollClone(res.jobId, btn);
}

function pollClone(jobId, btn) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  const started = Date.now();
  const tick = async () => {
    const res = await invoke("scm.clone.status", { jobId });
    if (!res.ok) {
      setNote("cloneProgress", res.message || "任务丢失", "err");
      if (btn) btn.disabled = false;
      return;
    }
    const seconds = Math.round(res.elapsedMs / 1000);
    if (res.done) {
      if (res.succeeded) {
        setNote("cloneProgress", `✓ 克隆完成（${seconds}s）→ ${res.target}`, "ok");
        banner(`已克隆到 ${res.target}`, "ok");
      } else {
        setNote("cloneProgress", `✗ 克隆失败（${seconds}s）\n${res.message || ""}`, "err");
        if (btn) btn.disabled = false;
      }
      return;
    }
    setNote("cloneProgress", `克隆中… ${seconds}s\n${res.log ? res.log.slice(-400) : ""}`);
    if (Date.now() - started > 30 * 60 * 1000) {
      setNote("cloneProgress", "克隆耗时过长，已停止跟踪（git 进程可能仍在跑）", "warn");
      return;
    }
    state.pollTimer = setTimeout(tick, 1200);
  };
  state.pollTimer = setTimeout(tick, 600);
}

// ── ③ 代码管理 ──────────────────────────────────────────────────────────────

let bigFiles = [];

let dirsState = { workspace: "", dirs: [], cloneParent: "" };
let scannedRepos = [];
let scanDone = false;

async function loadDirs() {
  const res = await invoke("scm.dirs.list");
  if (!res.ok) return;
  dirsState = res;
  renderRepoOptions();
}

function renderRepoOptions() {
  const sel = $("repoPick");
  sel.replaceChildren();
  const addOption = (label, value) => {
    const o = el("option", null, label);
    o.value = value;
    sel.appendChild(o);
  };
  addOption("（从下面的列表里选一个仓库）", "");

  if (scannedRepos.length) {
    const group = document.createElement("optgroup");
    group.label = `扫描到的本地仓库（${scannedRepos.length}）`;
    for (const repo of scannedRepos) {
      const o = el("option", null, repo.path);
      o.value = repo.path;
      group.appendChild(o);
    }
    sel.appendChild(group);
  } else {
    addOption(scanDone ? "（没有扫描到本地仓库）" : "（还没扫描，点「扫描本地仓库」）", "");
  }

  const rest = document.createElement("optgroup");
  rest.label = "已登记 / 常用";
  if (dirsState.workspace) {
    const o = el("option", null, `当前项目：${dirsState.workspace}`);
    o.value = dirsState.workspace;
    rest.appendChild(o);
  }
  for (const d of dirsState.dirs || []) {
    const o = el("option", null, d);
    o.value = d;
    rest.appendChild(o);
  }
  if (dirsState.cloneParent) {
    const o = el("option", null, `克隆目录：${dirsState.cloneParent}`);
    o.value = dirsState.cloneParent;
    rest.appendChild(o);
  }
  if (rest.children.length) sel.appendChild(rest);
}

async function scanRepos(force) {
  if (scanDone && !force) return;
  setNote("repoScanNote", "正在扫描本地仓库（工作区 / 常用代码目录 / 已登记目录，深度 2）…");
  const res = await invoke("scm.repos.scan", {});
  if (!res.ok) {
    setNote("repoScanNote", res.message || "扫描失败", "err");
    return;
  }
  scannedRepos = res.repos || [];
  scanDone = true;
  const roots = (res.roots || [])
    .map((r) => r.split(/[\\/]/).filter(Boolean).pop() || r)
    .join(" / ");
  setNote(
    "repoScanNote",
    res.total
      ? `扫描到 ${res.total} 个本地仓库 · 扫描根：${roots}`
      : `没扫描到仓库 · 扫描根：${roots}（也可以直接粘贴路径，或把目录加进「已登记」）`,
    res.total ? "ok" : "warn",
  );
  renderRepoOptions();
}

async function repoPickFromList() {
  const value = $("repoPick").value;
  if (!value) return;
  $("repoDir").value = value;
  await loadRepoStatus();
}

async function rememberDir() {
  const dir = $("repoDir").value.trim();
  if (!dir) return;
  const res = await invoke("scm.dirs.add", { dir });
  if (res.ok) await loadDirs();
}

async function loadRepoStatus() {
  const dir = $("repoDir").value.trim();
  if (!dir) {
    setNote("repoNote", "请先选择或粘贴仓库目录", "err");
    return;
  }
  setBusy(true);
  banner("");
  setNote("repoNote", "正在读取…");
  try {
    const res = await invoke("scm.repo.status", { dir });
    if (!res.ok) {
      setNote("repoNote", res.message || "读取失败", "err");
      return;
    }
    if (!res.isRepo) {
      setNote("repoNote", (res.message || "这个目录还不是 git 仓库") + "（可以点下方「仅 git init」）", "warn");
      $("repoSummary").textContent = "—";
      $("repoFiles").replaceChildren();
      $("repoBig").replaceChildren();
      $("repoLog").replaceChildren();
      $("branchSelect").replaceChildren();
      return;
    }
    setNote("repoNote", "");
    await rememberDir();
    renderRepo(res);
    await loadBranches();
    await loadRepoLog();
  } finally {
    setBusy(false);
  }
}

function renderRepo(res) {
  const bits = [res.branch ? `分支 ${res.branch}` : "还没有提交"];
  if (res.remote) bits.push(`远程 ${res.remote}`);
  if (res.upstream) bits.push(`领先 ${res.ahead} / 落后 ${res.behind}`);
  bits.push(`改动 ${res.changes.total}（暂存 ${res.changes.staged} · 未暂存 ${res.changes.unstaged} · 未跟踪 ${res.changes.untracked}）`);
  $("repoSummary").textContent = bits.join(" · ");

  const files = $("repoFiles");
  files.replaceChildren();
  if (!res.files.length) files.appendChild(el("li", "empty", "工作区干净"));
  for (const f of res.files.slice(0, 80)) {
    const li = el("li");
    li.appendChild(el("span", "repo-name", f.path));
    li.appendChild(el("span", "tag", f.kind === "staged" ? "已暂存" : f.kind === "untracked" ? "未跟踪" : "未暂存"));

    const view = el("button", "btn small", "查看");
    view.type = "button";
    view.addEventListener("click", () => viewDiff(f.path, f.kind === "staged"));
    li.appendChild(view);

    const toggle = el("button", "btn small", f.kind === "staged" ? "取消暂存" : "暂存");
    toggle.type = "button";
    toggle.addEventListener("click", () => (f.kind === "staged" ? unstageFiles([f.path]) : stageFiles([f.path])));
    li.appendChild(toggle);
    files.appendChild(li);
  }

  bigFiles = res.bigFiles || [];
  const big = $("repoBig");
  big.replaceChildren();
  if (!bigFiles.length) big.appendChild(el("li", "empty", "没有超过阈值的改动文件"));
  for (const f of bigFiles) {
    const li = el("li");
    li.appendChild(el("span", "repo-name", f.path));
    li.appendChild(el("span", "tag local", f.size));
    big.appendChild(li);
  }
  const mb = Math.round((res.thresholdBytes || 0) / (1024 * 1024));
  $("repoBigHint").textContent = `阈值 ${mb}MB · 一级子目录里的文件会忽略整个目录，根目录文件只忽略它自己`;
}

async function viewDiff(path, staged) {
  const res = await invoke("scm.repo.diff", { dir: $("repoDir").value.trim(), path, staged });
  $("repoDiff").value = res.ok ? res.diff || "（没有差异）" : res.message || "读取失败";
}

async function stageFiles(paths) {
  const res = await invoke("scm.repo.stage", { dir: $("repoDir").value.trim(), paths });
  if (!res.ok) setNote("repoNote", res.message || "暂存失败", "err");
  await loadRepoStatus();
}

async function unstageFiles(paths) {
  const res = await invoke("scm.repo.unstage", { dir: $("repoDir").value.trim(), paths });
  if (!res.ok) setNote("repoNote", res.message || "取消暂存失败", "err");
  await loadRepoStatus();
}

async function commitNow() {
  const message = $("commitMessage").value.trim();
  if (!message) {
    setNote("commitResult", "提交信息不能为空", "err");
    return;
  }
  setBusy(true);
  try {
    const res = await invoke("scm.repo.commit", { dir: $("repoDir").value.trim(), message });
    if (!res.ok) {
      setNote("commitResult", res.message || "提交失败", "err");
      return;
    }
    $("commitMessage").value = "";
    setNote("commitResult", `✓ 已提交 ${res.hash}`, "ok");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function loadBranches() {
  const res = await invoke("scm.repo.branches", { dir: $("repoDir").value.trim() });
  const sel = $("branchSelect");
  sel.replaceChildren();
  if (!res.ok || !res.branches) return;
  for (const b of res.branches) {
    const o = el("option", null, b.name + (b.current ? "（当前）" : ""));
    o.value = b.name;
    if (b.current) o.selected = true;
    sel.appendChild(o);
  }
}

async function checkoutBranch() {
  const branch = $("branchSelect").value;
  if (!branch) return;
  if (!window.confirm(`切换到分支 ${branch}？未提交的改动可能被带过去。`)) return;
  setBusy(true);
  try {
    const res = await invoke("scm.repo.checkout", { dir: $("repoDir").value.trim(), branch });
    setNote("syncResult", res.ok ? `✓ ${res.message}` : res.message || "切换失败", res.ok ? "ok" : "err");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function syncAction(kind) {
  const dir = $("repoDir").value.trim();
  if (!dir) {
    setNote("syncResult", "请先选择仓库目录", "err");
    return;
  }
  const dangerous = { forcePush: "强制推送会覆盖远程", forcePull: "强制拉取会覆盖本地", align: "对齐会丢掉本地所有未提交改动" }[kind];
  if (dangerous && !window.confirm(`${dangerous}。继续？`)) return;
  const channel = {
    push: "scm.repo.push",
    pull: "scm.repo.pull",
    mergePush: "scm.repo.mergePush",
    pushStaged: "scm.repo.pushStaged",
    forcePush: "scm.repo.forcePush",
    forcePull: "scm.repo.forcePull",
    align: "scm.repo.align",
  }[kind];
  if (!channel) return;

  setBusy(true);
  setNote("syncResult", "正在执行…");
  try {
    const res = await invoke(channel, { dir, confirm: Boolean(dangerous) });
    setNote("syncResult", res.ok ? `✓ ${res.message}` : `✗ ${res.message || "失败"}${res.hint ? "\n" + res.hint : ""}`, res.ok ? "ok" : "err");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function initGit() {
  const dir = $("repoDir").value.trim();
  if (!dir) {
    setNote("createResult", "请先选择目录", "err");
    return;
  }
  setBusy(true);
  try {
    const res = await invoke("scm.repo.init", { dir });
    setNote("createResult", res.ok ? `✓ ${res.message}` : res.message || "初始化失败", res.ok ? "ok" : "err");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function createRepo() {
  const dir = $("repoDir").value.trim();
  if (!dir) {
    setNote("createResult", "请先选择目录", "err");
    return;
  }
  const isPrivate = $("repoVisibility").value !== "public";
  if (!window.confirm(`用当前目录名在该平台新建${isPrivate ? "私有" : "公开"}仓库并推送？`)) return;
  setBusy(true);
  setNote("createResult", "正在创建并推送…");
  try {
    const res = await invoke("scm.repo.create", { dir, provider: state.provider, private: isPrivate });
    setNote("createResult", res.ok ? `✓ ${res.message}` : res.message || "创建失败", res.ok ? "ok" : "err");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function setVisibility() {
  const dir = $("repoDir").value.trim();
  if (!dir) {
    setNote("createResult", "请先选择目录", "err");
    return;
  }
  const isPrivate = $("repoVisibility").value !== "public";
  setBusy(true);
  try {
    const res = await invoke("scm.repo.visibility", { dir, provider: state.provider, private: isPrivate });
    setNote("createResult", res.ok ? `✓ ${res.message}` : res.message || "修改失败", res.ok ? "ok" : "err");
  } finally {
    setBusy(false);
  }
}

async function ignoreBig() {
  if (!bigFiles.length) {
    setNote("repoIgnoreResult", "当前没有需要忽略的大文件", "warn");
    return;
  }
  setBusy(true);
  try {
    const res = await invoke("scm.repo.ignore", { dir: $("repoDir").value.trim() });
    setNote("repoIgnoreResult", res.message, res.changed ? "ok" : "");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function loadRepoLog() {
  const dir = $("repoDir").value.trim();
  if (!dir) return;
  const res = await invoke("scm.repo.log", { dir, count: 20 });
  const list = $("repoLog");
  list.replaceChildren();
  if (!res.ok) {
    list.appendChild(el("li", "empty", res.message || "读取历史失败"));
    return;
  }
  if (!res.commits.length) {
    list.appendChild(el("li", "empty", res.message || "还没有任何提交"));
    return;
  }
  for (const c of res.commits) {
    const li = el("li");
    li.appendChild(el("span", "tag", c.hash));
    li.appendChild(el("span", "repo-name", `${c.subject}  ·  ${c.author} ${c.date}`));
    const diffBtn = el("button", "btn small", "diff");
    diffBtn.type = "button";
    diffBtn.addEventListener("click", async () => {
      const res2 = await invoke("scm.repo.commitDiff", { dir, hash: c.hash });
      $("repoDiff").value = res2.ok ? res2.diff || "（空提交）" : res2.message || "读取失败";
    });
    li.appendChild(diffBtn);
    for (const [kind, label] of [["revert", "revert"], ["cherryPick", "pick"]]) {
      const btn = el("button", "btn small", label);
      btn.type = "button";
      btn.addEventListener("click", () => rewrite(kind, c.hash));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

async function rewrite(kind, hash) {
  const what = kind === "revert" ? "撤销（生成一个新提交）" : "cherry-pick 到当前分支";
  if (!window.confirm(`要${what} ${hash} 吗？\n\n有冲突时保持原状、不会自动继续。`)) return;
  setBusy(true);
  banner("");
  try {
    const res = await invoke(kind === "revert" ? "scm.repo.revert" : "scm.repo.cherryPick", {
      dir: $("repoDir").value.trim(),
      hash,
    });
    banner(res.ok ? res.message : res.message || "操作失败", res.ok ? "ok" : "err");
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}

async function repoPickDir() {
  setBusy(true);
  try {
    const res = await invoke("scm.pickDir");
    if (!res.ok) {
      if (!res.cancelled) setNote("repoNote", res.message || "选择目录失败", "err");
      return;
    }
    $("repoDir").value = res.path;
    await loadRepoStatus();
  } finally {
    setBusy(false);
  }
}
// ── ⑤ npm 发布 ─────────────────────────────────────────────────────────────

async function npmStatus() {
  const dir = $("npmDir").value.trim();
  const res = await invoke("scm.npm.status", { dir });
  if (!res.ok) {
    $("npmSummary").textContent = "—";
    setNote("npmNote", res.message || "读取 npm 状态失败", "err");
    return null;
  }
  const bits = [`registry ${res.registry || "?"}`];
  bits.push(res.loggedIn ? `已登录 ${res.login}` : "未登录（先点「打开终端登录」）");
  if (res.packageName) bits.push(`${res.packageName}@${res.packageVersion}`);
  if (res.mirrorConfigured) bits.push("全局是镜像源 → 发布仍走官方源");
  $("npmSummary").textContent = bits.join(" · ");
  const bad = Boolean(dir) && !res.hasPackageJson;
  setNote("npmNote", bad ? "这个目录里没有 package.json" : "", bad ? "warn" : "");
  return res;
}

async function npmPack() {
  const dir = $("npmDir").value.trim();
  if (!dir) {
    setNote("npmPackResult", "请先选择包目录", "err");
    return;
  }
  setBusy(true);
  setNote("npmPackResult", "正在预览打包…");
  try {
    const res = await invoke("scm.npm.pack", { dir });
    if (!res.ok) {
      setNote("npmPackResult", res.message || "预览失败", "err");
      return;
    }
    const kb = (n) => (Number(n || 0) / 1024).toFixed(1) + " KB";
    setNote(
      "npmPackResult",
      `${res.name}@${res.version} · ${res.files} 个文件 · 包 ${kb(res.size)} / 解包 ${kb(res.unpackedSize)}\n${res.filename || ""}`,
      "ok",
    );
  } finally {
    setBusy(false);
  }
}

async function npmLogin() {
  setBusy(true);
  try {
    const res = await invoke("scm.npm.login", { dir: $("npmDir").value.trim() });
    if (!res.ok) {
      setNote("npmNote", res.message || "打开终端失败", "err");
      return;
    }
    setNote("npmNote", `${res.message}\n${res.command}`, "ok");
  } finally {
    setBusy(false);
  }
}

async function npmPublish() {
  if (!$("npmConfirm").checked) {
    setNote("npmPublishResult", "请先勾选确认", "err");
    return;
  }
  const dir = $("npmDir").value.trim();
  if (!dir) {
    setNote("npmPublishResult", "请先选择包目录", "err");
    return;
  }
  setBusy(true);
  setNote("npmPublishResult", "正在发布…");
  try {
    const res = await invoke("scm.npm.publish", { dir, confirm: true });
    if (!res.ok) {
      setNote("npmPublishResult", res.message || "发布失败", "err");
      return;
    }
    pollNpmJob(res.jobId);
  } finally {
    setBusy(false);
  }
}

function pollNpmJob(jobId) {
  const started = Date.now();
  const tick = async () => {
    const res = await invoke("scm.npm.job", { jobId });
    if (!res.ok) {
      setNote("npmPublishResult", res.message || "任务丢失", "err");
      return;
    }
    const secs = Math.round(res.elapsedMs / 1000);
    if (res.done) {
      setNote(
        "npmPublishResult",
        res.succeeded ? `✓ 已发布（${secs}s）\n${(res.log || "").slice(-300)}` : `✗ 发布失败（${secs}s）\n${res.message || ""}`,
        res.succeeded ? "ok" : "err",
      );
      if (res.succeeded) await npmStatus();
      return;
    }
    setNote("npmPublishResult", `发布中… ${secs}s\n${(res.log || "").slice(-400)}`);
    if (Date.now() - started > 10 * 60 * 1000) {
      setNote("npmPublishResult", "耗时过长，已停止跟踪", "warn");
      return;
    }
    setTimeout(tick, 1200);
  };
  setTimeout(tick, 800);
}

async function npmPickDir() {
  setBusy(true);
  try {
    const res = await invoke("scm.pickDir");
    if (!res.ok) {
      if (!res.cancelled) setNote("npmNote", res.message || "选择目录失败", "err");
      return;
    }
    $("npmDir").value = res.path;
    await npmStatus();
  } finally {
    setBusy(false);
  }
}

// ── 总览：把散落各处的本地仓库汇总成一张表 ─────────────────────────────────

let indexDone = false;

async function loadScanRoots() {
  const res = await invoke("scm.scan.roots");
  const list = $("scanRoots");
  list.replaceChildren();
  if (!res.ok) return;
  const rows = [];
  for (const root of res.roots || []) rows.push({ dir: root, kind: "额外" });
  for (const root of res.agentRoots || []) rows.push({ dir: root, kind: "agent 工作区" });
  if (!rows.length) {
    list.appendChild(el("li", "empty", "没有额外扫描根（用上面的输入框可以加一个）"));
    return;
  }
  for (const row of rows) {
    const li = el("li");
    li.appendChild(el("span", "repo-name", row.dir));
    li.appendChild(el("span", "tag", row.kind));
    if (row.kind === "额外") {
      const del = el("button", "btn small", "移除");
      del.type = "button";
      del.addEventListener("click", () => removeScanRoot(row.dir));
      li.appendChild(del);
    }
    list.appendChild(li);
  }
}

async function addScanRoot() {
  const dir = $("scanRootInput").value.trim();
  if (!dir) {
    setNote("indexNote", "请先填写要扫描的目录", "err");
    return;
  }
  const res = await invoke("scm.scan.addRoot", { dir });
  if (!res.ok) {
    setNote("indexNote", res.message || "添加失败", "err");
    return;
  }
  $("scanRootInput").value = "";
  indexDone = false;
  await loadScanRoots();
  await loadIndex(true);
}

async function removeScanRoot(dir) {
  const res = await invoke("scm.scan.removeRoot", { dir });
  if (!res.ok) {
    setNote("indexNote", res.message || "移除失败", "err");
    return;
  }
  indexDone = false;
  await loadScanRoots();
  await loadIndex(true);
}

async function loadIndex(force) {
  if (indexDone && !force) return;
  setBusy(true);
  setNote("indexNote", "正在扫描并读取每个仓库的状态（首次会慢一点）…");
  try {
    const res = await invoke("scm.repos.index", {});
    if (!res.ok) {
      setNote("indexNote", res.message || "扫描失败", "err");
      return;
    }
    indexDone = true;
    renderIndex(res);
  } finally {
    setBusy(false);
  }
}

function renderIndex(res) {
  const bits = [`${res.listed} 个仓库`, `扫描根 ${res.roots.length} 个`];
  if (res.duplicates.length) bits.push(`同一远程多份 ${res.duplicates.length} 组`);
  if (res.truncated) bits.push(`共 ${res.total} 个，只列前 ${res.listed} 个`);
  $("indexSummary").textContent = bits.join(" · ");

  const list = $("indexList");
  list.replaceChildren();
  if (!res.repos.length) {
    list.appendChild(el("li", "empty", "没有找到本地仓库（可以粘贴路径，或把目录加进「已登记」）"));
  }
  for (const repo of res.repos) {
    const li = el("li");
    li.appendChild(el("span", "repo-name", repo.path));
    if (repo.error) {
      li.appendChild(el("span", "tag local", "读取失败"));
      li.title = repo.error;
    } else {
      const tags = [];
      if (repo.branch) tags.push(repo.branch);
      if (repo.dirty) tags.push(`改动 ${repo.dirty}`);
      if (repo.ahead) tags.push(`↑${repo.ahead}`);
      if (repo.behind) tags.push(`↓${repo.behind}`);
      if (repo.hint) tags.push(repo.hint);
      if (repo.duplicateOf) tags.push("同一远程多份");
      li.appendChild(el("span", "tag" + (repo.duplicateOf ? " local" : ""), tags.join(" · ") || "—"));
      if (repo.lastCommit) {
        li.title = `${repo.remoteUrl || "无远程"}\n最后一次提交：${repo.lastCommit.date} ${repo.lastCommit.author} — ${repo.lastCommit.subject}`;
      } else {
        li.title = repo.remoteUrl || "无远程";
      }
    }
    const use = el("button", "btn small", "用这个");
    use.type = "button";
    use.addEventListener("click", async () => {
      $("repoDir").value = repo.path;
      switchPane("repo");
      await loadRepoStatus();
    });
    li.appendChild(use);
    list.appendChild(li);
  }

  if (res.duplicates.length) {
    setNote(
      "indexNote",
      `发现 ${res.duplicates.length} 组「同一个远程的多个本地副本」：\n` +
        res.duplicates.map((d) => "  " + d.paths.join("  ⇄  ")).join("\n") +
        "\n通常是不同 agent 各拉了一份；保留一份、其余删掉即可（本插件不替你删）。",
      "warn",
    );
  } else {
    setNote("indexNote", `扫描完成：${res.listed} 个仓库，没有发现重复远程`, "ok");
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────

async function boot() {
  for (const btn of document.querySelectorAll("#tabs button, .tabs button")) {
    btn.addEventListener("click", () => switchPane(btn.dataset.pane));
  }
  for (const btn of document.querySelectorAll("#providers button")) {
    btn.addEventListener("click", () => switchProvider(btn.dataset.provider));
  }
  $("envRefresh").addEventListener("click", () => loadEnv(true));
  $("btnGenKey").addEventListener("click", genKey);
  $("btnCopyPub").addEventListener("click", async () => {
    const ok = await copyText($("pubkey").value.trim());
    banner(ok ? "公钥已复制" : "复制失败：请手动选中复制", ok ? "ok" : "err");
  });
  $("portSelect").addEventListener("change", () => {
    // 只改「当前平台」的端口；另一个平台的端口在它自己的配置里，不受影响
    const cur = provState();
    cur.port = Number($("portSelect").value) === 22 ? 22 : 443;
    setNote("sshWriteResult", "");
  });
  $("keySelect").addEventListener("change", renderPubkey);
  $("btnWriteConfig").addEventListener("click", writeConfig);
  $("btnSshTest").addEventListener("click", sshTest);
  $("btnPickDir").addEventListener("click", pickDir);
  $("cloneParent").addEventListener("change", () => saveParent($("cloneParent").value));
  $("btnSaveToken").addEventListener("click", saveToken);
  $("btnClearToken").addEventListener("click", clearToken);
  $("btnListRepos").addEventListener("click", listRepos);
  $("btnCloneUrl").addEventListener("click", () => startClone($("cloneUrl").value.trim(), $("btnCloneUrl")));
  $("btnRepoScan").addEventListener("click", () => scanRepos(true));
  $("btnIndexScan").addEventListener("click", () => loadIndex(true));
  $("btnAddRoot").addEventListener("click", addScanRoot);
  $("btnRepoRefresh").addEventListener("click", loadRepoStatus);
  $("btnRepoPick").addEventListener("click", repoPickDir);
  $("btnIgnoreBig").addEventListener("click", ignoreBig);
  $("btnRepoLog").addEventListener("click", loadRepoLog);
  $("repoDir").addEventListener("change", () => loadRepoStatus());
  $("repoPick").addEventListener("change", repoPickFromList);
  $("btnStageAll").addEventListener("click", () => stageFiles([]));
  $("btnUnstageAll").addEventListener("click", () => unstageFiles([]));
  $("btnCommit").addEventListener("click", commitNow);
  $("btnCheckout").addEventListener("click", checkoutBranch);
  $("btnPush").addEventListener("click", () => syncAction("push"));
  $("btnPull").addEventListener("click", () => syncAction("pull"));
  $("btnMergePush").addEventListener("click", () => syncAction("mergePush"));
  $("btnPushStaged").addEventListener("click", () => syncAction("pushStaged"));
  $("btnForcePush").addEventListener("click", () => syncAction("forcePush"));
  $("btnForcePull").addEventListener("click", () => syncAction("forcePull"));
  $("btnAlign").addEventListener("click", () => syncAction("align"));
  $("btnInitGit").addEventListener("click", initGit);
  $("btnCreateRepo").addEventListener("click", createRepo);
  $("btnSetVisibility").addEventListener("click", setVisibility);
  $("ghMirror").addEventListener("change", () => loadEnv(true));
  $("btnNpmCheck").addEventListener("click", npmStatus);
  $("btnNpmPick").addEventListener("click", npmPickDir);
  $("btnNpmLogin").addEventListener("click", npmLogin);
  $("btnNpmPack").addEventListener("click", npmPack);
  $("btnNpmPublish").addEventListener("click", npmPublish);
  $("npmConfirm").addEventListener("change", () => {
    $("btnNpmPublish").disabled = !$("npmConfirm").checked;
  });

  const prefs = await invoke("scm.prefs.get");
  if (prefs.ok && prefs.prefs) {
    state.provider = prefs.prefs.provider === "gitee" ? "gitee" : "github";
    $("cloneParent").value = prefs.prefs.cloneParent || "";
  }
  for (const btn of document.querySelectorAll("#providers button")) {
    btn.setAttribute("aria-selected", btn.dataset.provider === state.provider ? "true" : "false");
  }
  $("tokenCard").hidden = state.provider !== "gitee";
  $("btnListRepos").textContent = state.provider === "gitee" ? "列出 Gitee 账号下的仓库" : "列出 GitHub 账号下的仓库";
  switchPane("env");

  await loadEnv(false);
  await loadSshStatus();
  await loadDirs();
  if (state.provider === "gitee") await loadTokenStatus();
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((error) => banner("初始化失败：" + ((error && error.message) || String(error)), "err"));
});
