# HANDOFF — 交接说明

> 面向接手人：当前做到哪、哪些数字可信、哪些还没验证、下一步做什么。
>
> **口径**：截至 **2026-11-06（Asia/Shanghai）**。性能优化「**阶段 1/2/3 均已实现并验收**」；**deep 端到端与新版 UI 的真机复核尚未进行**（Host JS / `client.js` 改动要重启 DSH 后才生效）。本文数字为阶段验收口径，不是最终发布数据。
>
> 配套文档：[AGENTS.md](../AGENTS.md)（约束/命令/坑）、[DECISIONS.md](DECISIONS.md)（取舍与理由）、[README.md](../README.md)（用户向，已由 Lead 同步本轮数字）。

---

## 1. 一句话现状

- **功能闭环已实现并验收**：右侧栏扫描（quick/deep）→ 聚合/清单 → 导出 → 一键清除 → 复扫验证 → 失败日志；真实工作区修复后复扫 0 命中、DACL 抽样一致。
- **性能优化阶段 1/2/3 均已完成（2026-11-06）**：
  - 阶段 1：内嵌 C# 快速扫描器 + `quick/deep`；
  - 阶段 2：Scan 直写报告文件（`result.reportPath`）+ C# 修复快路径（`methods.native` / `methods.grant`，icacls 降为错误兜底）；
  - 阶段 3：面板 quick 聚合展示、深度扫描开关、扫描速率 + ETA、reportPath 展示。
- **最终验收数字**：FULL 夹具 **PASS=184 / FAIL=0 / SKIP=1 / INFO=6**（宿主外 PS 5.1）；SANDBOX（PS 5.1 与 pwsh 7 双宿主）**PASS=140 / FAIL=0 / SKIP=8**；Node 测试 **36 项**；`npm run check` 通过。
- **仍需人工复核**：重启 DSH 后的 deep 端到端与新 UI 真机流程（见 §4.2）；Restore/Repair 大规模总时长仍受 3 遍 deep 扫描影响（见 §3.3、§5）。
- **P0 已清空**；剩余 P1：`S-1-4` 清理、CLI、CI、市场元数据、i18n、Config、Repair 扫描切 C#、quick 扫描 GetAce 直读。

---

## 2. 仓库与工作树状态

| 项 | 状态（2026-11-06） |
|---|---|
| 分支 / 基线 commit | `main` / `bd0c26c feat: DSH workspace Low integrity label scanner and cleaner (Windows)`（仓库只有一个 commit） |
| 工作树 | **有未提交改动，不要当成已发布代码**。截至本文核对时 `git status` 已修改：`README.md`（Lead 更新）、`client.js`、`engine/integrity.ps1`、`lib/engine.js`、`lib/jobs.js`、`lib/routes.js`、`test/engine.test.mjs`、`test/jobs.test.mjs`、`test/routes.test.mjs`、`test/run-fixtures.ps1`；新增未跟踪 `AGENTS.md`、`docs/`。具体以 `git status` 为准 |
| 远程 | `origin` = `https://github.com/GEMJay118/dsh-file-integrity-check.git`（GitHub 仓库名与插件包名不同，见 [DECISIONS.md](DECISIONS.md) D8） |
| 包版本 | `package.json` version `0.1.0`；引擎 `engineVersion` 也是 `0.1.0`（尚未按阶段升版） |
| CI / 发布 | 无 CI 配置、无 tag / Release、无 marketplace 元数据；安装方式目前是本地目录 bundle |
| 文档 | `README.md` 已由 Lead 同步（36 项测试、FULL=184、quick/deep、ETA、reportPath 等）；本任务维护 `AGENTS.md`、`docs/HANDOFF.md`、`docs/DECISIONS.md` |
| 客户端 | `client.js` 约 3022 行（`Get-Content` 计数）；纯 JS、无 JSX、无平台包依赖；`node --check` / `npm run check` 通过（Lead 2026-11-06 口径） |

共享任务板（供接手人定位）：

| 任务 | 内容 | 状态 |
|---|---|---|
| task-1 | PowerShell 引擎 + 夹具 | completed |
| task-2 | 右侧栏 client.js 初版 | completed |
| task-3 | 阶段 1：C# 快速扫描器 + quick/deep | completed |
| task-4 | 阶段 2：引擎直写报告 + C# 修复快路径 | completed |
| task-5 | 阶段 3：UI 聚合 + 深度开关 + ETA | completed |
| task-6 | 三份项目文档 | completed（本轮按最终状态再同步） |

---

## 3. 已验证数字（按阶段/来源区分）

> 所有数字都带阶段与日期；README 由 Lead 维护，引用时不要与历史段落混淆。

### 3.1 功能闭环（已验收，阶段 1 之前）

| 项 | 结果 | 备注 |
|---|---|---|
| 真实工作区闭环 | 扫描→清单→导出→一键清除→复扫→日志 全流程可用 | 手工真机验证（DSH 右侧栏），非自动化集成测试 |
| 真实工作区命中与清除 | 修复前 24 命中（1 个显式根 + 23 个继承）；清除后复扫 **0 命中** | 工作区 `D:\A__AI_Project\DSH_Plugin\dsh-file-integrity-check`；README 历史记录 |
| 清除后标签/DACL | 根与文件均 Medium；**非命中对象 DACL 抽样逐字符一致** | DACL 一致性由真机抽样验证，非全量 |
| 历史 Node 单测 | **33 项全过**（阶段 1 前） | README 历史记录 |
| 历史 FULL 夹具 | **PASS=121 / FAIL=0 / SKIP=1**（阶段 1 前） | README 历史记录 |

### 3.2 阶段 1：C# 快速扫描器 + quick/deep（已验收）

| 指标 | 数字 | 说明 |
|---|---|---|
| 阶段 1 验收 FULL | **PASS=154 / FAIL=0 / SKIP=1 / INFO=4**（宿主外 PS 5.1） | 已被阶段 2 的最终 FULL（184）覆盖，仅作阶段记录 |
| 阶段 1 沙箱回归 | **PASS=126 / FAIL=0 / SKIP=7**（PS 5.1 + pwsh 7 双宿主） | 同上，已被最终 140 覆盖 |
| 2000 文件夹具（2201 项） | quick wall≈**1.55s** vs deep wall≈**13.4s**（ratio≈**0.12**，约 8.6×） | `quick-vs-deep-2000-files` INFO；软断言 quick 更快 |
| 真实大目录只读扫描（122,575 项） | quick wall≈**38.8s**（`scanMs`≈37.8s，约 **0.31 ms/项**） vs 旧版 deep（用户截图）≈**406s**（6m46s），约 **10.5×** | 旧 deep 来自旧版本截图，不是同一构建对照；Lead 目标区间 10–30s，**尚未达到** |
| quick/deep 计数一致性 | 夹具断言 quick 的 `hits/explicitCount/inheritedCount/scanned/rootLabel` 与 deep 一致，显式命中集合一致 | Full 与 sandbox 均覆盖 |

### 3.3 阶段 2：报告文件 + C# 修复快路径（已验收，2026-11-06）

| 指标 | 数字/事实 | 说明 |
|---|---|---|
| 最终 FULL 夹具（宿主外 PS 5.1） | **PASS=184 / FAIL=0 / SKIP=1 / INFO=6** | 覆盖报告文件、native/grant 快路径、3000 文件吞吐 INFO |
| 最终 SANDBOX（PS 5.1 / pwsh 7 双宿主） | **PASS=140 / FAIL=0 / SKIP=8** | SKIP 为需要写标签/构造 DACL 的用例，属预期 |
| Scan 报告 | 每次 Scan 写 `<DataDir>\reports\scan-<timestamp>.json`，`result.reportPath` 指向它 | 报告含 depth/engine/root/rootLabel/scanned/hits/explicitCount/inheritedCount/truncated/scanMs/itemsScope/note/items/errors；`itemsScope`：quick=`explicit`、deep=`all`；items 上限 `MaxReportItems=50000`，超出 `truncated:true` |
| 导出 | Host 在 `reportPath` 存在时直接返回该路径；旧任务/报告写失败才回退 Host 写 `exports\low-integrity-*.json` | 不再把大清单二次经 Host 序列化 |
| 修复快路径 | 进程内 C# `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` 设标签（`methods.native`）；Access denied 且当前用户是 owner 时走进程内 DACL grant/还原并逐字符校验（`methods.grant`）；失败才回退 icacls 获取可读错误 | Repair 分层/快照/restore/最终验证语义不变；非命中对象不动 |
| 修复吞吐 INFO | `repair-fast-path-throughput`：grantFiles=**3000**、directFiles=**20**、hits=**3022**、repairWallMs≈**37.7s**、perGrantFileMs≈**12.56**、setupMs≈**4059** | 逐对象 icacls 进程已消除，但总时长仍由 Repair 的 3 遍 deep 扫描主导（初始扫描/复扫/最终验证） |

### 3.4 阶段 3：面板聚合 + 深度开关 + ETA（已实现，代码层验收）

| 项 | 结果 | 说明 |
|---|---|---|
| quick 聚合 | 结果显示「发现 N 个 Low 对象（X 显式 / Y 继承自父级）」；清单默认只列显式项，继承项给出聚合说明 | 文案 zh/en 同步；legacy 任务（无 depth）按 deep 展示兼容 |
| 深度开关 | 面板复选框「深度扫描（逐文件清单）」；开启后 `POST /jobs` 带 `depth:'deep'`，清单展示全部命中 | 关闭时默认 quick；运行中禁用切换 |
| 速率 + ETA | 运行中显示阶段、已扫描/总数、命中、扫描速率（项/秒）、预计剩余（total 已知时）、耗时、进度条；取消保持可用 | total 未知时显示「总项数未知」 |
| 导出/报告展示 | 导出返回 reportPath 并显示；未导出时也提前展示引擎报告路径；可复制 | Host snapshot 透传 `reportPath`/`depth`/`itemsScope`/`engine` |
| 代码检查 | `client.js` 约 3022 行；`node --check` / `npm run check` 通过 | Lead 2026-11-06 口径；真机交互仍需重启后复验 |

### 3.5 Node 测试结构（36 项）

| 文件 | 顶层用例数 | 覆盖 |
|---|---|---|
| `test/paths.test.mjs` | 15 | 路径规范化、黑名单、registry 解析、hint 回退、live agents |
| `test/jobs.test.mjs` | 11 | 任务状态机、取消/互斥、导出/日志、quick/deep 字段持久化 |
| `test/engine.test.mjs` | 6 | JSONL 解析、PowerShell argv（`-ScanDepth`）、`engineInvocation` 真实 argv 转发 |
| `test/routes.test.mjs` | 4 | health/diagnostics、同源、workspace、job 生命周期 |
| 合计 | **36** | 本轮文档任务未独立重跑 Node 测试，以阶段验收回归为准 |

---

## 4. 验证边界

### 4.1 已验证

- 功能闭环：真机 DSH 右侧栏完成扫描/导出/清除/复扫/日志；真实工作区清除后 0 命中、DACL 抽样一致。
- 引擎最终验收：FULL PASS=184 / FAIL=0 / SKIP=1 / INFO=6（宿主外 PS 5.1）；SANDBOX 双宿主 PASS=140 / FAIL=0 / SKIP=8。
- 阶段 1 性能：2000 文件 quick≈1.55s vs deep≈13.4s；122,575 项只读 quick≈38.8s（0.31 ms/项），旧 deep 对照≈406s。
- 阶段 2：Scan 报告文件与 `result.reportPath` 断言；Host 导出优先返回 reportPath；Repair `methods.native` > 0、`methods.grant` > 0、DACL 还原逐字符一致、复扫 0 命中；非命中 DACL 不变。
- 安全边界：同源拒绝、非注册工作区/黑名单路径拒绝、非 Windows 只读、引擎受限时 Repair 拒绝（Node 测试覆盖）。
- 阶段 3 代码：`client.js` 的 quick 聚合、deep 开关、速率/ETA、reportPath 展示已实现；`npm run check` 通过。

### 4.2 未验证 / 部分验证（不要写进用户文档当承诺）

| 项 | 状态 |
|---|---|
| deep 端到端真机验证 | **待 DSH 重启后执行**：UI 开关 → `depth:'deep'` → 引擎 `-ScanDepth deep` 全链路；确认 deep 清单/导出与 quick 聚合的差异 |
| 新版 UI 真机流程 | **待 DSH 重启后执行**：quick 聚合、切换深度、速率/ETA、reportPath 展示、清除闭环 |
| 大目录 Repair 总时长 | 未测 122k 级修复；3000 grant 文件吞吐为 37.7s 且由 3 遍 deep 扫描主导；真实十万级修复耗时应按这个瓶颈重新估算 |
| 122k 同构建 deep vs quick | 未做；deep 数字来自旧版本截图，不是同一构建对照 |
| 截断场景（`truncated`） | 引擎/夹具未构造超大命中集专门验证；报告 items 上限 50000、Host `MAX_ITEMS=50000` |
| 不可读对象 / 权限拒绝 / UNC 路径 | 未专门验证（夹具只有常规拒绝路径）；UNC 未经测试 |
| Host ↔ 真实引擎的自动化集成测试 | 未做；Node 测试用 fake engine，真机闭环是手工验证 |
| DSH 0.2.1 / 0.3+ 兼容 | 未验证；只在 **0.2.2-rc.1** 上验收过 |
| 市场安装 / 发布元数据 | 未做（无 marketplace 元数据、无 Release/CI） |
| `S-1-4` / Everyone 清理、CLI | 本期非目标/未实现（见 §5 P1） |

---

## 5. 待办清单

### P0（无）

三阶段均已完成，无代码级 P0 阻塞项。发布前只剩：**DSH 重启后的真机复核**（§4.2 前两项）与 **README 最终校对**（Lead，已基本同步本轮数字）。

### P1（后续增强）

| # | 事项 | 状态 | 说明/依赖 |
|---|---|---|---|
| P1-1 | **`S-1-4` / Everyone 拒绝 ACE 清理** | 未开始 | 本期只处理 Low 完整性标签；需要单独设计扫描口径/修复策略/回滚（见 [DECISIONS.md](DECISIONS.md) D1、D16） |
| P1-2 | **独立 CLI** | 未开始 | 引擎脚本可直接调用，但没有薄封装；建议等引擎参数/输出稳定后做（见 D9） |
| P1-3 | **CI** | 未开始 | 至少 Node 测试 + `npm run check`；FULL 夹具需要能写标签的 Windows 普通用户环境，CI 上大概率只能跑 SANDBOX 子集，需标注 |
| P1-4 | **市场元数据 / 发布** | 未开始 | 包名、版本、icon、locale 已有；缺 marketplace 描述/截图/发布流程与 tag |
| P1-5 | **i18n 扩展** | 已有 zh/en | 面板字典在 `client.js`，`locale/` 只有管理器展示文案；新增语言需同步两份字典 |
| P1-6 | **Config schema** | 未开始 | 目前无 `Config`（跳过目录、扫描上限、DataDir 由 Host 传）。若开放给用户配置，需定义 schema 与安全边界 |
| P1-7 | **Repair 扫描切 C#** | 未开始 | 当前 Repair 仍有 3 遍 PowerShell deep 遍历（初始扫描/复扫/最终验证），是大目录修复的主要耗时；迁移后需重测吞吐与 DACL 语义 |
| P1-8 | **quick 扫描 GetAce 直读** | 未开始 | 当前 122k quick≈38.8s（0.31 ms/项）；计划用 `GetSecurityDescriptorSacl` + `GetAce` 直接读 ACE、减少 SDDL 转换，再评估收益/风险 |

### 依赖关系

```
真机复核（deep/UI，重启后）──> 可宣布发布候选
P1-7（Repair 扫描切 C#）   独立，优先于大目录修复性能结论
P1-8（quick GetAce）       独立，依赖 stage 1 扫描基线
CI（P1-3）                 依赖测试稳定与 FULL 环境策略
市场发布（P1-4）           依赖真机复核 + 数字定稿
i18n（P1-5）/ Config（P1-6）    低优先级，可并行
S-1-4（P1-1）/ CLI（P1-2） 独立，设计先行
```

---

## 6. 下一步建议（按顺序）

1. **Lead：重启 DSH 后做真机复核**——quick 聚合、深度开关（deep 清单/导出）、速率/ETA、reportPath 展示、扫描→清除→复扫闭环；如发现问题回填 HANDOFF/缺陷任务。
2. **README 最终校对（Lead）**：确认最终验收数字与真机行为一致（README 已由 Lead 更新，避免与 HANDOFF/AGENTS 漂移）。
3. **P1-7/P1-8 性能收尾**：Repair 扫描切 C#（当前大目录修复总时长的瓶颈）；quick 扫描 GetAce 直读（目标向 10–30s 靠近）。
4. **P1-1/P1-2**：`S-1-4` 清理设计（先定义扫描口径、风险与回滚）；CLI 薄封装（引擎协议稳定后）。
5. **P1-3~P1-6**：CI、市场元数据、i18n、Config；建议在真机复核与发布定稿后推进。

---

## 7. 具体交接事项 / 注意事项

- **工作树未提交**：本轮所有改动（含 README、client、engine、docs）仍在工作树；不要假设已 commit / 已发布，也不要擅自 `git commit` / `git push`（未获明确指令时）。
- **文件归属**：`engine/` 与 `test/run-fixtures.ps1` 归引擎侧（task-3/4）；`lib/*.js`、`index.js` 归 Host；`client.js` 归 UI（task-5）；`README.md` 由 Lead 维护；本三份文档是交接材料。多 agent 共用同一文件系统，改前看任务板 write scope。
- **FULL 夹具只能在 DSH 工具沙箱外跑**：DSH 工具进程是 Low 完整性，夹具会自动进入 SANDBOX 模式并大量 SKIP，那不是引擎失败。
- **不要对用户真实工作区做 Repair**：真实大目录只可只读扫描且需授权；所有修复类验证用 `%TEMP%\dsh-low-integrity-tests\` 夹具或测试工作区。
- **数字口径**：wall time 与 `scanMs` 不同（进程启动、Add-Type、JSONL 输出都计入 wall）；quick 的 `scanMs` 只计 C# 扫描；旧 deep 数字来自旧版本截图；Repair 总时长含 3 遍 deep 扫描，不要用 native 单对象耗时推算大目录总时长。
- **deep/UI 复核前置**：Host JS 与 `client.js` 的改动必须重启 DSH 才生效；引擎脚本每次任务重读，不需要重启。真机复核前先确认 DSH 已重启并加载新 bundle 代码。
- **文档一致性**：README 已由 Lead 按本轮数字更新；`AGENTS.md` / `HANDOFF.md` / `DECISIONS.md` 以本文件 §3 为数字口径。若后续阶段再调整，先更新 HANDOFF 的「阶段/日期/验证边界」，再同步 README 与 AGENTS 中的数字段。
- **数据目录**：`%DSH_HOME%\low-integrity-check\` 下现有 `reports\`（引擎报告）、`snapshots\`（标签快照+restore 脚本）、`exports\`（旧版导出后备）、`logs\`（失败日志）；排查真机问题时优先看这些产物与 `/health`、`/diagnostics`。
