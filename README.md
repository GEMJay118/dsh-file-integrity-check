# dsh-low-integrity-check

> 一个 Windows 专用的 DSH（DeepSeek Harness）插件：在右侧栏检查当前工作区残留的 **Low 完整性标签**，确认后一键恢复为 **Medium**，并支持导出清单、复扫验证与失败日志。
>
> 仓库名 `dsh-file-integrity-check` 是项目目录名；插件包名与 DSH 插件 id 为 **`dsh-low-integrity-check`**。

## 背景：为什么需要它

DSH 以 `workspace-write` 模式打开工作区时，会在磁盘安全描述符上写入可继承的 **Low 完整性标签**（`S-1-16-4096`，no-write-up）等记录。这些记录会跨会话保留，DSH 移除工作区、切到「完全权限」或升级都不会自动清除。常见的副作用：

- 工作区内的 exe / bat 双击提示「无法验证发布者」
- 快捷方式图标变成白纸
- Electron 程序以 `0x80000003` 崩溃
- 构建产物在沙箱外仍被降权，写不进 `%TEMP%`
- 旧子目录写不进，只能手工用 `icacls` 逐目录排查

手工清理难以验证、也容易误改正常权限。本插件把「扫描 → 查看清单 → 一键清除 → 复扫验证 → 失败日志」做成右侧栏里的闭环。

## 功能

- **右侧栏面板**：在当前对话所属工作区打开「完整性检查」标签页。
- **两种扫描模式**：
  - **快速模式（默认）**：内嵌 C# 扫描器逐对象读取完整性标签，只逐行列出「显式 Low」，继承项只计数与聚合说明；大工作区（十万级对象）也能在数十秒内完成。
  - **深度模式**：面板里的「深度扫描（逐文件清单）」开关，输出全部命中（含继承项），适合排查或需要逐文件清单时使用。
- **命中口径**：区分「显式设置」与「继承自父级」，并在面板中说明继承项可能随父级恢复（Windows 不保证自动传播）。
- **清单查看与导出**：面板内分页查看命中清单（路径 / 类型 / 显式或继承 / 复制完整路径）；扫描结束时引擎直接写出完整 JSON 报告，导出即返回该文件路径。
- **一键清除**：修复在引擎内一次完成——扫描命中并写出快照 → 单遍逐对象把标签设为 Medium（目录 `(OI)(CI)Medium`、文件 `Medium`）→ 每个对象改完立即复读验证 → 只对失败候选再复验一次。修复阶段不再逐条输出命中，也不再整遍复扫。
- **权限降级路径**：遇到对象缺少 `WRITE_OWNER`（DSH 沙箱创建的常见情况）且当前用户是对象 owner 时，在进程内临时授予 `WRITE_OWNER` → 改标签 → 还原原 DACL，并复读 SDDL **逐字符比较**确认还原一致；失败时记录可读诊断（Repair 不再逐对象回退 `icacls`；`icacls` 只在环境能力探测与恢复脚本里使用）。
- **快照与恢复**：清除前保存命中对象的标签快照与 `restore-*.ps1`；可随时把对象恢复为 Low。清除结果里的「快照文件」行有 **打开文件夹** 按钮，可直接打开快照所在目录（Host 只允许打开 `snapshots` 目录）。
- **失败日志**：清除失败时逐条列出对象、原因与诊断输出，可一键生成日志文件。
- **进度体验**：运行中显示阶段（扫描 / 修复 / 验证）、已扫描或已修复数量、扫描速率与预计剩余时间（total 已知时），随时可取消；修复进度按批合并，不再每个对象一行。
- **安全约束**：只接受 DSH 已注册工作区的规范化路径；拒绝盘根、用户主目录及其宽泛子目录、DSH 安装目录、相对路径；HTTP 只接受同源请求。

## 使用

1. 安装插件（见下节），DSH 重新加载后，右侧边栏的「指南」页会出现 **完整性检查** 入口（也可由标签栏打开）。
2. 面板顶部显示当前工作区路径；按需打开「深度扫描（逐文件清单）」，然后点击 **开始检查**。
3. 扫描结束后：
   - 未命中：显示「未发现 Low 标签」；
   - 命中：显示「发现 N 个 Low 对象（X 显式 / Y 继承自父级）」，可展开清单、导出 JSON。
     快速模式下清单只列显式项，继承项显示为聚合说明；需要逐文件清单时切到深度模式再扫描。
4. 点击 **一键清除** → 确认条（含预计修复对象数、快照/恢复提示、活跃会话风险提示）→ 执行。清除过程显示「扫描 / 修复标签 / 复扫验证」阶段与已修复数量。
5. 结果显示「清除成功（N 项）」或「清除失败（N 项失败）」；失败项给出原因与诊断，可 **生成日志**，并显示日志路径。面板的「复扫」提示来自引擎对失败候选的终验（修复后不再整遍复扫），需要完整确认时可点「重新扫描」。

> 提醒：只要还有 `workspace-write` 会话在写入，DSH 可能再次给工作区写入 Low 标签。插件不改变沙箱行为，也不承诺标签不再复发。

## 安装

要求：

- Windows 10 / 11
- DSH Desktop **≥ 0.2.1**（开发与验收使用 0.2.2-rc.1）
- Windows PowerShell 5.1（系统自带）

本插件是一个 DSH bundle，通过本地目录安装：

```powershell
git clone https://github.com/GEMJay118/dsh-file-integrity-check.git
```

在 DSH 中让 agent 执行插件安装（或使用插件管理器的本地安装入口），指向克隆出来的目录：

```
plugin_manager install_bundle  D:\path\to\dsh-file-integrity-check
```

安装成功后插件管理器会显示 `dsh-low-integrity-check`，右侧栏出现「完整性检查」入口。更新代码后需要重启 DSH 以加载新的 Host JS 与 client.js；引擎脚本（`engine/integrity.ps1`）每次任务都会重新读取，改完无需重启。

## 工作原理

```
右侧栏面板 (client.js, React.createElement)
   │ 同源 fetch  /dsh-low-integrity-check/*（quick / deep / repair）
   ▼
Host 插件 (index.js, Cordis)
   │ 1. workspaceRegistry 解析会话所属工作区（客户端不传路径）
   │ 2. 规范化 + 安全校验（realpath、注册路径比对、黑名单）
   │ 3. 任务锁 / 取消 / 30 分钟硬超时 / 5 分钟无进度看门狗
   │ 4. spawn 隐藏 powershell.exe（windowsHide，非 DSH 会话）
   ▼
引擎 (engine/integrity.ps1)  -Mode Env|Scan|Repair  -ScanDepth quick|deep
   │ Scan quick：内嵌 C# 扫描器（FindFirstFileExW + 标签读取 + 判定）
   │ Scan deep ：原 PowerShell 全量遍历
   │ Repair    ：内嵌 C# RepairSession（单遍扫描+快照 → 单遍修复 → 失败候选复验）
   │ JSON Lines：env / progress / hit / error / result / fatal（Repair 不发 hit）
   │ Scan 结束时直写 <DataDir>\reports\scan-*.json（result.reportPath）
   ▼
Host 累积摘要 + 首屏 200 条 → 面板 800ms 轮询
分页取全量；导出直接返回引擎报告路径
```

关键实现点：

- **标签读取**：P/Invoke `GetNamedSecurityInfoW` + `LABEL_SECURITY_INFORMATION` 读取 SDDL（普通用户可读，无需 SeSecurityPrivilege）；解析 `ML` ACE 的等级（`LW/ME/HI/SI`）与继承标志（`ID`）。quick 模式在 C# 内完成枚举与解析；修复扫描改用 `GetAce` 直读 `ML` ACE，按需重建规范 SDDL 写入快照。
- **扫描模式**：quick 只流式输出显式命中（继承项计数），默认用于日常检查；deep 输出全部命中，供逐文件排查。
- **修复快照**：任何标签写入之前，先由 C# 单遍扫描把命中对象、原始标签与 SDDL 流式写入 `snapshot-*.json`，再由 PowerShell 写出 `restore-*.ps1`；两者都完成后才开始改标签。
- **修复顺序**：按「对象类型 + 路径深度」分波推进（目录波→文件波，波内并行、波间串行，同波内无祖先/后代）；每个命中对象只修一次，改完立即复读验证；不使用 `/T` 全树，避免改动非命中对象。
- **修复快路径**：C# 进程内 `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` 直接设标签（`methods.native`）；Access denied 且当前用户是 owner 时走进程内临时授权：一次读取 owner+DACL → 授权 → 设标签 → 还原 → 一次复读逐字符比较（`methods.grant`）。阶段 5 起「还原 DACL」与「写标签」合并为一次 `SetNamedSecurityInfo`；阶段 6 起默认 8 线程并行（按 kind+depth 分波）。失败只记录可读诊断，不再 spawn `icacls`。
- **终验只覆盖失败候选**：修复结束后只复读失败候选；若候选已因父级恢复传播变为 Medium，则不计入失败。
- **长路径/中文**：枚举与 P/Invoke 使用 `\\?\` 前缀；stdout 为 UTF-8 无 BOM 的 JSON Lines；支持中文、空格与 >260 字符路径。
- **跳过**：默认跳过 `.git`、`node_modules`、`.pnpm-store`；不跟随 junction / 符号链接。

## 数据目录

所有产物在 `%DSH_HOME%\low-integrity-check\`（默认 `C:\Users\<user>\.dsh\low-integrity-check\`）：

| 目录 | 内容 |
|---|---|
| `reports\scan-*.json` | 扫描完整报告（quick 只含显式 items，deep 含全部命中；导出直接返回该路径） |
| `snapshots\snapshot-*.json` | 清除前的命中对象与原始标签/SDDL（在任何标签改动之前写入） |
| `snapshots\restore-*.ps1` | 把命中对象恢复为 Low 的独立脚本（PS 5.1 可执行） |
| `exports\low-integrity-*.json` | 旧版导出（当引擎未提供 reportPath 时的后备） |
| `logs\repair-*.log` | 失败日志（对象、原因、诊断输出、环境预检） |

## 开发与测试

```powershell
# 语法与单测（42 项：路径安全 / 任务管理 / 引擎协议 / HTTP 路由）
npm test

# 引擎夹具验收（需要能写完整性标签的普通用户会话）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\run-fixtures.ps1
```

`test/run-fixtures.ps1` 会自动探测标签写权限：可写则跑 FULL（含修复成功、恢复回滚、继承传播实验、native/grant 修复快路径、Repair 事件/进度/结果契约、并行基准、报告文件断言、DataDir 排除等）；不可写则跑沙箱内可测子集并标注 SKIP。

开发验收结果（DSH 0.2.2-rc.1 / Windows 11，2026-11-07）：

- 引擎夹具：FULL **PASS=324 / FAIL=0 / SKIP=1 / INFO=9**；SANDBOX **PASS=222 / FAIL=0 / SKIP=8 / INFO=4**（约 48 秒）。
- Node / Host 测试：**42 项全过**（paths 15 / jobs 16 / engine 6 / routes 5）。
- 性能（阶段口径与完整数据见维护文档 HANDOFF）：
  - **扫描**：真实 122,575 项 quick **≈7s**（C# 扫描器）；2000 文件夹具 quick ≈1.7s vs deep ≈25s。
  - **修复（阶段 4，顺序版基线，真实 114k）**：110,133 命中 **≈25min**（≈13.6ms/对象），其中扫描 7.1s、快照 0.43s、restore 10.5s；瓶颈是逐对象临时 WRITE_OWNER 授权。
  - **阶段 5**：临时授权把「还原 DACL + 写标签」合并为一次 `SetNamedSecurityInfo`（每对象 SD 写 3→2），FULL 断言合并写生效（`grantFallbacks=0`）。
  - **阶段 6**：按「对象类型 + 路径深度」分波、波内 8 线程并行修复；FULL 3000-grant 基准 `perGrantFileMs 4.06→2.22`，修复 **1.83×**（16 线程仅 1.87×，争用饱和，默认 8）。真实 114k 复测预计 **≈14min** 量级（待回填）。
- 真实工作区（历史，阶段 1 前）：修复前 24 命中，清除后复扫 **0 命中**、根与文件均为 Medium，非命中 DACL 抽样逐字符一致。

## 已知限制与非目标

- 不改变 DSH 沙箱行为，也不承诺 Low 标签不再复发（`workspace-write` 写入后可能重新出现）。
- 本期不处理非继承的 `S-1-4-*` 授权 ACE 与配套的 Everyone 拒绝项，只处理 Low 完整性标签。
- 默认跳过 `.git` / `node_modules` / `.pnpm-store`；不做全盘扫描。
- 不碰文件内容；不提供完整的 ACL 回滚，只提供标签快照与恢复脚本。
- 本期不提供独立 CLI（引擎脚本可单独调用，后续可加薄封装）。
- 需要普通用户对命中的「自有对象」具备 owner 身份；非 owner 对象会逐条报告失败并建议以 owner 或管理员身份重试。
- Repair 为 C# 流水线 + 并行修复（阶段 6，默认 8 线程）：顺序版真实 114k 实测 ≈25min（≈13.6ms/对象），并行版 FULL 基准 **1.83×**（真实 114k 待复测，预计 ≈14min）；在真实复测回填前不要承诺更短时长。
- 修复的终验只覆盖失败候选，不再整遍复扫；需要完整确认时可点「重新扫描」。继承项可能随父级恢复，但 Windows 不保证自动传播。
- 修复扫描已用 `GetAce` 直读标签；quick 扫描仍走 SDDL 解析，换用 `GetAce` 的收益在 5,021 项夹具上未观察到（928 vs 922ms），是否切换待 benchmark。
- 修复 Low 目录时会写入可继承的 `(OI)(CI)Medium` 标签；Windows 可能把该继承标签传播到其下已存在的子对象（包括本次跳过的 `node_modules`、数据目录内的子项和非命中子项）。FULL 验收会记录实际影响；在确认前不要把「非命中对象完全不变」当成承诺。
- 零命中修复不会生成快照/恢复脚本（`snapshotPath`/`restorePath` 为空）。

## 目录结构

```
index.js                  Host 入口（Cordis 插件）
lib/
  runtime.js              registry/引擎探测/生命周期
  routes.js               HTTP API（同源、JSON、方法校验，depth 参数）
  paths.js                工作区解析与路径安全
  jobs.js                 任务管理（互斥/超时/取消/导出/日志；progress 转发 hits/fixed）
  engine.js               spawn 隐藏 PowerShell + JSONL 解析（engineInvocation 拼 argv）
client.js                 右侧栏面板（纯 JS，无 JSX / 无平台包依赖；quick/deep、ETA、导出）
engine/integrity.ps1      Env / Scan / Repair 引擎（PS 5.1 兼容；quick 与 Repair 用内嵌 C#）
locale/                   插件管理器展示文案
test/                     Node 单测与引擎夹具验收
```
