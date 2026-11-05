# 代码管理（local.source-code-mgmt）

PI-Desktop 工作面板里的代码管理插件，移植自 DSH 插件 [source-code-mgmt](https://github.com/Zhucy123/source-code-mgmt) 的 **①②③④⑤ 全部五块**，另加一个「总览」页与两个 agent 工具。

与 DSH 原版唯一的差集：**没有「一键重启宿主」**——PI-Desktop 的插件进程没有重启宿主的通道，装完工具若未生效只能提示手动重启。这不是实现降级，是宿主能力差异。

## 面板里有什么

页签顺序：**① 环境 → ② SSH → ③ 代码 → ④ 克隆 → ⑤ npm → 总览**

### ① 环境

显示 `git` / `ssh` / `ssh-keygen` / `gh` 的**实际解析结果**、版本、解析方式。

插件进程拿不到宿主环境变量（`process.env.PATH` 可能为空），所以按下面顺序解析：

1. 环境变量覆盖：`SCM_GIT` / `SCM_SSH` / `SCM_SSH_KEYGEN` / `SCM_GH`
2. 已知安装位置（Windows：`C:\Program Files\Git\cmd\git.exe`、`C:\Windows\System32\OpenSSH\ssh.exe`、`C:\Program Files\GitHub CLI\gh.exe` 等；POSIX：`/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin`）
3. **Windows 注册表**：`HKLM\SOFTWARE\GitForWindows` 的 `InstallPath`、`App Paths\git.exe` / `gh.exe`（本机 git 就在 `E:\Git`，只靠第 2 步会误报缺失）
4. PATH
5. 裸命令名

面板显示解析方式（`registry` / `known-location` / `PATH` / `env:SCM_*`），找不到就写「缺失」。

**缺工具可直接装、可检查更新**（不降级：真跑安装器）：

- 缺失的工具行出现「安装」：Windows 的 `gh` 走镜像下载官方 msi + `msiexec /qn` 静默安装（可选 `gh-proxy.com` / `ghfast.top` / `ghproxy.net` / 官网）、`git` 走 `winget install Git.Git`、`ssh` 走 `Add-WindowsCapability`；macOS 走 brew / xcode-select；Linux 走 apt/dnf/pacman
- 已装的 `git` / `gh` 有「检查更新」：gh 对比 Releases，git 对比官方 tags 并过滤预发布/RC；Linux 的 git 不做对比（否则永远误报）
- 安装是 job + 轮询（面板通道 30s 超时，装软件不止 30s），日志实时回显，装完清除解析缓存重新检查

### ② SSH 密钥与连接

- **探测已有密钥**：扫 `~/.ssh/*.pub`，**按平台**挑（名字带 `github`/`gitee` 优先，其次 `id_ed25519`，最后字母序）
- **生成 ed25519 密钥**：无密码；同名已存在时复用，不覆盖
- **写入 SSH 配置**：改 `~/.ssh/config` 里对应的 `Host` 块
  - 端口 **443**（GitHub 写 `ssh.github.com:443`）或 **22**（标准 `github.com:22`）；初始值取该平台现有配置，两平台互不影响
  - 就地改写：只改 `HostName` / `User` / `IdentityFile` / `Port`；缺的键补在块尾；键序、缩进、块内注释、其它 `Host` 全部保留
  - **`IdentityFile` 默认原样保留**，除非在密钥下拉里显式选了另一把
  - 保留文件自身换行符（CRLF 不会被改成 LF）；改写前先备份 `config.bak-<时间戳>`；结果 chmod 0600
- **测试连接**：有配置块时连**别名** `git@github.com`（不带 `-p`/`-i`，完全交给 config）——这正是 git 实际走的路径；只有面板端口与配置不一致时才直连。判定看输出而不是退出码（GitHub 认证成功也返回 1）

### ③ 代码管理

- **仓库总览**：分支、远程、领先/落后、改动分类（已暂存 / 未暂存 / 未跟踪）
- **暂存与提交**：逐文件与全量「暂存 / 取消暂存」、自定义提交信息；空暂存区与缺身份都给人话提示
- **差异**：单文件 diff（未跟踪文件按「全文新增」）、任意提交的 diff
- **分支**：列出并把当前分支列在最前，可切换（切前确认）
- **同步**：推送 / 拉取（`--ff-only`）/ 合并推送（`pull --rebase` + push）/ **推送暂存**（只提交已暂存内容）/ 强制推送 / 强制拉取 / **对齐远程**（`fetch` + `reset --hard origin/<branch>`）
  - 强制推、强制拉、对齐都要求显式确认；冲突时保持原状、不自动继续
  - 远程操作自动注入 `GIT_SSH` 指向系统 OpenSSH（规避 Windows 上 Git 自带 MSYS ssh 的 `signal pipe` 报错）
- **建库**：仅 `git init`（不拉不推，回报是否已配提交身份）；**新建远程仓库并推送**（GitHub `gh repo create --source=. --push`；Gitee OpenAPI 建仓 → 设 SSH 远程 → push；同名已存在直接拒绝；空目录先做初始提交）；**改可见性**
- **大文件治理**：列出超阈值（默认 100MB）的改动文件，一键写 `.gitignore`（一级子目录忽略整块、根目录文件只忽略自己、去重、保留换行符）；用 `--untracked-files=all` 逐文件列出，否则新目录里的大文件会漏
- **revert / cherry-pick**：从最近提交里选一条，先弹确认
- **目录记忆**：工作区 / 自定义目录下拉；「移除」只删记录不删文件夹
- **本地仓库扫描**：见「总览」

路径与名字都有白名单：文件路径拒绝绝对路径与 `..`，分支名拒绝 `-f` 与 `a..b`，仓库名只允许 `[A-Za-z0-9._-]`。

### ④ 克隆仓库

- **平台切换**：GitHub 走 `gh repo list`；Gitee 走 OpenAPI（私人访问令牌）
- **Gitee 令牌**：只显示在 Gitee 模式下；0600 存**插件数据目录**；保存前调 `/user` 校验；可一键清除
- **本地已有判定**：克隆父目录 / 当前项目根 / HOME，**以及「总览」扫描到的本地仓库**（仓库不在克隆目录里也能认出来）
- **按地址克隆**：粘 `https://` 或 `git@host:path`，从末段推导目录名
- **克隆进度**：job + 轮询（通道 30s 超时，克隆可能几分钟）

### ⑤ npm 发布向导

- 目录默认留空（不用工作区兜底，避免发错）；支持「重新检查 / 预览打包 / 发布」
- 状态行显示 registry、登录账号、包名@版本；全局是镜像源时提示「发布仍走官方源」
- **登录与发布固定 `registry.npmjs.org`**：即使全局配了 npmmirror，`whoami` / `login` / `publish` 都带 `--registry`
- **`npm login` 在真实终端里跑**（起一个可见控制台），密码由 npm 自己的 TTY 处理
- **npm 调用优先 `node + npm-cli.js`**：Windows 上 `.cmd` 不能被 Node 直接 spawn（`EINVAL`）
- `npm config list` 里的 `_authToken` / `_password` / `_auth` 一律抹成 `******`
- 发布前必须勾选确认，发布走 job + 轮询

### 总览：把散落各处的本地仓库汇总成一张表

- 每个仓库显示：路径、分支、改动数、领先/落后、最后提交（日期 + 作者 + 标题）、远程，以及**可能来自哪个 agent**（按路径/远程关键词提示，不下结论）
- **同一远程的多个本地副本会成组标出**（ssh / https / `.git` / 大小写差异都算同一远程）
- 扫描根：当前项目 / 克隆目录 / 已登记目录 / 常见代码目录 / **盘根（C: D: E: F: G:，下探 2 层）** / **各 agent 登记的工作区**（DSH 记在 `~/.dsh/storages/workspace.json`）
  - 这一条是为 `D:\文档\deepseek-harness\default-workspace\dsh-mainline` 这类「离盘根 4 层」的仓库加的
  - 系统目录（`Windows` / `AppData` / `Program Files` / `node_modules` / `dist`…）跳过；每根 1.5s / 4000 目录预算
  - 可**手动加扫描根**（存 `roots.json`，0600），加完立刻重扫
- 每行「用这个」直接设为 ③ 的当前仓库
- 性能：分支与远程直接读 `.git/HEAD` / `.git/config`（不 fork git），只有 `status` 与 `log -1` 各一次，并发 5

## Agent 工具

注册两个工具，权限 `agent.tool.register`（高风险，加载时要你批准）：

| 工具 | 能做什么 |
|---|---|
| `GitRepo` | 读：`status` / `diff` / `log` / `branches` / `bigFiles`（只读动作在 Plan / Goal 模式也放行）<br>写：`stage` / `unstage` / `commit` / `checkout` / `push` / `pull` / `mergePush` / `pushStaged` / `init` / `createRepo` / `setVisibility` / `revert` / `cherryPick` / `ignoreBig`<br>危险：`align` / `forcePush` / `forcePull` —— 必须 `confirm: true`，且工具会要求先问用户 |
| `GitIndex` | `list`（汇总本机仓库，含重复副本）/ `clone`（克隆并等到完成，最多 100s） |

- `dir` 省略时用**面板上次操作的仓库**（`prefs.lastRepo`）
- 返回结果做了瘦身（status 只给判断字段、diff 截 12k）
- `confirm: true` 只是一道闸，模型自己就能填；**真正可靠的是你在对话里过目后再让它写**

## 安全边界

| 项 | 做法 |
|---|---|
| 外部命令 | `execFile` + 参数数组 + 显式 `cwd`，**从不用 shell 拼字符串** |
| 写用户文件 | 只有 `~/.ssh/config`（按按钮时、先备份、就地改写、0600）与仓库内的 `.gitignore` |
| SSH 密钥 | 只在 `~/.ssh` 内生成；`keyName` 校验 `^[A-Za-z0-9._-]{1,64}$` |
| 克隆地址 | 只接受 `https?://` / `ssh://` / `git@host:path`，拒绝 shell 元字符 |
| 克隆目标 | 父目录必须是存在的绝对路径；目标已存在直接拒绝 |
| 建库 | 只走 `installPlan` / 固定命令表，不接受外部拼进来的命令；提权走 `Start-Process -Verb RunAs`（会弹 UAC） |
| npm | 登录由终端 TTY 完成，插件不接触密码；凭据先抹再显示；发布前必须勾选 |
| 网络 | 只有 Gitee OpenAPI（`gitee.com`）、GitHub API（版本查询）、你按按钮触发的 npm / gh |
| 面板 | 用户可见文本走 `textContent` / `createElement`，不拼 `innerHTML`；CSP `default-src 'none'` |

**已知的诚实边界**：PI-Desktop 的权限网关管不到插件进程内的 Node 调用（官方文档明说插件进程还不是 OS 能力沙箱）。所以「不写别处的文件」是靠上面这些约束和自己写的路径检查保证的，不是宿主强制。请只从可信来源安装本插件。

## 安装

全局插件目录：`%USERPROFILE%\.pi-desktop\plugins\installed\local.source-code-mgmt`

在插件页从文件夹加载该目录（目录型插件热重载）。权限会问你三项：`ui.view`、`fs.read`（仅目录选择器）、`agent.tool.register`（agent 工具）。**新增或扩大权限需要重新加载并重新批准**。

## 开发与验证

```bash
# 纯函数：SSH config 改写、URL 校验、判定、git 输出解析、安装计划、npm 脱敏（42 项）
node tests/helpers.test.mjs

# SSH 端到端：临时 HOME 里真跑 onLoad + 面板通道（21 项，不碰你真实的 ~/.ssh/config）
node tests/write-config-e2e.test.mjs

# ③ 代码管理：真实 git 仓库 + 本地裸远程 + 扫描 + 总览 + agent 工具（45 项）
node tests/repo.test.mjs

# 加载契约：按宿主真实校验规则核清单 + 入口导出 + 通道 + 钩子超时（15 项）
node tests/load-contract.test.mjs
```

合计 **123 项断言**，全部在临时目录里跑、不联网、不碰你的真实仓库。

注：`repo.test.mjs` 也会把 `USERPROFILE` / `HOME` 指向临时目录——**必须调 `onLoad()`**，否则 `dataPath` 为 null，偏好与扫描根根本落不了盘（踩过）。

## 与 DSH 原版的对应关系

| DSH 原版 | 这里 |
|---|---|
| 40 条 `/api/source-code-mgmt/*` 路由（`ctx.webServer.register`） | `onPanelInvoke` 的 56 条通道（`scm.*`） |
| `ctx.get('slots')` + 三分支入口 | `contributes.views` 一个视图（PI-Desktop 没有「打开工作面板标签页」的 API） |
| 同步返回的 `/clone/run` | `scm.clone.run` 起任务 + `scm.clone.status` 轮询（避开 30s 通道超时） |
| ①③⑤ 板块 | 全部移植（见上） |
| — | **额外**：总览页（本地仓库汇总 + 重复远程）、`GitRepo` / `GitIndex` agent 工具 |

## 已知限制

- **一键重启宿主**做不到（宿主能力差异，非实现降级）
- ⑤ 的 `npm login` 只在 Windows 起终端；Linux/macOS 返回可复制的命令
- 建库 / 改可见性需要平台账号（`gh` 登录或 Gitee 令牌），**没有自动化测试**：只测了仓库名校验与「同名已存在就拒绝」的守卫
- 本地仓库扫描是启发式的（盘根 2 层 + agent 工作区 + 手动根）；更深的路径请手动加扫描根
- 多密钥场景只能按平台挑一把并在下拉里显式换，没有「给某平台另存新名字」的向导

## 许可与出处

- 本移植版代码：**MIT**（见 `LICENSE`）
- 功能规格与设计来自上游 DSH 插件：**Zhucy123/source-code-mgmt**（`https://github.com/Zhucy123/source-code-mgmt`），其 `package.json` 与 README 声明为 **MIT**
  - 上游**没有 LICENSE 文件、没有 author 字段**，README 的 License 段只写 "MIT"
  - 按 MIT 要求保留版权与许可声明；上游未给署名行，因此以「项目 + 仓库 + 其声明的 MIT + 许可全文」的形式保留，详见 `THIRD-PARTY-NOTICES.md`
- 实现方式是**为 PI-Desktop 插件 API 重写**（DSH 的 40 条 HTTP 路由 → 本插件的通道表；面板 UI 从零编写），未复制上游源码文件
- 本移植版与上游作者**无从属关系**，不代表其认可

## 变更记录（摘要）

- **0.9.0** `GitRepo` / `GitIndex` agent 工具；权限加 `agent.tool.register`；`prefs.lastRepo`
- **0.8.0** 修「`D:\文档\deepseek-harness\default-workspace\dsh-mainline` 扫不到」：读 DSH 的 `workspace.json` 把工作区当扫描根；新增手动扫描根（仓库 6 → 10）
- **0.7.0** 总览页：汇总本机仓库、同一远程多副本标记、agent 关键词提示
- **0.6.0** 本地仓库扫描（盘根 2 层）；修页签顺序为 ①②③④⑤
- **0.5.0** 补齐 ③：暂存/提交/分支/diff/同步（push/pull/合并/强制/对齐/推送暂存）/建库/可见性/目录记忆
- **0.4.0** 补齐 ① 一键安装与检查更新、⑤ npm 向导（真跑安装器与 npm，不降级）
- **0.3.0** ③ 大文件治理 + revert / cherry-pick
- **0.2.1** 修「测试连接」：改连别名让 `~/.ssh/config` 生效；补 `ProgramData` 等子进程环境
- **0.2.0** 密钥与端口按平台分开（原来一个全局值会给 GitHub 选到 gitee 的钥匙）
- **0.1.1** 修 ssh 版本行显示 `Command failed`
- **0.1.0** ②④ 首版
