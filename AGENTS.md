# AGENTS.md — 给后续 agent / 开发者的仓库约束

> 本仓库是 DSH（DeepSeek Harness）插件 **`dsh-low-integrity-check`** 的源码：在右侧栏检查并清除 Windows 工作区目录上的 **Low 完整性标签**（`S-1-16-4096`）。
>
> - 当前状态、验证数字与待办：见 [docs/HANDOFF.md](docs/HANDOFF.md)。
> - 关键设计取舍与理由：见 [docs/DECISIONS.md](docs/DECISIONS.md)。
> - 面向用户的安装与功能说明：见 [README.md](README.md)。
>
> 本文最后核对：**2026-11-06（Asia/Shanghai）**。性能优化「阶段 1/2/3」均已完成（阶段 2/3 的节点见 [docs/HANDOFF.md](docs/HANDOFF.md)）；**deep 端到端与真机 UI 待 DSH 重启后验证**（Host JS / client.js 改动需重启生效）。HANDOFF 里的数字带阶段口径，引用时务必保留阶段与日期。

---

## 1. 项目定位与边界

| 项 | 内容 |
|---|---|
| 插件包名 / DSH 插件 id | `dsh-low-integrity-check`（见 `package.json` 的 `name`、`index.js` 的 `export const name`） |
| 仓库目录 / GitHub 仓库名 | `dsh-file-integrity-check`（历史命名，与插件 id 不同，见 [DECISIONS.md](docs/DECISIONS.md) D8） |
| 平台 | 仅 Windows 10 / 11。Host 路由对非 `win32` 返回 `unsupported-platform`，面板显示只读提示 |
| DSH 版本 | 目标 DSH Desktop 0.2.x；开发与验收使用 **0.2.2-rc.1**。README 声明 `≥ 0.2.1`，但 0.2.1 未单独实测；0.3+ 未验证 |
| 运行时依赖 | **零第三方 npm 运行时依赖**。Host 只用 Node 内置模块；浏览器侧只用 DSH 注入的 `react` |
| 管理权限 | 普通用户即可处理「自己是 owner」的对象；非 owner 对象会逐条失败并建议用管理员 PowerShell 重试 |
| 明确非目标 | 不改变 DSH 沙箱行为；不保证 Low 标签不再复发；本期不处理 `S-1-4-*` / Everyone 拒绝 ACE；不碰文件内容；不做全盘扫描；本期无独立 CLI |
| 数据目录 | `%DSH_HOME%\low-integrity-check\`（默认 `C:\Users\<user>\.dsh\low-integrity-check\`），含 `reports\`（引擎直写扫描报告）、`snapshots\`、`exports\`（旧版导出后备）、`logs\` |

功能闭环（已实现）：右侧栏 **解析工作区 → 扫描（默认 quick；可切 deep） → 聚合与清单查看（分页/复制） → 导出（返回引擎报告路径） → 一键清除（确认条） → 复扫验证 → 失败日志**；运行中显示速率/ETA。

---

## 2. 技术约束（改代码前必须遵守）

| # | 约束 | 具体要求与原因 |
|---|---|---|
| C1 | **DSH 0.2.x / 内部服务无公开契约** | 只通过 DSH 提供的能力工作；`workspaceRegistry`、`agents`、`sidebarRightTabs`、`sidebarRight` 都是内部服务，**必须软取并降级**，不能假定其长期存在或 API 稳定。升级 DSH 后先跑 `/health`、`/diagnostics` 与真机面板冒烟 |
| C2 | **Windows PowerShell 5.1 兼容** | `engine/integrity.ps1`、`test/run-fixtures.ps1` 必须在系统自带 PS 5.1 上运行：不用三元运算符、`??`、PS7 专属语法；字符串按 ANSI/ASCII 处理中文（fixture 用码点构造中文名）。Host 优先解析 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，并用 `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass` 启动。pwsh 7 只用于 parity 测试，不是运行目标 |
| C3 | **无第三方运行时依赖、无构建步骤** | 不新增 npm `dependencies`；不引入打包器/转译器。`client.js` 由 DSH 直接从磁盘加载，`engine/integrity.ps1` 每次任务重新读取；仓库克隆后可安装、可运行 |
| C4 | **client.js 是纯 JS 脚本，不是 ESM** | 整文件包在 IIFE 中，通过 `window.__ModuleLoader__.load({ id, factory })` 注册；factory 内**只 `require('react')`**；返回 `{ name, inject: ['slots', 'locale'], apply }`；**不写 JSX、不用 `import`/`export`、不 require 任何 `@deepseek-ai/*` 包**。`apply` 内任何一步失败只能降级 + `console.error/warn`，绝不抛错（否则可能影响整个 Web 页面） |
| C5 | **样式只用平台 token** | 样式通过自注入 `<style>`（引用计数清理）实现，class 统一 `.fi-` 前缀；**颜色只取 `--dsw-alias-*` token**（字体等用 `--dsw-font-*`），不得硬编码 hex/rgb。当前源码无任何硬编码颜色 |
| C6 | **Host 服务软取** | `index.js` 的硬依赖只有 `inject = ['webServer']`；`lib/runtime.js` 用 `optionalService()`（内部 `ctx.get` + try/catch）软取 `workspaceRegistry` / `agents`；缺失时功能降级而不是崩溃。客户端同理软取右侧栏服务（见坑 K4） |
| C7 | **HTTP 面最小且同源** | 只注册前缀 `/dsh-low-integrity-check`；同源校验基于请求的 `Origin` 与 `Host`；POST 必须是 `application/json`，请求体是 JSON 对象且 ≤ 256 KiB；**客户端只传 sessionId，绝不传目标文件系统路径**。错误响应统一 `{ ok:false, code, message }` |
| C8 | **路径安全在 Host 侧完成** | `lib/paths.js` 负责：registry 解析 → `fs.realpath` 规范化 → 黑名单校验（盘根、用户主目录、桌面/文档/下载等宽泛目录、DSH 数据目录、DSH 安装目录）→ 必须是已注册工作区的规范化路径。`workspacePath` 提示只经 `registry.resolveByPath` 使用，**不能作为扫描目标** |
| C9 | **引擎协议是 stdout 上的 JSON Lines** | 事件类型固定：`env` / `progress` / `hit` / `error` / `result` / `fatal`；stdout 只允许协议行（UTF-8 无 BOM），诊断信息走 stderr 或丢弃；退出码：`0` 成功（Scan 无命中 / Repair 无剩余与失败）、`2` 有命中或修复后仍有 Low/失败、`3` 致命错误。`-Json` 只是 Host 兼容参数，输出始终是 JSON Lines。**Scan 结束时引擎直写 `<DataDir>\reports\scan-<timestamp>.json`，`result.reportPath` 指向它；报告写入失败只发 `error` 事件并令 `reportPath` 为空，Scan 本身不失败**（导出退回 Host 序列化 `job.items`） |
| C10 | **Repair 只改命中对象** | 先扫描并流式输出命中；有命中时**先写快照 JSON + `restore-*.ps1`** 再改标签；修复顺序：显式 Low 目录（深度升序）→ 显式 Low 文件 → 复扫剩余对象兜底；每个对象改完立即复读验证；非命中对象的 DACL/标签不得变化。标签写入优先走进程内 C# `SetNamedSecurityInfoW`，失败才回退 icacls（见 K2/K14） |
| C11 | **临时授权必须可验证地还原** | 对象 DACL 不授予 `WRITE_OWNER` 时，先走**进程内 native 临时授权**（C# 读 DACL → 插入当前用户 `WRITE_OWNER` allow ACE → 设标签 → 还原原 DACL），失败才回退旧 `icacls /grant *<sid>:(WO)` → `finally /remove:g`；两种情况都必须**复读 DACL 与授权前逐字符比较**，不一致按失败处理并记录前后值。该降级只在「当前用户是对象 owner」时执行 |
| C12 | **DataDir 放在工作区之外** | Host 传 `%DSH_HOME%\low-integrity-check`。引擎会对「落在 `-Root` 内的 `-DataDir`」做遍历排除作为防御，但**不要依赖这个防御**：快照/报告本身不应进入扫描面，也不应把 DataDir 指到用户工作区内部 |
| C13 | **文档与数字口径** | 中文文档。README 面向用户；HANDOFF 记录状态/验证边界；DECISIONS 记录已落地取舍。**任何性能/验收数字必须注明阶段（优化前/阶段 1/…）与日期**；未跑过的项写成「未验证」，不得推定。阶段验收后同步更新 README 的测试数、夹具 PASS 数、性能数字 |

---

## 3. 目录与职责

| 文件 | 职责 | 改动注意 |
|---|---|---|
| `index.js` | Host 入口（Cordis 插件），`inject=['webServer']`，调用 `createRuntime` | 不要在这里塞业务逻辑 |
| `lib/runtime.js` | 组装 runtime：版本、DataDir、JobManager、引擎 Env 探测（缓存 60s / 超时 20s）、注册 HTTP 路由、卸载清理 | 内部服务软取都在这层 |
| `lib/routes.js` | HTTP API：`/health`、`/diagnostics`、`/workspace`、`/jobs`（scan 接受 `depth`）、`/jobs/:id[/items|cancel|export|log]`；同源、JSON、方法校验 | 不信任客户端路径；错误码与客户端 `KNOWN_ERROR_CODES` 对齐 |
| `lib/paths.js` | 工作区解析（sessionId → registry，hint 仅 `resolveByPath`）、realpath、路径黑名单、`countLiveAgents` | 纯函数有单测，改规则必须补/改 `test/paths.test.mjs` |
| `lib/jobs.js` | 任务状态机：同工作区互斥、事件累积、30 分钟硬超时、5 分钟无进度看门狗、取消、15 分钟 TTL、分页 items、导出、失败日志；快照字段含 `depth`/`itemsScope`/`engine`/`reportPath`；导出优先返回引擎 `reportPath`，旧任务回退 Host 写 `exports\` | `LIMITS` 是 Host 内存上限真源；result 事件覆盖流式计数 |
| `lib/engine.js` | 定位 Windows PowerShell、`engineInvocation()` 拼 argv、spawn 隐藏窗口进程、解析 JSON Lines、stderr 截断（64 KiB）、kill（1.5s 后 taskkill `/T /F` 兜底） | 参数转发（含 `scanDepth`）集中在 `engineInvocation()`，有单测；新增参数时同步改 `engineInvocation()` / `engineArgs()` 并补 `test/engine.test.mjs` |
| `client.js` | 浏览器侧右侧栏面板：扫描（默认 quick，可切 deep）、聚合展示（N/X 显式/Y 继承）、清单分页、导出（显示 reportPath）、一键清除、轮询、速率+ETA、日志、sessionStorage 任务恢复、zh/en 文案、样式注入、右侧栏软注册 | 纯 JS / 无 JSX / 不改 Host 契约；`ROUTE_SEGMENT` 必须与 Host `PREFIX` 一致 |
| `engine/integrity.ps1` | Env / Scan / Repair 引擎；quick 用内嵌 C# 扫描器；Scan 直写报告文件；Repair 走 C# native 快路径 + 进程内 grant + icacls 错误兜底 | 5.1 语法；stdout 协议洁净；Repair 语义不能变；改后跑夹具 |
| `test/run-fixtures.ps1` | 引擎夹具验收：能力探测决定 FULL/SANDBOX，覆盖 Env/Scan/Repair、长路径/中文、junction、SkipDirs、quick/deep、报告文件、native/grant 修复快路径、3000 文件吞吐 INFO、DataDir 排除、PS7 parity | 夹具只允许写 `%TEMP%\dsh-low-integrity-tests\<runId>` |
| `test/*.test.mjs` | Node 单测（目前 36 项：paths 15 / jobs 11 / engine 6 / routes 4） | 只测纯逻辑/HTTP 面；真实标签写入靠夹具 |
| `locale/{zh,en}.json` | 插件管理器展示文案（title/description） | 面板内文案在 `client.js` 字典里 |
| `package.json` | 包身份、`dsh.bundle.patch`、`dsh.client`（platform web / immediately / inject 右侧栏 UI 包）、exports、scripts | `dsh.client.inject` 是平台注入声明，**不要**据此在 JS 里 require 平台包 |
| `cordis.patch.yml` | 把插件插入 profile 树的 patch | 只需一个 `insert` 行；客户端半侧由 `dsh.client` 发现 |

---

## 4. 测试与验收命令

### 4.1 语法检查与 Node 单测

```powershell
# 7 个 JS 文件的语法检查（与 package.json 的 check 一致）
npm run check

# 四个 Node 测试文件（package.json 的 test 就是按顺序逐文件执行）
npm test

# 沙箱内推荐显式逐文件跑（与 npm test 等价，便于定位）
node test/paths.test.mjs
node test/jobs.test.mjs
node test/engine.test.mjs
node test/routes.test.mjs
```

必须逐文件跑的原因：**DSH 工具进程处于 Low 完整性沙箱，`node --test` 默认会 spawn 子进程，在沙箱里会 `EPERM`**。`package.json` 的 `test` 脚本已经是 `node test/xxx.test.mjs && ...` 的链式写法，没有使用 `node --test`；不要改成 `node --test`。

这些单测使用 fake engine / fake registry / 本地临时 HTTP server，**不会写真实完整性标签**；`routes.test.mjs` 会在本机回环端口起临时服务。

### 4.2 引擎夹具（真实验签写入，必须在 DSH 工具沙箱外跑）

```powershell
# FULL / SANDBOX 由脚本自动探测；普通用户会话通常得到 FULL
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\run-fixtures.ps1

# 保留夹具目录（打印路径，便于排查）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\run-fixtures.ps1 -Keep

# 指定引擎宿主（例如 pwsh 7）或长路径参数
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\run-fixtures.ps1 -EngineHost C:\Program Files\PowerShell\7\pwsh.exe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\run-fixtures.ps1 -LongPathSegments 8 -LongPathSegmentLength 40
```

要点：

- 脚本先在 `capability-probe` 上尝试 `icacls /setintegritylevel Medium`：
  - 可写 → **FULL**：clean、显式 Low、继承 Low、Repair 成功、restore 回滚、E1 传播实验、临时授权降级、DataDir 排除等；
  - 不可写 → **SANDBOX**：只跑不需要写标签的子集，需要写标签的用例记为 **SKIP**（SKIP 是预期，不是失败）。
- 两种模式都会跑 **quick（`-ScanDepth quick`，内嵌 C# 扫描器）** 用例：quick 只流式输出**显式** Low 命中、result 计数包含全部 Low；quick/deep 的计数与显式集合必须一致；另有 2000 文件夹具记录 quick vs deep 计时（INFO + 软断言）。**每个 Scan 都会写 `<DataDir>\reports\scan-*.json`**，夹具断言 `reportPath` 存在、报告计数与 result 一致、`itemsScope` 为 quick=`explicit` / deep=`all`、item 字段齐全（`path/relativePath/kind/explicit/label`）。
- FULL 还覆盖 **native / grant 修复快路径**（普通对象走 `methods.native`；DACL 缺 `WRITE_OWNER` 的对象走进程内 `methods.grant`，DACL 逐字符还原；3000 个 grant 文件记录 `repair-fast-path-throughput` INFO）。
- 引擎默认用 Windows PowerShell 5.1；`-EngineHost` 可换宿主；脚本会额外跑 pwsh 7 的 Env/quick parity（存在 pwsh 时）。
- 退出码：`0` = 无 FAIL（SKIP/INFO 允许），`1` = 至少一个 FAIL。最终验收（阶段 2，2026-11-06）FULL 为 **PASS=184 / FAIL=0 / SKIP=1 / INFO=6**；SANDBOX（PS 5.1 与 pwsh 7 双宿主）为 **PASS=140 / FAIL=0 / SKIP=8**；数字与口径见 [HANDOFF.md](docs/HANDOFF.md)。
- 夹具只写 `%TEMP%\dsh-low-integrity-tests\<runId>` 并在 finally 清理；**不要**把 `-Root` 指向用户真实工作区做 Repair。

### 4.3 直接调用引擎（调试/基准）

```powershell
# 环境自检（Host 的 /health 也用 Env 探测）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\engine\integrity.ps1 -Mode Env -Json

# 快速扫描（默认 quick；只输出显式 Low 的 hit 行）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\engine\integrity.ps1 -Mode Scan -Root D:\some\workspace -ScanDepth quick -Json

# 深度扫描（旧 PowerShell 全量行为；每条 Low 都有 hit 行）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\engine\integrity.ps1 -Mode Scan -Root D:\some\workspace -ScanDepth deep -Json

# 修复（必须能写标签；DataDir 放工作区外；先确认扫描命中符合预期）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\engine\integrity.ps1 -Mode Repair -Root D:\some\workspace -DataDir C:\Users\<user>\.dsh\low-integrity-check -Json
```

调试时注意：`-Mode Scan` 会在 `-DataDir` 下写 `reports\scan-*.json`（缺省 `%TEMP%\dsh-file-integrity-check`），`result.reportPath` 指向它；`-Mode Repair` 会真实修改命中对象的标签并写快照，先在夹具或副本上验证；Host 会显式传自己的数据目录。

### 4.4 真机安装 / 面板冒烟

```powershell
# 1) 让 DSH 以本地目录安装 bundle（在 DSH 的 agent 里执行，或使用插件管理器本地安装入口）
plugin_manager install_bundle  D:\path\to\dsh-file-integrity-check
# 2) 重启 DSH（Host JS / client.js 是加载时读取的），右侧栏「指南」出现「完整性检查」入口
# 3) 面板流程：开始扫描（quick 默认）→ 查看聚合（N / X 显式 / Y 继承）→ 导出 → 勾选「深度扫描」再扫 → 观察速率/ETA → 一键清除（确认条）→ 结果/复扫 → 生成日志
```

- **Host JS（`index.js`、`lib/*.js`）与 `client.js` 改动后必须重启 DSH**；这是本轮 deep 端到端与真机 UI 验证的前置条件；
- **`engine/integrity.ps1` 每次任务都会重新读取，改完无需重启**（重启也不影响）。
- 面板排障先看 `GET /dsh-low-integrity-check/health` 与 `/diagnostics`（服务状态、registry、引擎探测、DataDir、enginePath）。
- 真机验证请使用测试工作区或用户明确授权的工作区；不要在真实工作区上试 Repair。
- 当前「已验证/未验证」边界（DSH 版本、deep 端到端、Host 自动化集成、UNC/不可读等）以 HANDOFF 为准。

### 4.5 阶段验收清单（宣称「完成」前逐项核对）

- [ ] `npm run check` 通过；4 个 Node 测试文件全绿（当前 36 项）
- [ ] 夹具按环境跑对模式：FULL 或 SANDBOX，**FAIL=0**；FULL 必须在 DSH 工具沙箱外的普通用户会话执行
- [ ] 涉及引擎：quick/deep 计数一致；Scan 的 `result.reportPath` 指向真实报告文件且计数/`itemsScope`/item 字段正确；Repair 后复扫 0 命中；`methods.native`/`methods.grant` 生效且 DACL 还原一致；快照/restore 脚本可解析；非命中对象 SDDL 抽样不变
- [ ] 涉及 Host/UI：真机重启后面板闭环走通；quick 聚合 / deep 开关（POST `depth:'deep'`）/ 速率+ETA / 导出显示 reportPath / 800ms 轮询、取消、日志路径可用
- [ ] 新数字带阶段与日期写入 HANDOFF；保持 README 与 HANDOFF 的验收数字一致（README 由 Lead 维护）
- [ ] 没有把未验证项写成已验证；没有在用户真实工作区留下测试改动

---

## 5. 已知坑（K1–K14）

### K1. 完整性标签的继承传播不可靠

修复父级目录的 Low 标签后，子项**可能仍是继承 Low**（Windows 不保证向下刷新）。因此：

- 引擎 Repair 不依赖「修父级后子项自动恢复」，而是在显式目录/文件修复后**复扫全部剩余对象并逐个兜底修复**；
- 夹具里有 E1 传播实验，只记录/断言实际结果，不假设传播一定发生；
- 文档和 UI 里只能写「继承项可能随父级恢复」，不能承诺自动恢复。

### K2. 子项常缺 `WRITE_OWNER`，需要临时授权降级

DSH 沙箱创建的对象，其 DACL 经常不授予当前用户 `WRITE_OWNER`，直接设置标签会 Access denied。引擎的降级路径（阶段 2 起）：

1. 先尝试进程内 C# `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)`（普通路径，记 `methods.native`）；
2. 若失败且 Win32 错误为 5（Access denied），且**当前用户是对象 owner**：C# 读原始 DACL SDDL → 插入当前用户 `WRITE_OWNER` allow ACE → 设置标签 → 还原原 DACL；成功后记 `methods.grant`；
3. 还原后**复读 DACL，必须与原始 SDDL 逐字符一致**；不一致按失败处理并记录前后值；
4. 以上进程内路径失败时才回退旧 `icacls` 逻辑（含 `icacls /grant *<sid>:(WO)` → `finally /remove:g`），主要用于拿到可读错误文本。

日志里能看到 `methods.grant`、`methods.native`、`temporary WRITE_OWNER grant used and DACL restored` 等记录。不要删掉 DACL 校验，也不要把它降级为「尽力而为」。

### K3. DataDir 必须在工作区外

Host 的数据目录是 `%DSH_HOME%\low-integrity-check`。引擎对「DataDir 位于 Root 内」有防御性排除，但这是兜底不是契约：

- 修复过程中写出的快照/日志/导出不应进入扫描面；
- 不要把 `-DataDir` 指到工作区内部或用户目录；
- 数据目录最终归 DSH 管理；测试/调试用临时目录时也要放工作区外。

### K4. `sidebarRightTabs` / `sidebarRight` 是内部服务，没有公开文档

客户端注册依赖这两个服务，但它们是 DSH 内部实现、API 可能变化。约定：

- 只能 `ctx.get(...)` 软取 + `try/catch`；
- 服务未就绪时有界重试（**20 × 250ms**），超时只 `console.warn`，不抛错、不影响页面其他部分；
- 注册正文插槽用 `ctx.slots.inject('sidebar.right.pane.tab', function* () { yield ctx.slots.register(...) })`；
- 服务晚到时主动 `openTab('low-integrity')` 让入口可见；
- `tab` 的 `priority: 'extension'`、`guide.order: 300` 是给右侧栏展示用的，不要和内置类型抢位置。

### K5. Host JS 改动需重启 DSH；引擎脚本每次任务重读

- `index.js`、`lib/*.js`、`client.js`（及其打包产物/加载缓存）是 DSH 启动/加载时读取的，**改完必须重启 DSH 才能生效**；
- `engine/integrity.ps1` 是由 Host 每次任务新 spawn 的 PowerShell 读取的，**改完立即生效，不需要重启**；
- 因此「引擎改了但 UI 没反应」通常要查 Host 传参/事件字段，而不是重启引擎。

### K6. DSH 工具进程是 Low 完整性，改标签必须由 Host 派生沙箱外 PowerShell

在 DSH 的工具 shell 里直接跑 `icacls /setintegritylevel Medium` 会因 no-write-up 被拒绝（工具进程本身是 Low）。所以：

- 架构上由 **Host（DSH 主进程）`spawn` 隐藏窗口的 `powershell.exe`** 执行引擎，不经过工具沙箱；
- Host 先跑 `-Mode Env` 探测 `canWriteLabel`；为 false 时 Repair 直接 `engine-sandboxed` 拒绝，面板禁用清除；
- 调试引擎时也必须用同样的方式（普通用户会话、沙箱外）；在 DSH 工具里跑 Repair 不能作为有效验证。

### K7. 沙箱内 `node --test` 子进程 spawn 会 EPERM

见 4.1。用 `node test/xxx.test.mjs` 逐文件（`npm test` 已是该形式），不要用 `node --test`。

### K8. `scanDepth` 透传（已修复；UI 已暴露深度开关，deep 端到端待 DSH 重启后真机验证）

链路：`lib/routes.js` 解析 `body.depth`（默认 quick）→ `lib/jobs.js` 保存 `depth` / `itemsScope`，并在 `execute()` 里把 `scanDepth` 传给 `startEngine` → `lib/engine.js` 的 **`engineInvocation(input)`** 统一拼出真实 argv（`command` + `args`），`startEngine()` 直接使用它，因此 `scanDepth` 会落到 `-ScanDepth quick|deep`。客户端「深度扫描（逐文件清单）」复选框会在 `POST /jobs` 里带 `depth:'deep'`。

- 单测 `engineInvocation forwards scan depth to the real argv` 锁定了这条转发；改 argv 组装时优先改 `engineInvocation()` / `engineArgs()`，并跑 `node test/engine.test.mjs`；
- 引擎 `-ScanDepth` 缺省仍是 `quick`，不传 depth 时行为不变；
- **deep 端到端仍待真机验证**：task-5 的 UI 已实现、Host 透传已修复，但 Host JS / client.js 的改动要重启 DSH 才生效；重启后需在真机上验证 deep 清单、导出与 quick 聚合的差异。

### K9. quick 模式的输出语义与面板展示

`-ScanDepth quick`（当前默认）由内嵌 C# 扫描器完成：

- 只把**显式 Low** 对象作为 `hit` 行流式输出；继承 Low 只计数（`inheritedCount`）不输出；
- result 里 `hits` = 全部 Low 数（显式+继承），另有 `explicitCount` / `inheritedCount` / `depth:"quick"` / `engine:"csharp"` / `scanMs`；
- 显式命中上限 5000（超过置 `truncated`）、错误上限 500、进度约每 2000 项或 250ms 一次；
- C# 类型通过 `Add-Type` 懒编译，只有 quick 扫描付编译成本；Env / Repair / deep 不编译；
- 面板已完成对应展示：quick 默认显示「N（X 显式 / Y 继承）」聚合说明、清单只列显式项、继承项给出「可能随父级恢复」的聚合提示；打开「深度扫描」后 `POST depth:'deep'`，清单展示全部命中。**deep 端到端需重启 DSH 后按 HANDOFF 待验证项复核**。

### K10. JSONL 输出必须洁净，编码要小心

- 引擎 stdout 只允许协议行，任何 PowerShell 的格式化/警告/进度输出都可能污染协议；
- 输出统一 UTF-8 无 BOM（自建 `StreamWriter`）；`icacls` 等原生命令的 stdout 按 OEM code page 解码后写入 `output` 字段；
- Host 端逐行解析，非法行被忽略（`onStrayLine` 只用于诊断）；stderr 截断 64 KiB；不要用 stdout 打调试信息。

### K11. 长路径 / 中文 / icacls 兜底

- 内部 Win32 调用与枚举使用 `\\?\` 前缀；icacls 一般用普通路径，必要时才用 `\\?\` 形式；
- icacls 拒绝超长路径/异常时，引擎会回退 `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` 或记录 icacls 输出；阶段 2 起 native 是主路径（覆盖 `\\?\` 长路径），`methods` 里当前主要出现 `native`/`grant`/`icacls`，`pinvoke` 字段保留用于兼容旧日志（当前路径不再单独计数）；
- 中文、空格、>260 字符路径在 FULL 夹具里有覆盖；改路径处理要同时跑 `Test-LongPath` / `Test-LocalizedRoot`。

### K12. Host 内存上限与导出语义

- `lib/jobs.js` 的 `LIMITS`：`MAX_ITEMS=50000`、首屏 200 条、分页最大 500、`MAX_ERRORS=500`、`MAX_FAILED=1000`；超出置 `truncated`，不会无限占内存；
- 引擎 Scan 直写 `<DataDir>\reports\scan-*.json`（最多 `MaxReportItems=50000` 条，超出 `truncated:true`），`result.reportPath` 指向它；Host 在 `snapshot` 里透传 `reportPath`，面板即使不点导出也能提前展示报告路径；
- **导出优先直接返回 `reportPath`**（不再经 Host 二次序列化全量命中）；仅当引擎没给出 `reportPath`（旧任务/报告写失败）时才回退 Host 写 `exports\low-integrity-*.json`；
- deep 模式命中可能远超 Host 内存上限，报告/导出可能被截断；`truncated` 字段必须保留，面板有提示；
- 失败日志最多记录前 500 个失败对象。

### K13. 测试与操作边界

- 夹具只在 `%TEMP%\dsh-low-integrity-tests\<runId>` 创建/清理对象；**不要**在用户真实工作区跑 Repair；大目录只读基准也要先得到授权；
- FULL 夹具会**真实**设置/恢复完整性标签，必须在普通用户会话（非 DSH 沙箱）执行；DSH 工具内跑会进入 SANDBOX 模式并大量 SKIP，不能据此判断引擎失败；
- 写文档/数字时以 HANDOFF 最新验收口径为准，不要复制 README 或历史段落的旧值。

### K14. Repair 的总时长仍由 3 遍 PowerShell deep 扫描主导（下一步优化点）

阶段 2 已经消除逐对象 `icacls` 进程（`methods.native`/`methods.grant`），但 Repair 仍要：① 初始 deep 扫描 → ② 修复后的复扫 → ③ 最终验证遍历。夹具 INFO `repair-fast-path-throughput`（3000 grant + 20 direct，hits=3022）为 repairWallMs≈**37.7s**（perGrantFileMs≈**12.56**，setupMs≈4059），说明瓶颈已从「逐对象进程」转为「多遍 deep 遍历」。后续 P1 计划把 Repair 的扫描也切到 C#；在那之前，十万级工作区的修复总时长不能按「native 每对象设置标签」的速度估算。

quick 扫描本身当前约 **0.31 ms/项**（122,575 项≈38.8s）；后续计划用 `GetSecurityDescriptorSacl` + `GetAce` 直读 ACE 再降（尚未实现，见 HANDOFF P1）。

---

## 6. 安全红线

1. **不信任客户端路径**：新增接口/字段时，目标目录只能来自 registry 解析 + realpath + 黑名单；不要把 `workspacePath` 直接当扫描目标。
2. **不扩大写入面**：Repair 只能改「当前命中集合」的对象；非命中对象的标签/DACL 不得变化；快照必须先于任何修改。
3. **不删 DACL 校验**：临时授权路径必须做授权前后 DACL 逐字符比较；失败要可追溯。
4. **不降低同源/请求约束**：保持同源校验、`application/json`、请求体上限；不要为了调试放宽。
5. **不在 DSH 沙箱内做写标签验证**：写标签/修标签必须由 Host 派生沙箱外 PowerShell 执行。
6. **不擅自发布**：没有明确指令不 `git commit` / `git push`、不安装/升级插件、不改用户 DSH 配置；也不要在真实工作区做破坏性操作。
7. **文档不夸大**：未验证的写「未验证」；性能数字标注阶段与口径（wall / scanMs / 只读 / 旧 deep 对照）；不要把过程数字写成最终发布数字。
