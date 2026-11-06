# dsh-low-integrity-check

> 一个 Windows 专用的 DSH（DeepSeek Harness）插件：在右侧栏检查当前工作区残留的 **Low 完整性标签**，确认后一键恢复为 **Medium**，并支持导出清单、复扫验证与失败日志。
>
> 仓库名 `dsh-file-integrity-check` 是项目目录名；插件包名与 DSH 插件 id 为 **`dsh-low-integrity-check`**。
>
> 开发与维护文档：[AGENTS.md](AGENTS.md)（技术约束与已知坑）、[docs/HANDOFF.md](docs/HANDOFF.md)（当前状态/待办/验证边界）、[docs/DECISIONS.md](docs/DECISIONS.md)（关键取舍与理由）。

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
- **一键清除**：修复时优先在进程内用 P/Invoke 直接设置 Medium（目录 `(OI)(CI)Medium`、文件 `Medium`），随后复扫验证。
- **权限降级路径**：遇到对象缺少 `WRITE_OWNER`（DSH 沙箱创建的常见情况）时，在进程内临时授予当前用户 `WRITE_OWNER` → 改标签 → 还原 DACL，并校验 **DACL 逐字符还原**；失败才回退 `icacls` 获取可读错误。
- **快照与恢复**：清除前保存命中对象的标签快照与 `restore-*.ps1`；可随时把对象恢复为 Low。
- **失败日志**：清除失败时逐条列出对象、原因与 `icacls` 原始输出，可一键生成日志文件。
- **进度体验**：运行中显示阶段、已扫描数量、扫描速率与预计剩余时间（total 已知时），随时可取消。
- **安全约束**：只接受 DSH 已注册工作区的规范化路径；拒绝盘根、用户主目录及其宽泛子目录、DSH 安装目录、相对路径；HTTP 只接受同源请求。

## 使用

1. 安装插件（见下节），DSH 重新加载后，右侧边栏的「指南」页会出现 **完整性检查** 入口（也可由标签栏打开）。
2. 面板顶部显示当前工作区路径；按需打开「深度扫描（逐文件清单）」，然后点击 **开始检查**。
3. 扫描结束后：
   - 未命中：显示「未发现 Low 标签」；
   - 命中：显示「发现 N 个 Low 对象（X 显式 / Y 继承自父级）」，可展开清单、导出 JSON。
     快速模式下清单只列显式项，继承项显示为聚合说明；需要逐文件清单时切到深度模式再扫描。
4. 点击 **一键清除** → 确认条（含预计修复对象数、快照/恢复提示、活跃会话风险提示）→ 执行。
5. 结果显示「清除成功（N 项）」或「清除失败（N 项失败）」，失败时可 **生成日志**，并显示日志路径。

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
   │ 同源 fetch  /dsh-low-integrity-check/*（quick / deep）
   ▼
Host 插件 (index.js, Cordis)
   │ 1. workspaceRegistry 解析会话所属工作区（客户端不传路径）
   │ 2. 规范化 + 安全校验（realpath、注册路径比对、黑名单）
   │ 3. 任务锁 / 取消 / 30 分钟硬超时 / 5 分钟无进度看门狗
   │ 4. spawn 隐藏 powershell.exe（windowsHide，非 DSH 会话）
   ▼
引擎 (engine/integrity.ps1)  -Mode Env|Scan|Repair  -ScanDepth quick|deep
   │ quick：内嵌 C# 扫描器（FindFirstFileExW + 标签读取 + 判定）
   │ deep ：原 PowerShell 全量遍历
   │ JSON Lines：env / progress / hit / error / result / fatal
   │ Scan 结束时直写 <DataDir>\reports\scan-*.json（result.reportPath）
   ▼
Host 累积摘要 + 首屏 200 条 → 面板 800ms 轮询
分页取全量；导出直接返回引擎报告路径
```

关键实现点：

- **标签读取**：P/Invoke `GetNamedSecurityInfoW` + `LABEL_SECURITY_INFORMATION` 读取 SDDL（普通用户可读，无需 SeSecurityPrivilege）；解析 `ML` ACE 的等级（`LW/ME/HI/SI`）与继承标志（`ID`）。quick 模式在 C# 内完成枚举与解析，避免逐对象跨 PowerShell 边界的开销。
- **扫描模式**：quick 只流式输出显式命中（继承项计数），默认用于日常检查；deep 输出全部命中，供逐文件排查。
- **修复顺序**：显式 Low 目录（深度升序）→ 显式 Low 文件 → 复扫剩余对象逐个兜底；每个对象改完立即复读验证。不使用 `/T` 全树，避免改动非命中对象。
- **修复快路径**：C# 进程内 `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` 直接设标签（`methods.native`）；Access denied 时进程内临时 DACL grant/还原（`methods.grant`），只有都失败才回退 `icacls` 拿可读错误。
- **长路径/中文**：枚举与 P/Invoke 使用 `\\?\` 前缀；stdout 为 UTF-8 无 BOM 的 JSON Lines；支持中文、空格与 >260 字符路径。
- **跳过**：默认跳过 `.git`、`node_modules`、`.pnpm-store`；不跟随 junction / 符号链接。

## 数据目录

所有产物在 `%DSH_HOME%\low-integrity-check\`（默认 `C:\Users\<user>\.dsh\low-integrity-check\`）：

| 目录 | 内容 |
|---|---|
| `reports\scan-*.json` | 扫描完整报告（quick 只含显式 items，deep 含全部命中；导出直接返回该路径） |
| `snapshots\snapshot-*.json` | 清除前的命中对象与原始标签/SDDL |
| `snapshots\restore-*.ps1` | 把命中对象恢复为 Low 的独立脚本（PS 5.1 可执行） |
| `exports\low-integrity-*.json` | 旧版导出（当引擎未提供 reportPath 时的后备） |
| `logs\repair-*.log` | 失败日志（对象、原因、`icacls` 原始输出、环境预检） |

## 开发与测试

```powershell
# 语法与单测（36 项：路径安全 / 任务管理 / 引擎协议 / HTTP 路由）
npm test

# 引擎夹具验收（需要能写完整性标签的普通用户会话）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\run-fixtures.ps1
```

`test/run-fixtures.ps1` 会自动探测标签写权限：可写则跑 FULL（含修复成功、恢复回滚、继承传播实验、native/grant 修复快路径、报告文件断言、DataDir 排除等）；不可写则跑沙箱内可测子集并标注 SKIP。

开发验收结果（DSH 0.2.2-rc.1 / Windows 11，2026-11-06）：

- 引擎 FULL 夹具（阶段 2 验收）：**PASS=184 / FAIL=0 / SKIP=1 / INFO=6**
- 沙箱内回归（PS 5.1 与 pwsh 7）：均 **PASS=140 / FAIL=0 / SKIP=8**
- Node / Host 测试：**36 项全过**（paths 15 / jobs 11 / engine 6 / routes 4）
- 性能（同机对照）：
  - 2000 文件夹具：quick ≈1.55s vs deep ≈13.4s（约 8.6×）
  - 真实 122,575 项只读扫描：quick ≈38.8s vs 旧版 deep ≈6m46s（约 10.5×）
  - 3000 个需临时授权文件 + 20 个普通文件的修复：约 38 秒（夹具 INFO `repairWallMs≈37.7s`；总时长仍由 Repair 的 3 遍深度扫描主导，逐对象 `icacls` 进程已消除）
- 真实工作区：修复前 24 命中（1 显式根 + 23 继承），清除后复扫 **0 命中**、根与文件均为 Medium，非命中 DACL 抽样逐字符一致。

## 已知限制与非目标

- 不改变 DSH 沙箱行为，也不承诺 Low 标签不再复发（`workspace-write` 写入后可能重新出现）。
- 本期不处理非继承的 `S-1-4-*` 授权 ACE 与配套的 Everyone 拒绝项，只处理 Low 完整性标签。
- 默认跳过 `.git` / `node_modules` / `.pnpm-store`；不做全盘扫描。
- 不碰文件内容；不提供完整的 ACL 回滚，只提供标签快照与恢复脚本。
- 本期不提供独立 CLI（引擎脚本可单独调用，后续可加薄封装）。
- 需要普通用户对命中的「自有对象」具备 owner 身份；非 owner 对象会逐条报告失败并建议用管理员 PowerShell 重试。
- Repair 的初始扫描 / 复扫 / 验证仍走 PowerShell deep 遍历；十万级目录时修复总时长主要由这几遍扫描决定（后续计划把 Repair 扫描也切到 C#）。
- quick 扫描当前约 0.31 ms/项；后续可用 `GetSecurityDescriptorSacl` + `GetAce` 直读 ACE 再提速，目前未实现。

## 目录结构

```
index.js                  Host 入口（Cordis 插件）
lib/
  runtime.js              registry/引擎探测/生命周期
  routes.js               HTTP API（同源、JSON、方法校验，depth 参数）
  paths.js                工作区解析与路径安全
  jobs.js                 任务管理（互斥/超时/取消/导出/日志）
  engine.js               spawn 隐藏 PowerShell + JSONL 解析（engineInvocation 拼 argv）
client.js                 右侧栏面板（纯 JS，无 JSX / 无平台包依赖；quick/deep、ETA、导出）
engine/integrity.ps1      Env / Scan / Repair 引擎（PS 5.1 兼容；quick 用内嵌 C# 扫描器）
locale/                   插件管理器展示文案
test/                     Node 单测与引擎夹具验收
AGENTS.md                 开发约束、测试命令、已知坑（给后续 agent/开发者）
docs/HANDOFF.md           当前状态、P0/P1 待办、验证边界
docs/DECISIONS.md         关键取舍与理由
```
