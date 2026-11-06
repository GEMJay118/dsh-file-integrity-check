# DECISIONS — 关键取舍与理由

> 记录已经落地在代码里的设计取舍，供接手人理解「为什么这样做」，避免后续 agent 无意中推翻有理由的约束。
>
> **范围**：截至 **2026-11-06** 的实现。性能优化阶段 1（C# 快速扫描 + 默认 quick）、阶段 2（task-4：引擎直写报告 + C# 修复快路径）、阶段 3（task-5：面板聚合 + 深度开关 + ETA）均已完成并验收；具体状态与数字以 HANDOFF 为准。文末「尚未决策」列出开放问题。
>
> 配套文档：[AGENTS.md](../AGENTS.md)（必须遵守的约束）、[HANDOFF.md](HANDOFF.md)（状态与验证边界）、[README.md](../README.md)（用户向）。

## 索引

| # | 决策 | 一句话理由 |
|---|---|---|
| D1 | 只处理 Low 完整性标签，不处理 `S-1-4` / Everyone 拒绝 ACE | 范围与风险隔离：只改 DSH 写入的标签，不碰用户 ACL |
| D2 | Host 通过 registry 解析工作区，不信任客户端路径 | 清除操作是破坏性的，目标目录必须由服务端权威解析并做黑名单校验 |
| D3 | 同源 HTTP 路由，而不是 remote RPC / 消息通道 | 复用 DSH webServer，浏览器侧零额外传输与鉴权面 |
| D4 | 引擎使用 stdout JSON Lines 流式协议 | 122k 级命中不能整体驻留内存；边扫边报进度、错误可降级 |
| D5 | 放弃 `icacls /T` 全树修改 | `/T` 会波及非命中对象；逐对象修改+验证更安全 |
| D6 | 快照 + `restore-*.ps1`，不做完整 ACL 回滚 | 只恢复标签语义，避免保存/回放任意 ACL 的风险 |
| D7 | 浏览器半侧不依赖任何平台 UI 包 | 只 require React；避免与 DSH 内部包版本耦合 |
| D8 | 包名 `dsh-low-integrity-check` 与仓库目录名不同 | 插件身份以 package name 为准；保留既有仓库/安装路径 |
| D9 | 本期不提供独立 CLI | 收敛到面板闭环；CLI 留到引擎协议稳定后再决定 |
| D10 | 引擎在 DSH 沙箱外由 Host spawn | DSH 工具进程是 Low 完整性，无法写 Medium 标签 |
| D11 | 性能优化选择 C# 下沉 + 默认 quick 模式 | 扫描热路径在 PowerShell 逐对象 P/Invoke，且继承命中淹没输出 |
| D12 | 其它已落地的小决策 | 互斥、超时、上限、轮询、任务恢复、跳过目录等 |
| D14 | 报告文件由引擎直写，导出只传路径 | 避免大清单经 Host 二次序列化/HTTP 传输；报告是完整事实源 |
| D15 | 修复走 native/grant，icacls 降为错误兜底 | 消除逐对象 icacls 进程；失败时仍能得到可读错误文本 |
| D16 | 尚未决策的开放问题 | `S-1-4`、CLI、发布、Config、i18n、Repair 扫描优化等 |

---

## D1. 只处理 Low 完整性标签，不处理 `S-1-4` / Everyone 拒绝 ACE

**背景**：DSH 以 `workspace-write` 打开工作区时会在对象上写可继承的 Low 完整性标签（`S-1-16-4096`，no-write-up）。用户遇到的「无法验证发布者 / 快捷方式白纸 / Electron 崩溃」等症状主要来自这个标签；但某些场景还叠加了 `S-1-4-*`（OWNER RIGHTS 等）或 Everyone 拒绝项。

**决策**：引擎只读取/设置 **LABEL_SECURITY_INFORMATION**，只判定 `ML` ACE 的等级（`LW/ME/HI/SI`）与继承标志（`ID`）；命中清单里的 `sddl` 是标签 SDDL。**不扫描、不修改** `DACL` 中的 `S-1-4` / Everyone 项（临时 `WRITE_OWNER` 授权路径除外——那只是为了让当前用户能写标签，且必须还原）。

**理由**：

- Low 标签是 DSH 沙箱自己写入、可明确定位/验证的对象；`S-1-4` 等待清理项常与用户或其他软件的自定义 ACL 交织，误改会改变文件访问语义；
- 一期目标是解决 DSH 工作区残留标签，不是通用 ACL 修复工具；把范围收窄能让「清除」保持可预期、可复扫验证；
- 现有安全约束（只碰命中对象、快照、逐对象校验）能覆盖标签写入；扩展到任意 ACE 需要另一套风险模型。

**代价 / 边界**：README「已知限制」明确本期不处理 `S-1-4`/Everyone；若症状由这类 ACE 造成，本插件不会修复。这是后续 P1 增强项（HANDOFF P1-1），需要独立任务与独立验证。

**证据**：`engine/integrity.ps1` 的 `GetLabelSddl` / `SetLabel`（`LabelSecurityInformation`）、`Get-IntegrityLabelInfo`、README「已知限制与非目标」。

---

## D2. Host 通过 workspace registry 解析工作区，不信任客户端路径

**背景**：面板需要知道「当前对话属于哪个工作区」。最直接的做法是浏览器把路径发给 Host，但清除操作会修改磁盘 ACL，一旦路径来自不可信输入就是高危操作。

**决策**：

1. 浏览器只发送 `sessionId`（以及可选的 `workspacePath` 提示）；
2. Host 用 `workspaceRegistry.list()` 遍历工作区，按 `sessionIds` 匹配会话得到工作区；
3. 仅当按会话匹配不到且客户端给了提示时，才把提示交给 `registry.resolveByPath()`（提示**从不直接作为扫描目标**）；
4. 解析结果再做 `fs.realpath` 规范化，并交给 `evaluateRootSafety()` 校验：拒绝盘根、用户主目录、桌面/文档/下载等宽泛目录、DSH 数据目录、DSH 安装目录；若存在已注册工作区路径列表，目标必须是其中之一；
5. 会话活跃数 `countLiveAgents` 只作为面板的风险提示，不参与授权。

**理由**：

- 目标目录的权威来源必须是 DSH 自己的 registry，不能让浏览器决定「清哪」；
- 规范化 + 白名单/黑名单能挡住 `..`、符号链接、盘根等常见越界；`isInside` 用路径段判断避免 `C:\Work\App` 与 `C:\Work\Application` 误判；
- 即使 DSH 插件被同源页面调用，也只能操作已经注册的工作区，破坏半径可控。

**代价 / 边界**：如果某个工作区没有登记 `sessionIds`，会话解析会失败并回退 `hint → resolveByPath`；registry 内部服务不可用时返回 `registry-unavailable`，面板显示错误而不是猜测路径。`workspaceRegistry` / `agents` 都是软取（见 D7/C6），升级 DSH 后需要真机复核解析行为。

**证据**：`lib/paths.js` 的 `resolveWorkspace` / `evaluateRootSafety` / `countLiveAgents`；`lib/routes.js` 的 `/workspace` 与 `/jobs`；`test/paths.test.mjs`、`test/routes.test.mjs`。

---

## D3. 同源 HTTP 路由，而不是 remote RPC / 消息通道

**背景**：Host 在 DSH 主进程里，面板在 Web 页面里，两者需要交换任务状态、清单、导出/日志路径。

**决策**：Host 用 `ctx.webServer.register({ kind: 'prefix', path: '/dsh-low-integrity-check' })` 注册一组同源 HTTP 接口；浏览器侧用 `fetch` 请求「文档挂载前缀 + 路由段」：

- `GET /health`、`GET /diagnostics`
- `POST /workspace`、`POST /jobs`、`GET /jobs/:id`、`GET /jobs/:id/items?offset&limit`
- `POST /jobs/:id/cancel|export|log`

接口校验：`Origin` 与请求自身 `Host` 同源（无 `Origin` 的请求放行，便于直接打开/调试）；POST 必须是 `application/json`、JSON 对象、≤256 KiB；错误统一 `{ok:false,code,message}`。

**理由**：

- DSH 已经提供 `webServer` 路由载体，插件不需要另建 RPC、长连接或鉴权 token；同源限制天然把可访问面约束在 DSH 页面内；
- 调试成本低：`curl`/浏览器就能看 `/health`、`/diagnostics`，真机排障不依赖内部 API；
- 轮询对任务型场景足够（800ms），比引入事件总线/SSE 更可控，也不会在插件卸载时留下悬挂连接。

**代价 / 边界**：只支持同源页面访问，不能做外部集成；同源判断只比较 `Origin` 与 `Host`，不是 CSRF token 级防护（但插件只操作已注册工作区且需要用户明确点击清除，风险已收敛）。轮询的实时性/开销在 quick 扫描下可接受；若未来任务更长、状态更多，再评估 SSE。

**证据**：`lib/runtime.js` 的路由注册；`lib/routes.js` 的 `originAllowed`、`readJsonBody`、`PREFIX`；`client.js` 的 `mountPrefixOf` / `routeBaseOf` / `requestJson`。

---

## D4. 引擎使用 stdout JSON Lines 流式协议

**背景**：最坏情况下工作区有十几万对象，命中可能上万；如果把命中数组塞进进程内存或一次 HTTP 返回，Host/浏览器都会被打爆。同时扫描需要给面板可见的进度、错误与阶段。

**决策**：引擎 stdout 只写 JSON Lines，事件类型固定：

- `env`（用户/完整性级别/PS 版本/icacls/canWriteLabel）
- `progress`（phase/scanned/total/hits）
- `hit`（path/kind/explicit/label）
- `error`（path/message，repair 时带 `phase`/`output`）
- `result`（计数、rootLabel、snapshotPath/restorePath、errors、truncated…）
- `fatal`（code/message）

Host 边读边解析并累积到 JobManager；面板轮询 `GET /jobs/:id` 拿摘要 + 首屏 200 条；完整清单按需 `GET /jobs/:id/items` 分页，或导出/写日志；stderr 单独截断保存（64 KiB）只用于排障。`result` 是权威计数，会覆盖流式累积值；最终 `failed` 列表也是 result 覆盖流式 error。

**理由**：

- 内存有界：Host 用 `MAX_ITEMS=50000`、首屏 200、`MAX_ERRORS=500`、`MAX_FAILED=1000` 等上限；面板只拿摘要与当前页；
- 可降级：非法/空行被忽略；引擎即使中途崩溃，已流出的进度与命中仍可展示（任务最终按 exit/result 状态判定失败）；
- 进度可解释：UI 的扫描数、阶段、速率都来自 `progress`，不需要额外机制；
- stdout 与 stderr 分离：原生工具/格式化输出不会污染协议（见 AGENTS K10）。

**代价 / 边界**：协议靠 JSONL 纪律维持，任何 stdout 噪声都可能造成丢行；Host 对超大命中只保留前 50000 条，导出可能带 `truncated`；流式 `hit` 在 quick/deep 下语义不同（quick 只发显式，见 D11），消费方必须以 `result` 计数为准。

**证据**：`engine/integrity.ps1` 头部注释与 `Write-Event`/`Write-ProgressEvent`/`Write-Fatal`；`lib/engine.js` 的 `parseEngineLine`；`lib/jobs.js` 的 caps、`itemsPage`、`exportScan`、`writeLog`。

---

## D5. 放弃 `icacls /T` 全树修改

**背景**：`icacls <root> /setintegritylevel ... /T` 会递归作用于整棵子树，命令简单，但会修改所有子对象——包括扫描未命中的、用户明确保持原状的对象，也会跟随目录下所有层级。

**决策**：Repair 不用 `/T`。流程是：

1. 扫描得到命中集合（streaming hit）；
2. 写快照与 restore 脚本；
3. 显式 Low 目录按深度升序修复（目录用 `(OI)(CI)Medium`）；
4. 显式 Low 文件修复（文件用 `Medium`）；
5. **复扫**，对仍然 Low 的对象逐个兜底修复（不假设父级修复会传播）；
6. 对原始命中集合做最终验证，产出 `failed` / `remaining`。

**理由**：

- 标签继承传播不可靠（修父级后子项可能仍是继承 Low），不能靠 `/T` 一次了事；逐对象修复才能对「每个命中对象」给出确定结果；
- `/T` 会触碰非命中对象，违反「Repair 只改命中集合」的安全约束；
- 每个对象改完立即复读验证，失败能定位到具体路径与 icacls 输出，便于失败日志与用户重试。

**代价 / 边界**：阶段 2 已把标签写入改为进程内 native/grant（见 D15），逐对象 icacls 进程已消除；但「逐对象 + 复扫 + 最终验证」的语义仍保留，当前大目录修复的主要耗时变成 Repair 的 3 遍 deep 扫描（见 D15 与 K14），需要 Host 的 30 分钟硬超时与 5 分钟无进度看门狗兜底。

**证据**：`engine/integrity.ps1` 的 `Invoke-RepairMode`（分层 + rescan + final verify）、README「修复顺序」；`test/run-fixtures.ps1` 的 `Test-RepairSuccess` / `Test-NonHitSddlUnchanged` / `Test-E1Propagation`。

---

## D6. 快照 + `restore-*.ps1`，不做完整 ACL 回滚

**背景**：修复会修改命中对象的完整性标签；用户可能想撤销。完整 ACL 回滚（保存/恢复每个对象的 DACL/SACL）看似彻底，但风险与体量都大。

**决策**：

- 每次 Repair 在改动前写 `<DataDir>\snapshots\snapshot-<stamp>.json`：`version`、`createdAt`、`root`、`rootLabel`、`hitCount`、`hits[{path,kind,explicit,label,sddl}]`；
- 同时写 `restore-<stamp>.ps1`：把快照中**每一个命中对象**恢复为 Low（继承命中会恢复成显式 Low，不重建原继承链）；
- 非命中对象不写快照、不做任何 ACL 变更；
- 唯一会改动 DACL 的路径是 `WRITE_OWNER` 临时授权（阶段 2 起进程内 native grant 优先、icacls 兜底，见 D15）：授权前后都必须读 DACL SDDL 并逐字符比较，失败要报出来（见 AGENTS K2）。

**理由**：

- 插件的写入面只有「标签」；保存全量 ACL 容易把 DACL 当成可回放数据，实际语义复杂（继承、显式顺序、SID 解析），一次错误回放比不恢复更糟；
- 快照+脚本足以让用户把「这次清除的命中对象」恢复为 Low，且脚本独立可读、可审查、可手工执行；
- 非命中之外的系统状态未被改动，不需要回滚；
- 临时授权只在必要时短暂存在，且用「逐字符还原」把 DACL 风险压到可验证范围。

**代价 / 边界**：restore 脚本不重建继承链（继承命中 → 显式 Low），也不保存非命中对象的标签；快照只覆盖本次命中，不是工作区全量 ACL 备份；用户若在清除后手工改过 ACL，restore 不应被当作 ACL 回滚工具。未来若要做完整 ACL 级回滚，应另立任务并重新评估安全边界。

**证据**：`engine/integrity.ps1` 的 `Get-SnapshotTargets` / `New-RestoreScriptText` / `Invoke-RepairMode`；`test/run-fixtures.ps1` 的 `Test-RestoreRoundtrip` / `Test-SnapshotDocument` / `Test-ScriptParses`；README「快照与恢复」。

---

## D7. 浏览器半侧不依赖任何平台 UI 包

**背景**：DSH 客户端插件可以通过 `window.__ModuleLoader__.load({ id, factory })` 加载；平台内部 UI 包（如 `@deepseek-ai/dsh-client-ui-sidebar-right`）没有公开稳定的前端 API。如果直接 `require` 平台包，DSH 升级时极易因内部导出变化而整体挂掉。

**决策**：

- `client.js` 是一个普通 IIFE 脚本：只 `require('react')`，用 `React.createElement`（不写 JSX）；factory 注入 `['slots', 'locale']`，通过 `ctx.effect` 注册 locale 与样式；
- 右侧栏通过软取内部服务完成：`ctx.get('sidebarRightTabs')` + `ctx.get('sidebarRight')`，失败时有界重试（20×250ms）并降级为 `console.warn`，**绝不抛错**；
- 样式自注入 `<style>`（按引用计数清理），class 走 `.fi-` 前缀，颜色只用 `--dsw-alias-*`（字体用 `--dsw-font-*`）；
- `package.json` 里 `dsh.client.inject` 的 `@deepseek-ai/dsh-client-ui-sidebar-right` 是**给 DSH 的平台注入声明**（让客户端半侧有对应平台能力），不是 JS import；不要在代码里 `require` 它。

**理由**：

- 仓库无构建步骤，`client.js` 由 DSH 直接加载；引入打包器/平台包会带来版本耦合与发布复杂度；
- 右侧栏是可选能力：即使内部服务缺失，插件也应安静失败，不能影响整个 Web 页面；
- 平台 token 能跟随 DSH 主题（浅色/深色）而不硬编码颜色。

**代价 / 边界**：代码是 ES5 风格（`var`/`function`/`React.createElement`），比 JSX/TS 冗长；内部服务 API 一旦真正变更，需要真机排查并适配；`sidebarRightTabs`/`sidebarRight` 无公开文档（见 AGENTS K4）。

**证据**：`client.js` 文件头注释、`makeFactory`/`applyInner`/`registerTabType`；`package.json` 的 `dsh.client`；AGENTS C4/C5/C6。

---

## D8. 包名 `dsh-low-integrity-check` 与仓库目录名不同

**现状**：仓库目录 / GitHub 仓库是 `dsh-file-integrity-check`；插件包名（`package.json`）、Host 插件名（`index.js`）、浏览器模块 id（`client.js` 的 `TAB_ID`）、右侧栏 kind、locale 命名空间、HTTP 路由前缀都围绕 **`dsh-low-integrity-check`**。

**决策**：保持两个名字并存，不重命名仓库/目录，也不把插件 id 改成目录名。

**理由**：

- DSH 安装与加载以 `package.json` 的 `name` / bundle patch 的 `id` 为准，插件身份已经与包名、路由前缀、客户端模块 id 绑定；改 id 会牵动 `package.json`、`index.js`、`client.js`、`cordis.patch.yml` 与已安装记录；
- 仓库目录名是用户克隆路径与远程地址的一部分，重命名会破坏已有文档链接、用户本地路径和潜在的外部引用；
- 两个名字的差异只需要文档解释一次（README 开头已说明），运行不受影响。

**代价 / 边界**：搜索时容易只搜一个名字；安装命令里给的是目录路径，面板/管理器显示的是包名，新人可能困惑。文档（README、AGENTS、本文件）需要主动说明。

**证据**：`package.json` 的 `name`、`index.js` 的 `export const name`、`client.js` 的 `TAB_ID`/`ROUTE_SEGMENT`、`cordis.patch.yml`、README 开头说明、`git remote -v`。

---

## D9. 本期不提供独立 CLI

**背景**：引擎 `engine/integrity.ps1` 本身可以直接调用（`-Mode Env|Scan|Repair -Root ... -Json`），很容易包一个 `dsh-low-integrity-check` 命令行入口。

**决策**：一期不做 CLI，README 把「独立 CLI」列为非目标；交互入口是 DSH 右侧栏面板。

**理由**：

- 一期/二期要优先把「扫描→查看→清除→复扫→日志」的闭环与安全约束（路径解析、确认条、引擎预检、任务状态）做扎实；CLI 会复制一套交互与输出约定；
- 引擎参数/输出已随阶段 2 扩展（`reportPath`、`methods.native` 等），CLI 一旦发布就要承诺参数与 JSON 契约兼容，时机上更适合放在发布前独立设计；
- 命令行使用需要用户自己承担「路径选择 + 确认 + 失败处理」，与当前以面板为安全护栏的设计不一致。

**代价 / 边界**：脚本化/无人值守场景暂时只能直接调 PS 脚本（需要自己处理 JSONL、退出码、DataDir）；这是 P1 增强项（HANDOFF P1-2），建议在引擎输出协议稳定后再做薄封装。

**证据**：README「已知限制与非目标」；`engine/integrity.ps1` 的 param/退出码；HANDOFF 的 P1-2。

---

## D10. 引擎在 DSH 沙箱外由 Host spawn

**背景**：DSH 工具进程运行在 **Low 完整性** 沙箱里，受 no-write-up 限制，不能把对象标签改回 Medium；而修复必须写 Medium 标签。同时，引擎不能依赖 DSH 的 shell 工具或用户交互。

**决策**：

- Host（DSH 主进程）用 `child_process.spawn` 启动**隐藏窗口的普通 Windows PowerShell 5.1**：`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File engine/integrity.ps1 ...`，`windowsHide: true`，stdout/stderr 用管道；
- 启动前用 `-Mode Env` 探测（`canWriteLabel`），Host 侧 `/health` 暴露该状态；Repair 在 `canWriteLabel !== true` 时直接拒绝（`engine-sandboxed`），面板禁用一键清除；
- 取消时先 `child.kill()`，1.5s 后仍存活则 `taskkill /PID <pid> /T /F` 兜底；stderr 截断 64 KiB；
- 引擎路径每次任务从包目录解析（`PKG_ROOT/engine/integrity.ps1`），不缓存脚本内容。

**理由**：

- 只有从 Host 派生的进程能脱离 DSH 工具的低完整性限制，拿到写 Medium 标签的能力；这也是 `/health` 探测 `canWriteLabel` 的原因；
- 独立进程 + JSONL 让引擎可以独立测试（`run-fixtures.ps1` 可换 PS 5.1/pwsh 7 宿主），Host 不需要把 PS 逻辑搬进 Node；
- `windowsHide` 避免弹出黑窗；超时/看门狗/taskkill 处理失控进程。

**代价 / 边界**：多一层进程生命周期与编码处理（OEM 解码、JSONL 缓冲、kill 竞态）；引擎脚本改动不需要重启 DSH，但 Host JS 改动需要（见 AGENTS K5/K6）；在 DSH 工具沙箱里直接跑引擎无法作为「能否修复」的验证。

**证据**：`lib/engine.js`（`resolvePowerShell`、`engineArgs`、`spawn`、`kill`）；`lib/runtime.js` 的 `probeEngine`；`lib/jobs.js` 的 `engine-sandboxed` 处理；README「工作原理」。

---

## D11. 性能优化选择 C# 下沉 + 默认 quick 模式

**背景**（阶段 1 前）：扫描在 PowerShell 里逐对象调 P/Invoke，12.2 万项约 **6m46s**（≈300 项/s）；且「继承 Low」也被逐条输出，数量可能达到十几万条，Host/UI 都被拖慢。

**决策**：

1. 引擎新增 `-ScanDepth quick|deep`，**默认 quick**：
   - **quick**：内嵌 C# 扫描器（`Add-Type` 懒编译）。`FindFirstFileExW` 枚举（`FindExInfoBasic`、`\\?\` 前缀、不跟随重解析点、按名字跳过 `-SkipDirs`），逐对象 `GetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` → SDDL → 在 C# 解析 `ML` ACE（`LW/ME/HI/SI` + `ID`）。**只把显式 Low 对象作为 `hit` 行输出**；继承 Low 只计数；result 带 `depth:"quick"`、`engine:"csharp"`、`scanMs`；
   - **deep**：保留旧 PowerShell 全量遍历，逐条输出所有 Low 命中（`depth:"deep"`、`engine:"powershell"`），用于兼容旧测试、深度排查与对照；
   - **Env / Repair 不受 `-ScanDepth` 影响**：Repair 继续使用 deep 遍历，保持快照/修复逻辑不变。
2. quick 的 C# 扫描器有界：显式命中上限 5000（超出 `truncated`）、错误上限 500、进度回调约每 2000 项或 250ms 一次，result 的 `hits` = 显式 + 继承总数。

**理由**：

- 性能热点在「枚举 + 每对象安全信息读取 + PS↔Native 往返」；把这些收进单进程 C# 能消除大部分 PowerShell 开销；
- 用户关心的是「显式 Low 对象」（继承项修父级即可覆盖/由聚合解释），没必要把十几万继承命中通过 JSONL 传给 Host/UI；
- 保留 deep 的旧行为，让已有夹具、排障和对照实验仍可运行，降低一次改坏扫描语义的风险；
- 懒编译让 Env / Repair / deep 不为 C# 编译付成本。

**实测结果**（最终验收口径，2026-11-06）：

| 场景 | quick | deep | 对比 |
|---|---|---|---|
| 2000 文件夹具（2201 项） | wall≈1.55s | wall≈13.4s（ratio≈0.12） | ≈8.6× |
| 真实大目录（122,575 项，只读） | wall≈38.8s（`scanMs`≈37.8s，约 0.31 ms/项） | 旧版本 6m46s（用户截图） | ≈10.5× |

**代价 / 边界**：122k 只读 quick 仍高于 Lead 设定的 10–30s 目标（P1-8 计划用 `GetSecurityDescriptorSacl` + `GetAce` 直读 ACE 再优化，尚未实现）；quick 的「只发显式命中」是行为分叉，Host/UI 需按 `itemsScope`/`depth` 区分——阶段 3 已完成 panel 聚合与深度开关适配；C# 代码增加维护面，且必须保持 PS 5.1 可编译/可运行；quick 与 deep 的计数一致性靠夹具断言保证。

**证据**：`engine/integrity.ps1` 头部 `-ScanDepth` 说明、`Invoke-ScanMode` / `Invoke-QuickScanMode` / `Invoke-DeepScanMode`、`$script:QuickScannerTypeCode`；`test/run-fixtures.ps1` 的 `Test-QuickScan` / `Test-QuickExplicitHitsInSandbox` / `Test-QuickBench` / `Test-EngineParityPwsh7`；HANDOFF §3.2。

---

## D12. 其它已落地的小决策

| 决策 | 现状与理由 |
|---|---|
| **一个工作区同时只跑一个任务** | `JobManager` 以大小写不敏感的规范化工作区路径为 key，running 时返回 `busy`。扫描/修复都重度 IO，同时跑会互相拖慢且修复期间扫描结果不稳定；也避免用户误触多个清除 |
| **30 分钟硬超时 + 5 分钟无进度看门狗** | 引擎异常挂起时靠 Host 兜底取消；任何 `progress`/事件都会 `touch` 重置看门狗。取消后 JobManager 等进程退出再落终态，避免状态竞争 |
| **任务 TTL 15 分钟** | 终态任务保留 15 分钟供面板轮询/导出/日志；之后内存清理，避免长期占内存 |
| **内存上限** | `MAX_ITEMS=50000` / 首屏 200 / 分页 500 / `MAX_ERRORS=500` / `MAX_FAILED=1000`；超限置 `truncated`。理由同 D4：面板轮询与导出不能依赖无限内存 |
| **800ms 轮询** | 任务型交互，800ms 足够且避免频繁请求；面板首次进入用 `GET /jobs/:id` 恢复任务，再轮询 |
| **sessionStorage 任务恢复** | 浏览器刷新/切换会话后，可凭 `sessionStorage['dsh-fi:'+sessionId]` 找回 jobId；任务 404 时提示失效并允许重新扫描。任务状态在 Host 内存，刷新页面不等于取消任务 |
| **跳过目录** | Host 传 `node_modules,.git,.pnpm-store`；引擎默认 `node_modules,.git`。跳过是「既不遍历也不上报」，避免第三方目录噪声与体量；不跟随 junction/symlink |
| **面向普通用户，不要求管理员** | 默认操作当前用户自有对象；DACL 缺 `WRITE_OWNER` 用临时授权降级；非 owner 对象报失败并建议管理员重试（README 已说明） |
| **Windows only** | 完整性标签是 Windows 安全描述符概念；路由按 `platform === 'win32'` 拒绝任务，面板显示只读提示 |
| **零第三方依赖 / 无构建** | 安装与运行只依赖 DSH + Windows；`client.js` 直接可读，引擎脚本每次重读（见 D7/D10） |
| **DataDir 由 Host 指定** | Host 传 `%DSH_HOME%\low-integrity-check`，保证在工作区外；引擎对 DataDir 在 Root 内做防御性排除，但不作为契约（见 AGENTS K3/C12） |
| **导出优先用引擎报告** | 引擎 Scan 直写 `<DataDir>\reports\scan-*.json`，Host 在 `reportPath` 存在时直接返回该路径（见 D14）；仅旧任务/报告写失败时回退 Host 序列化 `job.items` |
| **失败日志内容** | 固定包含插件版本、action/status/message、workspace、时间、引擎环境预检、摘要、engine stderr、不可读项（前 200）、失败对象（前 500，含 icacls 原始输出）与管理员重试指引；便于用户直接交给管理员或提 issue |

**证据**：`lib/jobs.js` 全文（`LIMITS`、`start`、`handleEvent`、`onExit`、`requestStatus`/`requestCancel`、`snapshot`、`exportScan`、`writeLog`、`dispose`）；`client.js` 的轮询、sessionStorage、文案；README「数据目录」「已知限制」。

---

## D14. 报告文件由引擎直写，导出只传路径

**背景**：Scan 的命中清单在 deep 模式下可能有数万条；此前 Host 只能在内存里累积 `job.items`（上限 50000），导出时再把整份清单序列化写盘，代价是「引擎 → JSONL → Host 内存 → JSON 文件」两遍数据搬运，面板也拿不到稳定、完整、可分享的报告文件。

**决策**（阶段 2 落地）：

1. 每次 Scan 结束时，引擎把完整命中报告写到 `<DataDir>\reports\scan-<timestamp>.json`（deep 与 quick 都写），并在 `result.reportPath` 返回该路径；
2. 报告字段：`version/createdAt/mode/depth/engine/root/rootLabel/scanned/hits/explicitCount/inheritedCount/truncated/scanMs/itemsScope/note/items/errors`；`itemsScope` 语义：quick=`explicit`（items 只含显式命中，继承只计数）、deep=`all`；items 上限 `MaxReportItems=50000`，超出时 `truncated:true`；
3. 报告写入失败只发 `error` 事件并把 `reportPath` 置空，**Scan 本身不失败**；Host 的 `/export` 在 `reportPath` 存在时直接返回该路径（不再二次序列化），仅在报告缺失（旧任务/写失败）时回退 Host 写 `exports\low-integrity-*.json`；
4. Host snapshot 透传 `reportPath`/`depth`/`itemsScope`/`engine`；面板在导出前就展示报告路径，导出后显示返回路径。

**理由**：

- 一次写入、一次读取：大清单不再经 Host 内存/HTTP 中转，Host 只保留摘要与首屏 200 条；
- 报告是完整事实源：包含计数、scope、错误与 item 明细，便于人工排查/归档/交给其他工具；
- 兼容旧行为：`/export` 与失败日志对旧任务仍可回退 Host 序列化，不破坏已存在的任务/客户端逻辑。

**代价 / 边界**：报告落在 `%DSH_HOME%\low-integrity-check\reports\`，需要按数据目录策略清理（目前不自动清理）；items 上限 50000，超大 deep 命中会 `truncated`；报告路径是本地文件路径（不是 HTTP 下载链接），只用于同源面板展示与复制；报告内容包含工作区路径，分享前需脱敏。

**证据**：`engine/integrity.ps1` 的 `Write-ScanReport` / `Get-RelativeReportPath`、`Invoke-DeepScanMode` / `Invoke-QuickScanMode`；`lib/jobs.js` 的 `result.reportPath` 透传与 `exportScan` 优先路径；`client.js` 的 reportPath 展示；`test/run-fixtures.ps1` 的 `Test-ScanReport` 断言。

---

## D15. 修复走 native/grant，icacls 降为错误兜底

**背景**：阶段 2 前，修复每个命中对象都要 `spawn` 一次 `icacls /setintegritylevel`；对十万级命中，进程创建开销就是主要成本。且 DSH 沙箱创建的对象常见 DACL 不授予 `WRITE_OWNER`，需要临时授权降级。

**决策**（阶段 2 落地）：

1. 普通路径：进程内 C# `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` 设 `Medium`（目录 `(OI)(CI)Medium`、文件 `Medium`），成功后立即复读验证，记 `methods.native`；
2. Access denied（Win32 5）且当前用户是对象 owner：在 C# 进程内读原始 DACL → 插入当前用户 `WRITE_OWNER` allow ACE → 设置标签 → 还原原 DACL，**复读 DACL 与授权前逐字符比较**，一致才算成功并记 `methods.grant`；
3. 以上进程内路径失败时才回退既有 `icacls` 逻辑（包括 `icacls /grant *<sid>:(WO)`、`finally /remove:g` 与错误输出采集），成功时记 `methods.icacls`；失败按 failed 记录，方法标签（如 `native+icacls`）不进 `methods` 计数；
4. Repair 的分层顺序（显式目录→显式文件→复扫兜底）、快照、`restore-*.ps1` 与最终验证语义保持不变；非命中对象始终不动；
5. `restore-*.ps1` 是独立 PS 5.1 脚本，内部仍用 `icacls`（含同样的临时授权/还原逻辑），不依赖引擎内存中的 C# 类型。

**理由**：

- 消除逐对象进程创建，修复从「每对象一次 icacls」变为「每对象一次进程内 P/Invoke」；
- 保留 icacls 作为错误兜底，失败日志仍有可读的原始输出，排障路径不变；
- DACL 临时授权的风险边界与旧实现一致：只在 owner 场景、必须逐字符还原、失败可追溯。

**代价 / 边界**：

- 修复总时长仍由 Repair 的 **3 遍 PowerShell deep 扫描**（初始扫描/复扫/最终验证）主导，不是「native 设置标签」的速度。夹具 INFO `repair-fast-path-throughput`（3000 grant + 20 direct，hits=3022）：repairWallMs≈**37.7s**、perGrantFileMs≈**12.56**、setupMs≈**4059**；十万级工作区的修复耗时要按扫描瓶颈估算。后续 P1-7 计划把 Repair 扫描切到 C#；
- native 路径只在 `Medium` 标签与常规对象上验证；`restore-*.ps1` 仍是 icacls 路径，未改为 native；
- `methods` 计数（`native/grant/icacls`，`pinvoke` 为兼容旧日志保留的字段）是排障与回归的重要信号，不要随意改名。

**证据**：`engine/integrity.ps1` 的 `Set-IntegrityLevelOnPath`（native→grant→icacls fallback）、`Set-IntegrityLevelWithOwnerGrant`、C# `SetLabelToMediumWithTemporaryGrant`、Repair 的 `methods` 统计；`test/run-fixtures.ps1` 的 `Test-NativeFastPath` / `Test-RepairFastPath` / `Test-RepairNeedsGrant` / `repair-fast-path-throughput`；HANDOFF §3.3。

---

## D16. 尚未决策的开放问题

以下事项在仓库中没有定稿设计，后续接手人不要把它们当作已决定：

1. **`S-1-4` / Everyone 清理**：扫描口径（是否按 SID/ACE 类型命中）、修复策略（直接删 ACE / 改 Deny→Allow / 只提示）、回滚方式、误报处理都未定；本期仅确认「不在 Low 标签工具里顺手做」（D1）。
2. **CLI 形态**：是否提供 `dsh-low-integrity-check scan|repair`、参数与 JSON 输出契约、是否复用引擎还是调 Host、是否需要确认/无交互模式；阶段 2 后引擎字段趋于稳定，但仍建议作为 P1-2 独立设计，不要在改引擎时顺手加。
3. **扫描 10–30s 是否作为发布门槛**：当前 quick 122k≈38.8s；需产品决定它是发布硬门槛还是持续优化项。具体优化方向见第 9 条与 HANDOFF P1-8。
4. **市场元数据与发布流程**：marketplace 描述/截图/分类、版本策略、tag/Release、签名或校验方式均未定。
5. **Config schema**：是否把跳过目录、扫描上限、DataDir、默认 quick/deep 开放为 DSH 插件配置；开放后需要 schema/默认值/安全校验与文档。
6. **i18n 扩展**：面板内置 zh/en 字典（中文为键集真源）；是否拆到 locale 文件、是否支持更多语言、en 与 zh 逐键同步的校验方式未定。
7. **CI 策略**：Windows CI 上能否获得可写标签的普通用户环境；若不能，CI 只跑 Node 测试 + `npm run check` + SANDBOX 夹具并标注 SKIP，FULL 仍靠人工/宿主环境。
8. **Repair 扫描切 C#**：Repair 仍是「初始 deep 扫描 → 复扫 → 最终验证」3 遍 PowerShell 遍历，是当前大目录修复的主要耗时（见 D15）；迁移到 C# 的扫描器复用方式、进度/取消语义、与快照/最终验证的衔接都未设计（HANDOFF P1-7）。
9. **quick 扫描 GetAce 直读**：是否用 `GetSecurityDescriptorSacl` + `GetAce` 直接读 ACE 替代「SDDL 字符串 → C# 解析」，以把 122k quick 从≈38.8s 进一步压到 10–30s 目标；实现方式、兼容性与收益 benchmark 都未定（HANDOFF P1-8）。
10. **阶段 3 UI 的真机交互细节**：quick 聚合/deep 开关/ETA 已在代码层完成，但重启 DSH 后的真机观感、极端状态（total 未知、旧任务、超大数值）是否需要微调，待真机复核（HANDOFF §4.2）。
