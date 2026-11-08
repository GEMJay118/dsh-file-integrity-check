/**
 * dsh-low-integrity-check 的浏览器半侧：把「文件完整性检查」注册成 DSH 右侧栏的一种标签页。
 *
 * 结构：
 * - 模块包装：window.__ModuleLoader__.load({ id, factory })；factory 内只 require('react')，
 *   用 React.createElement，不写 JSX、不 require 任何平台 UI 包。
 * - 注册：照抄 dsh-pet 的成熟写法——软取 sidebarRightTabs 注册标签类型（服务缺失时
 *   20 × 250ms 有界重试后 console.warn 退出，绝不抛错），正文通过
 *   ctx.slots.inject('sidebar.right.pane.tab') 挂到对应 key 上。
 * - 面板：解析工作区 → 扫描 → 命中清单分页 → 导出清单 → 一键清除（确认条）→
 *   运行中 800ms 轮询 → 成功/失败结果；sessionId 取 slot props，切换会话
 *   重置并从 sessionStorage['dsh-fi:' + sessionId] 恢复任务。
 * - 设置页：注册到「设置」的 settings.section，读取/保存产物目录与自动清理保留天数
 *   （GET/POST /settings），并展示上次清理结果；面板底部同时展示当前产物目录（来自 /health）。
 * - 会话行紫点：注册 sidebar.session.row.leading occupant；本会话任务结束后显示紫色圆点，
 *   点击会话行即清除（sessionStorage 记录已读 jobId）。
 *
 * Host API 契约（与本文件并行实现的宿主半侧）：
 *   GET  /health                                   → { ok, version, platform, engine, registry, warnings,
 *                                                      dataDir, defaultDataDir, dataDirError }
 *   GET  /diagnostics                              → 诊断对象（本面板不展示，供阶段 0 排查）
 *   GET  /settings                                 → { ok, dataDir, defaultDataDir, isDefault, error,
 *                                                      retentionDays, retentionPresets,
 *                                                      lastCleanup: { at, cutoff, deletedCount, freedBytes, error } | null }
 *   POST /settings { dataDir?, retentionDays? }    → { ok, dataDir, defaultDataDir, isDefault, retentionDays }；
 *                                                     dataDir 传 '' 恢复默认；retentionDays 为 1..3650 的整数；
 *                                                     两个字段都可选、至少一个；失败码见 KNOWN_ERROR_CODES
 *   POST /workspace { sessionId }                  → { ok, workspace, sessionCount, liveAgentCount, warnings }
 *   POST /jobs { action: 'scan'|'repair', sessionId } → { ok, jobId }
 *   GET  /jobs/:id                                 → { ok, job }
 *   GET  /jobs/:id/items?offset=&limit=            → { ok, jobId, offset, limit, total, items }
 *   POST /jobs/:id/cancel | /export                → { ok } / { ok, path }
 * 所有请求都相对于「文档挂载前缀 + ROUTE_SEGMENT」；ROUTE_SEGMENT 必须与宿主
 * ctx.webServer.register 的 path 一致。
 *
 * 颜色只取 --dsw-alias-* token；样式自注入 style 标签到 document.head 并按引用计数清理。
 */
(function () {
  'use strict';

  //#region 常量

  /** 标签实现身份；同时也是标签类型 id 与正文/标题插槽的 key。 */
  var TAB_ID = 'dsh-low-integrity-check';
  /** 标签类型；openTab 按它打开。 */
  var TAB_KIND = 'low-integrity';
  /** locale 字典命名空间。 */
  var NS = 'file-integrity';
  /**
   * 宿主 HTTP 路由段。
   *
   * 必须与宿主半侧 ctx.webServer.register({ kind: 'prefix', path }) 的 path 完全一致
   * （Host 已实现为 '/dsh-low-integrity-check'）；浏览器实际请求地址 =
   * mountPrefixOf(document.baseURI) + 本值（见 routeBaseOf）。
   */
  var ROUTE_SEGMENT = '/dsh-low-integrity-check';
  /** 会话级任务恢复的 sessionStorage 键前缀。 */
  var STORAGE_PREFIX = 'dsh-fi:';
  /** 会话行紫点的「已读」标记键前缀（值为已读到的 jobId）。 */
  var ACK_PREFIX = 'dsh-fi-ack:';
  /** 会话行未读状态的轮询间隔（毫秒）。 */
  var UNREAD_POLL_MS = 2500;
  /** 运行中任务轮询间隔（毫秒）。 */
  var POLL_INTERVAL_MS = 800;
  /** 命中清单每页条数（首屏与「加载更多」一致）。 */
  var PAGE_SIZE = 200;
  /** 右侧栏服务缺失时的有界重试次数与间隔。 */
  var SIDEBAR_RETRY_TRIES = 20;
  var SIDEBAR_RETRY_DELAY_MS = 250;
  /** 复制成功/失败提示的停留时间。 */
  var NOTICE_MS = 2600;
  /** 自动清理保留天数的预设选项（Host 也会返回；缺失/非法时用这里兜底）。 */
  var RETENTION_PRESETS = [3, 7, 15, 30];
  /** 保留天数允许范围与默认值（与 Host 校验保持一致）。 */
  var RETENTION_MIN_DAYS = 1;
  var RETENTION_MAX_DAYS = 3650;
  var RETENTION_DEFAULT_DAYS = 30;
  /** 样式标签归属标记。 */
  var STYLE_KEY = 'dsh-file-integrity-panel';
  /** 宿主 task/failure 列表最多展示条数（再多只给计数）。 */
  var MAX_FAILURE_ROWS = 100;
  /** 日志前缀；所有 console 输出统一带它，便于在页面控制台里筛。 */
  var LOG_PREFIX = '[dsh-low-integrity-check]';

  /** 宿主错误码 → 本地化文案键的映射（未列出的码走 error.generic）。 */
  var KNOWN_ERROR_CODES = {
    'workspace-not-found': true,
    'path-rejected': true,
    busy: true,
    'unsupported-platform': true,
    'engine-sandboxed': true,
    'job-not-found': true,
    'invalid-request': true,
    'engine-unavailable': true,
    'snapshot-not-found': true,
    'open-folder-failed': true,
    'settings-invalid': true,
    'settings-unwritable': true,
    'settings-unavailable': true,
    'data-dir-inside-workspace': true,
    forbidden: true,
    'internal-error': true,
    'network-error': true,
    'bad-response': true,
    'no-session': true,
    'no-report': true,
  };

  //#endregion

  //#region 文案

  /** 中文文案（键集真源；en 与它逐键对应）。 */
  var ZH = {
    'tab.title': '文件完整性检查',
    'tab.description': '检查工作区中完整性标签为 Low 的文件与目录，并可一键清除。',
    'header.subtitle': 'Low 完整性标签检查与清除',

    'session.unreadTitle': '文件完整性检查任务已完成（未读）',
    'session.unreadHint': '点击会话行标记为已读',

    'badge.readonly': '只读',
    'badge.running': '运行中',

    'workspace.label': '工作区',
    'workspace.pathEmpty': '尚未解析到工作区路径',
    'workspace.sessionCount': '会话 {count}',
    'workspace.liveAgents': '活跃会话 {count}',
    'workspace.riskLive': '有 {count} 个活跃会话：清除后这些文件可能被重新写入 Low 完整性标签。',
    'workspace.warnings': '工作区有 {count} 条提示',

    'action.resolve': '解析工作区',
    'action.retry': '重试',
    'action.scan': '开始扫描',
    'action.rescan': '重新扫描',
    'action.export': '导出清单',
    'action.repair': '一键清除',
    'action.cancel': '取消任务',
    'action.cancelling': '正在取消…',
    'action.confirm': '确认清除',
    'action.dismiss': '取消',
    'action.loadMore': '加载更多',
    'action.copy': '复制',

    'loading.workspace': '正在解析工作区…',
    'loading.job': '正在恢复任务…',
    'loading.items': '正在加载…',

    'readonly.banner': '当前平台（{platform}）不支持修改完整性标签：面板处于只读模式，操作已禁用。',
    'engine.unavailable': '完整性引擎不可用（{reason}），扫描与清除已禁用。',
    'engine.restricted': '完整性引擎受限（当前级别 {integrity}）：无法写回 Medium 完整性标签，清除已禁用。',
    'health.error': '无法读取宿主状态：{message}',
    'health.version': '宿主 {version}',
    'health.platform': '平台 {platform}',
    'health.warnings': '宿主提示 {count} 条：{first}',
    'health.bad': '宿主状态响应不完整（缺少平台信息）。',
    'poll.failed': '状态刷新失败：{message}',
    'footer.engine': '引擎 {integrity}',
    'footer.registry': '注册表 {count}',

    'intro.hint': '尚未扫描：先解析工作区，再开始扫描。',

    'scan.depth.label': '深度扫描（逐文件清单）',
    'scan.depth.hint': '关闭时使用快速扫描：只列出显式 Low 项，继承项聚合显示。',
    'scan.depth.quick': '快速模式',
    'scan.depth.deep': '深度模式',
    'scan.engine.csharp': 'C# 引擎',
    'scan.engine.powershell': 'PowerShell 引擎',

    'job.running': '正在{action}…',
    'job.scanned': '已扫描 {scanned} / {total}',
    'job.hits': '命中 {count}',
    'job.elapsed': '耗时 {duration}',
    'job.rate': '扫描速率',
    'job.rateValue': '{rate} 项/秒',
    'job.rateEmpty': '—',
    'job.eta': '预计剩余',
    'job.etaValue': '约 {duration}',
    'job.etaCalculating': '计算中…',
    'job.etaUnknown': '总项数未知',
    'job.cancelled': '任务已取消',
    'job.expired': '任务已失效，请重新检查',

    'phase.starting': '准备中',
    'phase.enumerate': '枚举目录',
    'phase.read': '读取标签',
    'phase.repair': '修复标签',
    'phase.verify': '复扫验证',
    'phase.other': '阶段：{phase}',
    'phase.waiting': '等待进度…',

    'action.label.scan': '扫描',
    'action.label.repair': '清除',

    'scan.result.none': '未发现 Low 完整性标签',
    'scan.result.aggregate': '发现 {count} 个 Low 对象（{explicit} 显式 / {inherited} 继承自父级）',
    'scan.result.meta': '扫描 {scanned} 项 · 耗时 {duration}',
    'scan.result.root': '根目录 {rootLabel}',
    'scan.inherited.quick': '{count} 项继承 Low 由 {parents} 个已发现的显式父级目录导致；修复父级后可能自动恢复（快速模式不逐行列出）。',
    'scan.inherited.quickPlain': '{count} 项继承 Low（继承自父级目录）；修复父级后可能自动恢复（快速模式不逐行列出）。',
    'scan.inherited.deep': '{count} 项继承 Low 已包含在下方清单中。',
    'scan.legacy': '该任务未记录扫描模式，按深度模式（全部命中）展示。',
    'scan.truncated': '命中项过多，清单可能被截断（仅保留宿主上限内的条目）。',
    'scan.failed': '扫描失败',
    'scan.startFailed': '无法启动扫描：{message}',

    'hits.title': '命中清单',
    'hits.badge.mode.quick': '仅显式项',
    'hits.badge.mode.all': '全部命中',
    'hits.quickNote': '另有 {count} 项继承 Low 未逐行列出（见上方聚合说明）。',
    'hits.empty': '没有命中项',
    'hits.shown': '已显示 {shown} / {total}',
    'hits.more': '还有 {count} 条未加载',
    'hits.loadFailed': '清单加载失败：{message}',
    'hits.kind.file': '文件',
    'hits.kind.dir': '目录',
    'hits.badge.explicit': '显式',
    'hits.badge.inherited': '继承',
    'hits.copyPath': '复制完整路径',

    'repair.confirm.title': '确认清除这些 Low 完整性标签？',
    'repair.confirm.count': '预计修复 {count} 项',
    'repair.confirm.backup': '清除前会生成快照 JSON 与 restore 恢复脚本，完成后可复制路径。',
    'repair.confirm.risk': '当前有 {count} 个 workspace-write 活跃会话；清除后这些文件可能被重新写入 Low 完整性标签。',
    'repair.confirm.engineLimited': '引擎受限：当前进程可能无法写回 Medium 完整性标签。',
    'repair.success': '清除成功（{count} 项）',
    'repair.failed': '清除失败（{count} 项失败）',
    'repair.partialFixed': '已修复 {count} 项',
    'repair.rescan.none': '复扫未发现 Low 完整性标签',
    'repair.rescan.found': '复扫仍发现 {count} 个 Low 完整性对象',
    'repair.snapshot': '快照文件',
    'repair.restore': '恢复文件',
    'repair.openFolder': '打开文件夹',
    'repair.openingFolder': '正在打开…',
    'repair.pathMissing': '宿主未返回路径',
    'repair.failures': '失败列表',
    'repair.failuresMore': '另有 {count} 条失败未显示',
    'repair.startFailed': '无法启动清除：{message}',

    'artifact.export': '清单文件',
    'artifact.report': '引擎报告',
    'artifact.copy': '复制路径',
    'export.ok': '清单已导出',
    'export.failed': '导出失败：{message}',

    'notice.copied': '已复制',
    'notice.copyFailed': '复制失败，请手动选择文本复制',

    'settings.sectionTitle': '文件完整性检查',
    'settings.title': '文件完整性检查',
    'settings.description': '设置清单、引擎报告、快照与恢复脚本等产物文件的存放目录。',
    'settings.current': '当前产物目录',
    'settings.currentEmpty': '尚未配置，当前使用默认目录',
    'settings.inputLabel': '修改为',
    'settings.placeholder': '留空使用默认目录',
    'settings.defaultHint': '默认目录：{path}',
    'settings.applyHint': '保存后从下一次检查/清除开始生效。',
    'settings.loading': '正在读取设置…',
    'settings.loadFailed': '无法读取设置：{message}',
    'settings.saved': '已保存，下次检查/清除生效',
    'settings.resetDone': '已恢复默认目录，下次检查/清除生效',
    'settings.pickFailed': '选择文件夹失败：{message}',
    'settings.pickUnavailable': '当前环境不支持选择文件夹，请手动输入路径',
    'action.pickFolder': '选择文件夹…',
    'action.save': '保存',
    'action.saving': '保存中…',
    'action.resetDefault': '恢复默认',

    'settings.retention.title': '自动清理',
    'settings.retention.current': '当前保留天数：{days} 天',
    'settings.retention.label': '保留天数',
    'settings.retention.option': '{days} 天',
    'settings.retention.custom': '自定义',
    'settings.retention.customLabel': '自定义天数（1–3650）',
    'settings.retention.invalid': '请输入 1–3650 之间的整数天数',
    'settings.retention.scopeHint': '自动清理只删除本插件生成的 reports/snapshots 文件（严格命名匹配），不会动其他文件。',
    'settings.retention.lastTitle': '上次清理',
    'settings.retention.never': '尚未清理',
    'settings.retention.lastAt': '时间：{time}',
    'settings.retention.lastCount': '删除 {count} 个文件，释放 {size}',
    'settings.retention.lastError': '上次清理出错：{message}',

    'dataDir.panelValue': '产物目录：{path}',
    'dataDir.panelHint': '可在「设置 → 文件完整性检查」中修改',
    'dataDir.error': '产物目录不可用：{message}',

    'error.workspace-not-found': '未找到当前会话的工作区，请先打开一个工作区',
    'error.path-rejected': '工作区路径被拒绝（可能超出允许范围）',
    'error.busy': '已有任务正在运行，请稍后再试',
    'error.unsupported-platform': '当前平台不支持该操作',
    'error.engine-sandboxed': '完整性引擎在当前沙箱环境中不可用',
    'error.engine-unavailable': '完整性引擎不可用或受限',
    'error.job-not-found': '任务已失效，请重新检查',
    'error.invalid-request': '请求参数无效',
    'error.snapshot-not-found': '没有可打开的快照文件',
    'error.open-folder-failed': '打开文件夹失败',
    'error.settings-invalid': '产物目录无效（需要绝对路径，且不能是工作区内的目录）',
    'error.settings-unwritable': '产物目录不可写，请换一个目录',
    'error.settings-unavailable': '宿主不支持保存设置（设置服务不可用）',
    'error.data-dir-inside-workspace': '产物目录不能放在工作区内',
    'error.forbidden': '没有权限执行该操作',
    'error.internal-error': '宿主内部错误',
    'error.network-error': '无法连接宿主服务',
    'error.bad-response': '宿主返回了无效响应',
    'error.no-session': '没有可用的会话信息，无法检查工作区',
    'error.no-report': '没有可导出的引擎报告（未命中或报告写入失败）',
    'error.generic': '操作失败：{message}',
    'error.boundary': '面板渲染出错，已降级显示。',
  };

  /** 英文字典：与 ZH 逐键对应。 */
  var EN = {
    'tab.title': 'File integrity check',
    'tab.description': 'Inspect files and directories whose integrity label is Low in the workspace, and clear them in one click.',
    'header.subtitle': 'Low integrity label inspection and repair',

    'session.unreadTitle': 'File integrity check finished (unread)',
    'session.unreadHint': 'Click the session row to mark it read',

    'badge.readonly': 'Read-only',
    'badge.running': 'Running',

    'workspace.label': 'Workspace',
    'workspace.pathEmpty': 'Workspace path not resolved yet',
    'workspace.sessionCount': 'Sessions {count}',
    'workspace.liveAgents': 'Live sessions {count}',
    'workspace.riskLive': '{count} live sessions: files may be rewritten with the Low label after cleanup.',
    'workspace.warnings': 'Workspace has {count} warnings',

    'action.resolve': 'Resolve workspace',
    'action.retry': 'Retry',
    'action.scan': 'Start scan',
    'action.rescan': 'Rescan',
    'action.export': 'Export list',
    'action.repair': 'Clear all',
    'action.cancel': 'Cancel job',
    'action.cancelling': 'Cancelling…',
    'action.confirm': 'Confirm clear',
    'action.dismiss': 'Cancel',
    'action.loadMore': 'Load more',
    'action.copy': 'Copy',

    'loading.workspace': 'Resolving workspace…',
    'loading.job': 'Restoring job…',
    'loading.items': 'Loading…',

    'readonly.banner': 'This platform ({platform}) cannot modify integrity labels: the panel is read-only and actions are disabled.',
    'engine.unavailable': 'Integrity engine unavailable ({reason}); scan and clear are disabled.',
    'engine.restricted': 'Integrity engine restricted (current level {integrity}): cannot write the Medium label back; clear is disabled.',
    'health.error': 'Cannot read host status: {message}',
    'health.version': 'Host {version}',
    'health.platform': 'Platform {platform}',
    'health.warnings': 'Host warnings ({count}): {first}',
    'health.bad': 'Host status response is incomplete (missing platform).',
    'poll.failed': 'Status refresh failed: {message}',
    'footer.engine': 'Engine {integrity}',
    'footer.registry': 'Registry {count}',

    'intro.hint': 'Not scanned yet: resolve the workspace, then start a scan.',

    'scan.depth.label': 'Deep scan (per-file list)',
    'scan.depth.hint': 'When off, quick scan lists only explicit Low objects and aggregates inherited ones.',
    'scan.depth.quick': 'Quick mode',
    'scan.depth.deep': 'Deep mode',
    'scan.engine.csharp': 'C# engine',
    'scan.engine.powershell': 'PowerShell engine',

    'job.running': '{action} in progress…',
    'job.scanned': 'Scanned {scanned} / {total}',
    'job.hits': 'Hits {count}',
    'job.elapsed': 'Elapsed {duration}',
    'job.rate': 'Scan rate',
    'job.rateValue': '{rate} items/s',
    'job.rateEmpty': '—',
    'job.eta': 'ETA',
    'job.etaValue': '~{duration}',
    'job.etaCalculating': 'calculating…',
    'job.etaUnknown': 'total unknown',
    'job.cancelled': 'Job cancelled',
    'job.expired': 'Job expired, please check again',

    'phase.starting': 'Starting',
    'phase.enumerate': 'Enumerating',
    'phase.read': 'Reading labels',
    'phase.repair': 'Repairing',
    'phase.verify': 'Verifying',
    'phase.other': 'Phase: {phase}',
    'phase.waiting': 'Waiting for progress…',

    'action.label.scan': 'Scan',
    'action.label.repair': 'Clear',

    'scan.result.none': 'No Low integrity labels found',
    'scan.result.aggregate': 'Found {count} Low objects ({explicit} explicit / {inherited} inherited from parents)',
    'scan.result.meta': 'Scanned {scanned} items · {duration}',
    'scan.result.root': 'Root {rootLabel}',
    'scan.inherited.quick': '{count} inherited Low items come from {parents} discovered explicit parent directories; they may recover when the parents are cleared (quick mode does not list them).',
    'scan.inherited.quickPlain': '{count} inherited Low items (inherited from parent directories); they may recover when the parents are cleared (quick mode does not list them).',
    'scan.inherited.deep': '{count} inherited Low items are included in the list below.',
    'scan.legacy': 'This job recorded no scan mode; it is shown as deep mode (all hits).',
    'scan.truncated': 'Too many hits; the list may be truncated (only entries within the host limit are kept).',
    'scan.failed': 'Scan failed',
    'scan.startFailed': 'Cannot start scan: {message}',

    'hits.title': 'Hit list',
    'hits.badge.mode.quick': 'Explicit only',
    'hits.badge.mode.all': 'All hits',
    'hits.quickNote': '{count} inherited Low items are not listed (see the aggregate above).',
    'hits.empty': 'No hits',
    'hits.shown': 'Showing {shown} / {total}',
    'hits.more': '{count} more not loaded',
    'hits.loadFailed': 'Cannot load list: {message}',
    'hits.kind.file': 'File',
    'hits.kind.dir': 'Directory',
    'hits.badge.explicit': 'Explicit',
    'hits.badge.inherited': 'Inherited',
    'hits.copyPath': 'Copy full path',

    'repair.confirm.title': 'Clear these Low integrity labels?',
    'repair.confirm.count': 'Expected to repair {count} items',
    'repair.confirm.backup': 'A snapshot JSON and a restore script are written before clearing; copy their paths afterwards.',
    'repair.confirm.risk': '{count} workspace-write live sessions may rewrite these files with the Low label after cleanup.',
    'repair.confirm.engineLimited': 'Engine restricted: this process may be unable to write the Medium integrity label back.',
    'repair.success': 'Cleared successfully ({count} items)',
    'repair.failed': 'Clear failed ({count} items failed)',
    'repair.partialFixed': 'Repaired {count} items',
    'repair.rescan.none': 'Rescan found no Low integrity labels',
    'repair.rescan.found': 'Rescan still finds {count} Low integrity objects',
    'repair.snapshot': 'Snapshot file',
    'repair.restore': 'Restore file',
    'repair.openFolder': 'Open folder',
    'repair.openingFolder': 'Opening…',
    'repair.pathMissing': 'Host did not report a path',
    'repair.failures': 'Failures',
    'repair.failuresMore': '{count} more failures not shown',
    'repair.startFailed': 'Cannot start clear: {message}',

    'artifact.export': 'List file',
    'artifact.report': 'Engine report',
    'artifact.copy': 'Copy path',
    'export.ok': 'List exported',
    'export.failed': 'Export failed: {message}',

    'notice.copied': 'Copied',
    'notice.copyFailed': 'Copy failed; select the text and copy manually',

    'settings.sectionTitle': 'File integrity check',
    'settings.title': 'File integrity check',
    'settings.description': 'Choose where list files, engine reports, snapshots and restore scripts are written.',
    'settings.current': 'Current artifact directory',
    'settings.currentEmpty': 'Not configured yet; the default directory is in use',
    'settings.inputLabel': 'Change to',
    'settings.placeholder': 'Leave empty to use the default directory',
    'settings.defaultHint': 'Default directory: {path}',
    'settings.applyHint': 'Takes effect from the next check/clear.',
    'settings.loading': 'Reading settings…',
    'settings.loadFailed': 'Cannot read settings: {message}',
    'settings.saved': 'Saved; applies to the next check/clear',
    'settings.resetDone': 'Default directory restored; applies to the next check/clear',
    'settings.pickFailed': 'Could not pick a folder: {message}',
    'settings.pickUnavailable': 'Folder picking is unavailable here; enter the path manually',
    'action.pickFolder': 'Choose folder…',
    'action.save': 'Save',
    'action.saving': 'Saving…',
    'action.resetDefault': 'Restore default',

    'settings.retention.title': 'Auto cleanup',
    'settings.retention.current': 'Current retention: {days} days',
    'settings.retention.label': 'Retention',
    'settings.retention.option': '{days} d',
    'settings.retention.custom': 'Custom',
    'settings.retention.customLabel': 'Custom days (1–3650)',
    'settings.retention.invalid': 'Enter an integer between 1 and 3650',
    'settings.retention.scopeHint': 'Auto cleanup only removes files this plugin wrote under reports/snapshots (strict name match); other files are never touched.',
    'settings.retention.lastTitle': 'Last cleanup',
    'settings.retention.never': 'No cleanup yet',
    'settings.retention.lastAt': 'Time: {time}',
    'settings.retention.lastCount': 'Removed {count} files, freed {size}',
    'settings.retention.lastError': 'Last cleanup failed: {message}',

    'dataDir.panelValue': 'Artifact directory: {path}',
    'dataDir.panelHint': 'Change it under Settings → File integrity check',
    'dataDir.error': 'Artifact directory unavailable: {message}',

    'error.workspace-not-found': 'No workspace found for this session; open a workspace first',
    'error.path-rejected': 'Workspace path rejected (possibly out of the allowed range)',
    'error.busy': 'Another job is running; try again later',
    'error.unsupported-platform': 'This operation is not supported on the current platform',
    'error.engine-sandboxed': 'The integrity engine is unavailable in the current sandbox',
    'error.engine-unavailable': 'The integrity engine is unavailable or restricted',
    'error.job-not-found': 'Job expired, please check again',
    'error.invalid-request': 'Invalid request parameters',
    'error.snapshot-not-found': 'No snapshot file to open',
    'error.open-folder-failed': 'Could not open the folder',
    'error.settings-invalid': 'Invalid artifact directory (needs an absolute path outside the workspace)',
    'error.settings-unwritable': 'The artifact directory is not writable; choose another one',
    'error.settings-unavailable': 'The host cannot save settings (settings service unavailable)',
    'error.data-dir-inside-workspace': 'The artifact directory cannot be inside the workspace',
    'error.forbidden': 'Not allowed to perform this action',
    'error.internal-error': 'Host internal error',
    'error.network-error': 'Cannot reach the host service',
    'error.bad-response': 'The host returned an invalid response',
    'error.no-session': 'No session information; cannot inspect the workspace',
    'error.no-report': 'No engine report to export (no hits, or the report write failed)',
    'error.generic': 'Operation failed: {message}',
    'error.boundary': 'The panel crashed and was degraded.',
  };

  /** 整包交给 ctx.locale.register；宿主按当前语言取，缺失回退 en。 */
  var DICTS = { zh: ZH, en: EN };

  //#endregion

  //#region 样式（只写结构与 token，不写字面色值）

  /** 面板样式：选择器前缀 fi-，避免与 DSH 或其它插件撞名。 */
  var PANEL_CSS = [
    '.fi-panel{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:12px;overflow-y:auto;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);}',
    '.fi-fatal-holder{display:contents;}',
    '.fi-fatal{display:flex;flex-direction:column;gap:10px;align-items:flex-start;justify-content:center;height:100%;}',
    '.fi-fatal-title{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-s-14);}',
    '.fi-head{display:flex;align-items:flex-start;gap:8px;flex:0 0 auto;}',
    '.fi-head-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
    '.fi-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary);}',
    '.fi-sub{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);}',
    '.fi-card{display:flex;flex-direction:column;gap:6px;flex:0 0 auto;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);}',
    '.fi-card-danger{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);}',
    '.fi-label{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12);}',
    '.fi-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
    '.fi-col{display:flex;flex-direction:column;gap:2px;min-width:0;}',
    '.fi-spacer{flex:1 1 auto;}',
    '.fi-path{display:block;min-width:0;word-break:break-all;white-space:pre-wrap;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);font-family:var(--dsw-font-markdown-code-font-family,monospace);}',
    '.fi-muted{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);}',
    '.fi-warn-text{color:var(--dsw-alias-state-warn-label);font:var(--dsw-font-xxs-12);}',
    '.fi-error-text{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);}',
    '.fi-success-text{color:var(--dsw-alias-state-success-primary);font:var(--dsw-font-xxs-12);}',
    '.fi-btn{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 10px;font:var(--dsw-font-xxs-12);cursor:pointer;}',
    '.fi-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
    '.fi-btn:disabled{opacity:.45;cursor:default;}',
    '.fi-btn-small{padding:2px 7px;font:var(--dsw-font-xxxs-11);}',
    '.fi-btn-primary{border:none;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);}',
    '.fi-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);}',
    '.fi-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
    '.fi-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);}',
    '.fi-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:0 0 auto;}',
    '.fi-badge{flex:0 0 auto;border-radius:var(--dsw-radius-xs);padding:0 6px;background:var(--dsw-alias-bg-multi-select);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11);}',
    '.fi-badge-warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);}',
    '.fi-badge-error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}',
    '.fi-badge-success{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);}',
    '.fi-banners{display:flex;flex-direction:column;gap:6px;flex:0 0 auto;}',
    '.fi-banner{border-radius:var(--dsw-radius-md);padding:8px 10px;font:var(--dsw-font-xxs-12);}',
    '.fi-banner-title{font:var(--dsw-font-xxs-strong-12);}',
    '.fi-banner-text{margin-top:2px;word-break:break-word;}',
    '.fi-banner-info{background:var(--dsw-alias-bg-multi-select);color:var(--dsw-alias-label-secondary);}',
    '.fi-banner-warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);}',
    '.fi-banner-error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}',
    '.fi-banner-success{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);}',
    '.fi-progress-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-skeleton);overflow:hidden;flex:0 0 auto;}',
    '.fi-progress-fill{height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary);transition:width .2s linear;}',
    '.fi-kv{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);}',
    '.fi-kv-value{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);}',
    '.fi-hits{display:flex;flex-direction:column;gap:2px;flex:0 0 auto;max-height:45vh;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:6px;}',
    '.fi-hit{display:flex;align-items:flex-start;gap:6px;padding:4px 6px;border-radius:var(--dsw-radius-sm);}',
    '.fi-hit:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '.fi-hit-path{flex:1 1 auto;min-width:0;word-break:break-all;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);font-family:var(--dsw-font-markdown-code-font-family,monospace);}',
    '.fi-list{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;max-height:30vh;overflow-y:auto;}',
    '.fi-failure{display:flex;flex-direction:column;gap:1px;padding:4px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover-danger);}',
    '.fi-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);}',
    '.fi-toggle input{accent-color:var(--dsw-alias-state-business-primary);cursor:inherit;}',
    '.fi-toggle.is-disabled{cursor:default;opacity:.6;}',
    '.fi-footer{display:flex;flex-direction:column;gap:2px;flex:0 0 auto;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2);}',
    '.fi-settings{display:flex;flex-direction:column;gap:10px;min-width:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);}',
    '.fi-settings-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);padding:6px 8px;font:var(--dsw-font-xxs-12);font-family:var(--dsw-font-markdown-code-font-family,monospace);}',
    '.fi-settings-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
    '.fi-settings-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);}',
    '.fi-settings-input:disabled{opacity:.6;}',
    '.fi-settings-number{width:120px;}',
    '.fi-seg{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}',
    '.fi-session-leading{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;}',
    '.fi-session-dot{display:block;width:8px;height:8px;box-sizing:border-box;border-radius:999px;flex:none;}',
    '.fi-session-dot-idle{border:1.5px solid var(--dsw-alias-state-idle-primary);background:transparent;}',
    '.fi-session-dot-unread{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-error-primary) 45%);}',
  ].join('\n');

  /** 当前挂载数：多个面板可能同时挂载，靠引用计数决定何时移除 style 标签。 */
  var mountedCss = 0;
  /** 已注入的 style 元素（第一个挂载时创建）。 */
  var styleTag = null;

  /**
   * 注入面板样式（幂等，按引用计数释放）。
   *
   * @returns 释放函数：最后一次释放时才移除 style 标签；重复调用安全。
   */
  function injectPanelCss() {
    if (typeof document === 'undefined' || !document.head) return function () {};
    mountedCss += 1;
    if (styleTag === null) {
      var tag = document.createElement('style');
      tag.setAttribute('data-dsh-fi-css', STYLE_KEY);
      tag.textContent = PANEL_CSS;
      document.head.appendChild(tag);
      styleTag = tag;
    }
    var released = false;
    return function () {
      if (released) return;
      released = true;
      mountedCss -= 1;
      if (mountedCss <= 0 && styleTag !== null) {
        styleTag.remove();
        styleTag = null;
        mountedCss = 0;
      }
    };
  }

  //#endregion

  //#region 地址与请求

  /**
   * 从文档基准地址取出挂载前缀（baseURI 的目录部分）。
   *
   * dsh 返回 index 时会在页面里注入一个指向 `./` 的 base 标签，baseURI 因此正是
   * 「宿主提供 UI 的那个目录」，也是浏览器解析相对请求的基准；反代/应用网关把 UI
   * 挂在子路径下时，缺的就是这一段前缀。
   *
   * @param baseURI - 文档基准地址；缺省或非 http(s) 时按无前缀处理。
   * @returns 去掉尾部斜杠的目录部分；空串、非法地址一律 ''，且不抛异常。
   */
  function mountPrefixOf(baseURI) {
    if (baseURI === undefined || baseURI === '') return '';
    try {
      var url = new URL(baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.pathname.replace(/\/+$/, '');
    } catch (error) {
      return '';
    }
  }

  /**
   * 浏览器侧 API 公共前缀：挂载前缀 + 宿主路由段。
   *
   * @param baseURI - 文档基准地址。
   * @returns 形如 `/app/x/dsh-file-integrity-check` 的前缀。
   */
  function routeBaseOf(baseURI) {
    return mountPrefixOf(baseURI) + ROUTE_SEGMENT;
  }

  /** 本页 API 前缀；document 缺失（非浏览器环境）时退化为纯路由段。 */
  var API_BASE = routeBaseOf(typeof document === 'undefined' ? undefined : document.baseURI);

  /**
   * 取错误对象里的可读消息（任何值都不许抛）。
   *
   * @param error - 任意错误值。
   * @returns 消息字符串。
   */
  function errorMessageOf(error) {
    if (error === null || error === undefined) return '';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message !== '') return error.message;
    try {
      return String(error);
    } catch (ignored) {
      return '';
    }
  }

  /**
   * 发一次 JSON 请求；所有失败（网络、非 2xx、坏 JSON、{ok:false}）都收成统一结果，不抛。
   *
   * @param options - { path, method, body, signal }。
   * @returns Promise<{ ok, status, data?, code?, message?, aborted? }>。
   */
  function requestJson(options) {
    var path = options && typeof options.path === 'string' ? options.path : '';
    var method = options && typeof options.method === 'string' ? options.method : 'GET';
    var body = options ? options.body : undefined;
    var signal = options ? options.signal : undefined;
    var url = API_BASE + path;
    var init = { method: method, cache: 'no-store', headers: { accept: 'application/json' } };
    if (signal !== undefined) init.signal = signal;
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      try {
        init.body = JSON.stringify(body);
      } catch (error) {
        return Promise.resolve(failedResult('bad-response', errorMessageOf(error), 0));
      }
    }
    var request;
    try {
      request = fetch(url, init);
    } catch (error) {
      return Promise.resolve(failedResult('network-error', errorMessageOf(error), 0));
    }
    return request
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          if (text !== '') {
            try {
              data = JSON.parse(text);
            } catch (error) {
              data = null;
            }
          }
          if (!response.ok) {
            if (data && typeof data === 'object' && data.ok === false) {
              return failedResult(
                typeof data.code === 'string' ? data.code : 'internal-error',
                typeof data.message === 'string' ? data.message : '',
                response.status,
              );
            }
            return failedResult(response.status === 404 ? 'job-not-found' : 'internal-error', '', response.status);
          }
          if (data === null || typeof data !== 'object') {
            return failedResult('bad-response', '', response.status);
          }
          if (data.ok === false) {
            return failedResult(
              typeof data.code === 'string' ? data.code : 'internal-error',
              typeof data.message === 'string' ? data.message : '',
              response.status,
            );
          }
          return { ok: true, status: response.status, data: data };
        });
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          return { ok: false, status: 0, code: 'aborted', message: '', aborted: true };
        }
        return failedResult('network-error', errorMessageOf(error), 0);
      });
  }

  /**
   * 造一个失败结果对象。
   *
   * @param code - 错误码。
   * @param message - 原始消息。
   * @param status - HTTP 状态码（0 表示没发出去）。
   * @returns 失败结果。
   */
  function failedResult(code, message, status) {
    return {
      ok: false,
      status: typeof status === 'number' ? status : 0,
      code: typeof code === 'string' && code !== '' ? code : 'internal-error',
      message: typeof message === 'string' ? message : '',
    };
  }

  //#endregion

  //#region 数据整形（宿主响应可能缺字段；坏一条不许拖垮整块）

  /**
   * 安全取字符串。
   *
   * @param value - 任意值。
   * @returns 字符串；非字符串一律 ''。
   */
  function asString(value) {
    return typeof value === 'string' ? value : '';
  }

  /**
   * 安全取数字。
   *
   * @param value - 任意值。
   * @returns 有限数字；否则 0。
   */
  function asNumber(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  /**
   * 安全取字符串数组（顺手去空、限长）。
   *
   * @param value - 任意值。
   * @returns 字符串数组。
   */
  function asStringArray(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length && out.length < 20; i++) {
      if (typeof value[i] === 'string' && value[i] !== '') out.push(value[i]);
    }
    return out;
  }

  /**
   * 扫描速率 → 展示文本（不带单位，单位在文案里）。
   *
   * @param rate - 项/秒。
   * @returns 形如 `12.3` / `128`。
   */
  function formatRate(rate) {
    var value = typeof rate === 'number' && isFinite(rate) && rate > 0 ? rate : 0;
    if (value === 0) return '0';
    if (value >= 100) return String(Math.round(value));
    if (value >= 10) return value.toFixed(1).replace(/\.0$/, '');
    return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  /**
   * 时间字段 → 毫秒时间戳（宿主可能给 number，也可能给 ISO 字符串）。
   *
   * @param value - 任意值。
   * @returns 毫秒时间戳；无法识别时 0。
   */
  function toTime(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value !== '') {
      var parsed = Date.parse(value);
      return isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  /**
   * 毫秒 → 人类可读耗时。
   *
   * @param ms - 毫秒数。
   * @returns 形如 `320 ms` / `1.4 s` / `2 m 5 s`。
   */
  function formatDuration(ms) {
    var value = typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms : 0;
    if (value < 1000) return Math.round(value) + ' ms';
    var seconds = value / 1000;
    if (seconds < 60) return seconds.toFixed(1) + ' s';
    var minutes = Math.floor(seconds / 60);
    var rest = Math.round(seconds % 60);
    return minutes + ' m ' + rest + ' s';
  }

  /**
   * 字节数 → 人类可读体积。
   *
   * @param value - 字节数。
   * @returns 形如 `0 B` / `512 B` / `1.4 MB`。
   */
  function formatBytes(value) {
    var bytes = typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
    if (bytes < 1024) return Math.round(bytes) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var size = bytes / 1024;
    var index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return (size >= 100 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/, '')) + ' ' + units[index];
  }

  /**
   * 毫秒时间戳（或 ISO 字符串）→ 本地时间文本。
   *
   * @param value - 毫秒数/ISO 字符串。
   * @returns 本地时间文本；无法识别时 ''。
   */
  function formatDateTime(value) {
    var ms = toTime(value);
    if (ms <= 0) return '';
    try {
      return new Date(ms).toLocaleString();
    } catch (error) {
      return '';
    }
  }

  /**
   * 归一化一条命中项。
   *
   * @param raw - 宿主返回的 item。
   * @returns { path, relativePath, kind, explicit, label } 或 null（不可用）。
   */
  function normalizeItem(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    var path = asString(raw.path);
    var relativePath = asString(raw.relativePath);
    if (path === '' && relativePath === '') return null;
    return {
      path: path !== '' ? path : relativePath,
      relativePath: relativePath !== '' ? relativePath : path,
      kind: raw.kind === 'dir' ? 'dir' : 'file',
      explicit: raw.explicit === true,
      label: asString(raw.label) !== '' ? asString(raw.label) : 'Low',
    };
  }

  /**
   * 归一化一组命中项；坏条目直接丢弃。
   *
   * @param raw - 任意值。
   * @returns 命中项数组（最多 PAGE_SIZE 条）。
   */
  function normalizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < PAGE_SIZE; i++) {
      var item = normalizeItem(raw[i]);
      if (item !== null) out.push(item);
    }
    return out;
  }

  /**
   * 按 path+kind 合并两批命中项（保留先出现的顺序、去重）。
   *
   * @param existing - 已加载的条目。
   * @param incoming - 新一批条目。
   * @returns 合并后的条目。
   */
  function mergeItems(existing, incoming) {
    var seen = {};
    var out = [];
    var add = function (item) {
      if (!item || typeof item !== 'object') return;
      var key = asString(item.path) + '|' + (item.kind === 'dir' ? 'dir' : 'file');
      if (seen[key] === true) return;
      seen[key] = true;
      out.push(item);
    };
    var a = Array.isArray(existing) ? existing : [];
    var b = Array.isArray(incoming) ? incoming : [];
    for (var i = 0; i < a.length; i++) add(a[i]);
    for (var j = 0; j < b.length; j++) add(b[j]);
    return out;
  }

  /**
   * 归一化失败项列表。
   *
   * @param raw - 任意值。
   * @returns { path, message } 数组。
   */
  function normalizeErrors(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (entry === null || entry === undefined) continue;
      if (typeof entry === 'string') {
        out.push({ path: '', message: entry });
        continue;
      }
      if (typeof entry !== 'object') continue;
      out.push({ path: asString(entry.path), message: asString(entry.message) });
    }
    return out;
  }

  /**
   * 归一化失败项列表（repair 的 result.failed：path / message / output）。
   *
   * @param raw - 任意值。
   * @returns { path, message, output } 数组。
   */
  function normalizeFailedItems(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i];
      if (entry === null || entry === undefined) continue;
      if (typeof entry !== 'object') continue;
      out.push({
        path: asString(entry.path),
        message: asString(entry.message),
        output: asString(entry.output),
      });
    }
    return out;
  }

  /**
   * 归一化 health 响应。
   *
   * @param data - 响应 JSON。
   * @returns 稳定的 health 形状（字段缺失用安全默认值）。
   */
  function normalizeHealth(data) {
    var raw = data !== null && typeof data === 'object' ? data : {};
    var engine = raw.engine !== null && typeof raw.engine === 'object' ? raw.engine : null;
    var registry = raw.registry !== null && typeof raw.registry === 'object' ? raw.registry : null;
    return {
      version: asString(raw.version),
      platform: asString(raw.platform),
      // 产物目录（Host 可选能力；缺字段时一律空串，面板据此隐藏该行）。
      dataDir: asString(raw.dataDir),
      defaultDataDir: asString(raw.defaultDataDir),
      dataDirError: asString(raw.dataDirError),
      engine:
        engine === null
          ? null
          : {
              integrity: asString(engine.integrity),
              available: engine.available !== false,
              reason: asString(engine.reason),
              // canWriteLabel 是 Host 的可选提示；缺省视为「可写」（false 才表示引擎受限）。
              canWriteLabel: engine.canWriteLabel !== false,
            },
      registry:
        registry === null
          ? null
          : { available: registry.available !== false, count: asNumber(registry.count) },
      warnings: asStringArray(raw.warnings),
    };
  }

  /**
   * 归一化保留天数：整数 1..3650；缺失/越界时用默认值。
   *
   * @param value - 任意值。
   * @returns 合法保留天数。
   */
  function asRetentionDays(value) {
    var days = typeof value === 'number' && isFinite(value) ? Math.round(value) : 0;
    if (days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) return RETENTION_DEFAULT_DAYS;
    return days;
  }

  /**
   * 归一化保留天数预设：只留 1..3650 的整数、去重；空列表用内置预设兜底。
   *
   * @param value - 宿主返回的 retentionPresets（任意值）。
   * @returns 预设天数数组（非空）。
   */
  function normalizeRetentionPresets(value) {
    if (!Array.isArray(value)) return RETENTION_PRESETS.slice();
    var out = [];
    for (var i = 0; i < value.length && out.length < 8; i++) {
      var days = typeof value[i] === 'number' && isFinite(value[i]) ? Math.round(value[i]) : 0;
      if (days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) continue;
      if (out.indexOf(days) !== -1) continue;
      out.push(days);
    }
    return out.length > 0 ? out : RETENTION_PRESETS.slice();
  }

  /**
   * 当前保留天数 → 分段按钮视图（命中预设选预设，否则自定义并回填数字）。
   *
   * @param days - 合法保留天数。
   * @param presets - 预设天数数组。
   * @returns { choice: number|'custom', input: string }。
   */
  function retentionViewOf(days, presets) {
    var list = Array.isArray(presets) && presets.length > 0 ? presets : RETENTION_PRESETS;
    if (list.indexOf(days) !== -1) return { choice: days, input: '' };
    return { choice: 'custom', input: String(days) };
  }

  /**
   * 自定义天数文本 → 整数天数。
   *
   * @param text - 输入框文本。
   * @returns 1..3650 的整数；非法时 null。
   */
  function parseRetentionDays(text) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!/^\d+$/.test(value)) return null;
    var days = Number(value);
    if (!isFinite(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) return null;
    return days;
  }

  /**
   * 归一化上次清理结果（GET /settings 的可选字段）。
   *
   * @param raw - 任意值。
   * @returns { at, cutoff, deletedCount, freedBytes, error } 或 null（无记录）。
   */
  function normalizeLastCleanup(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    return {
      at: toTime(raw.at),
      cutoff: toTime(raw.cutoff),
      deletedCount: asNumber(raw.deletedCount),
      freedBytes: asNumber(raw.freedBytes),
      error: asString(raw.error),
    };
  }

  /**
   * 归一化 workspace 响应里的 workspace 字段。
   *
   * @param raw - 任意值。
   * @returns { id, path, title } 或 null。
   */
  function normalizeWorkspace(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    var path = asString(raw.path);
    if (path === '') return null;
    return { id: asString(raw.id), path: path, title: asString(raw.title) };
  }

  /**
   * 归一化 workspace 响应里的附加信息。
   *
   * @param data - 响应 JSON。
   * @returns { sessionCount, liveAgentCount, warnings } 或 null。
   */
  function normalizeWorkspaceMeta(data) {
    if (data === null || typeof data !== 'object') return null;
    return {
      sessionCount: asNumber(data.sessionCount),
      liveAgentCount: asNumber(data.liveAgentCount),
      warnings: asStringArray(data.warnings),
    };
  }

  /**
   * 归一化 job 对象；缺 id 视为不可用。
   *
   * @param raw - 响应 JSON 里的 job。
   * @returns 稳定的 job 形状或 null。
   */
  function normalizeJob(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    var id = asString(raw.id);
    if (id === '') return null;
    var status = asString(raw.status);
    if (status !== 'running' && status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') {
      status = 'failed';
    }
    var action = raw.action === 'repair' ? 'repair' : 'scan';
    return {
      id: id,
      action: action,
      status: status,
      phase: asString(raw.phase),
      scanned: asNumber(raw.scanned),
      total: asNumber(raw.total),
      hits: asNumber(raw.hits),
      explicitCount: asNumber(raw.explicitCount),
      inheritedCount: asNumber(raw.inheritedCount),
      rootLabel: asString(raw.rootLabel),
      fixed: asNumber(raw.fixed),
      failedCount: asNumber(raw.failedCount),
      errorCount: asNumber(raw.errorCount),
      // 扫描模式相关（旧任务/repair 任务可能缺失；展示时见 effectiveScanDepth / effectiveItemsScope）。
      depth: raw.depth === 'quick' ? 'quick' : raw.depth === 'deep' ? 'deep' : '',
      itemsScope: raw.itemsScope === 'explicit' ? 'explicit' : raw.itemsScope === 'all' ? 'all' : '',
      engine: asString(raw.engine),
      reportPath: asString(raw.reportPath),
      // 宿主当前 snapshot 未暴露复扫剩余数（只有引擎 result 内部用）；缺省用 -1 标记，
      // 面板用 hits - fixed - failedCount 兜底估算（见 remainingHitsOf）。
      remainingCount: typeof raw.remainingCount === 'number' && isFinite(raw.remainingCount) ? raw.remainingCount : -1,
      errors: normalizeErrors(raw.errors),
      failed: normalizeFailedItems(raw.failed),
      items: normalizeItems(raw.items),
      truncated: raw.truncated === true,
      snapshotPath: asString(raw.snapshotPath),
      restorePath: asString(raw.restorePath),
      startedAt: toTime(raw.startedAt),
      finishedAt: toTime(raw.finishedAt),
      message: asString(raw.message),
    };
  }

  /**
   * 归一化后的扫描深度：旧任务缺 depth 时按 deep 展示（兼容契约），repair 任务返回 ''。
   *
   * @param job - 归一化后的 job（可为 null）。
   * @returns 'quick' | 'deep' | ''。
   */
  function effectiveScanDepth(job) {
    if (job === null || typeof job !== 'object' || job.action !== 'scan') return '';
    return job.depth === 'quick' ? 'quick' : 'deep';
  }

  /**
   * 归一化后的清单范围：缺 itemsScope 时按深度推断（quick→explicit，其余→all）。
   *
   * @param job - 归一化后的 job（可为 null）。
   * @returns 'explicit' | 'all'。
   */
  function effectiveItemsScope(job) {
    if (job === null || typeof job !== 'object') return 'all';
    if (job.itemsScope === 'explicit' || job.itemsScope === 'all') return job.itemsScope;
    return effectiveScanDepth(job) === 'quick' ? 'explicit' : 'all';
  }

  /**
   * 按展示范围过滤命中项（quick 只列显式；deep 全部）。
   *
   * @param items - 归一化后的命中项。
   * @param scope - 'explicit' | 'all'。
   * @returns 过滤后的命中项。
   */
  function filterItemsByScope(items, scope) {
    var list = Array.isArray(items) ? items : [];
    if (scope !== 'explicit') return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].explicit === true) out.push(list[i]);
    }
    return out;
  }

  /**
   * 已加载清单里的显式父级目录数（quick 模式下用于继承项聚合说明的估算）。
   *
   * @param items - 归一化后的命中项。
   * @returns 非负整数。
   */
  function countExplicitDirs(items) {
    var list = Array.isArray(items) ? items : [];
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].kind === 'dir' && list[i].explicit === true) count += 1;
    }
    return count;
  }

  /**
   * 清除后的复扫剩余命中数：优先宿主给的 remainingCount，缺省用
   * hits - fixed - failedCount 估算（宿主 snapshot 目前未暴露 remainingCount）。
   *
   * @param job - 归一化后的 repair job。
   * @returns 非负的剩余命中数。
   */
  function remainingHitsOf(job) {
    if (job === null || typeof job !== 'object') return 0;
    if (typeof job.remainingCount === 'number' && job.remainingCount >= 0) return job.remainingCount;
    return Math.max(0, job.hits - job.fixed - job.failedCount);
  }

  /**
   * 造一个刚提交、尚未取到真实状态的 running job（让轮询立刻有目标）。
   *
   * @param action - 'scan' | 'repair'。
   * @param id - 宿主返回的 jobId。
   * @param depth - 扫描请求的深度（'quick' | 'deep'，仅 scan 有效；repair 传 ''）。
   * @returns 稳定的 job 形状。
   */
  function provisionalJob(action, id, depth) {
    var scanDepth = action === 'scan' ? (depth === 'deep' ? 'deep' : 'quick') : '';
    return {
      id: id,
      action: action,
      status: 'running',
      phase: '',
      depth: scanDepth,
      itemsScope: action === 'scan' ? (scanDepth === 'quick' ? 'explicit' : 'all') : '',
      engine: '',
      reportPath: '',
      scanned: 0,
      total: 0,
      hits: 0,
      explicitCount: 0,
      inheritedCount: 0,
      rootLabel: '',
      fixed: 0,
      failedCount: 0,
      errorCount: 0,
      remainingCount: -1,
      errors: [],
      failed: [],
      items: [],
      truncated: false,
      snapshotPath: '',
      restorePath: '',
      startedAt: Date.now(),
      finishedAt: 0,
      message: '',
    };
  }

  /**
   * 把一次 job 状态换算成面板状态的补丁（保持「扫描结果」与「当前任务」两份视角）。
   *
   * @param prev - 之前的面板状态。
   * @param job - 归一化后的 job。
   * @returns 状态补丁。
   */
  function jobPatch(prev, job) {
    var patch = { job: job, jobId: job.id, jobLoading: false, now: Date.now() };
    if (job.action === 'scan') {
      var scope = effectiveItemsScope(job);
      // quick 模式的清单只列显式项，因此清单总数用 explicitCount；deep 用全部 hits。
      var listTotal = scope === 'explicit' ? job.explicitCount : job.hits;
      if (job.status === 'running') {
        if (prev.itemsJobId !== job.id) {
          patch.items = filterItemsByScope(normalizeItems(job.items), scope);
          patch.itemsTotal = listTotal;
          patch.itemsJobId = job.id;
          patch.itemsLoaded = true;
          patch.itemsError = null;
        } else {
          patch.itemsTotal = listTotal;
        }
      } else {
        patch.scanJob = job;
        patch.items = filterItemsByScope(mergeItems(prev.itemsJobId === job.id ? prev.items : [], job.items), scope);
        patch.itemsTotal = listTotal;
        patch.itemsJobId = job.id;
        patch.itemsLoaded = true;
        patch.itemsError = null;
      }
    } else if (job.action === 'repair' && job.status !== 'running') {
      if (job.status === 'succeeded') {
        // 清除成功后 job.hits 是修复前的命中数，不能当复扫结果，也不该再显示旧命中清单。
        patch.scanJob = null;
        patch.items = [];
        patch.itemsTotal = 0;
        patch.itemsJobId = job.id;
        patch.itemsLoaded = true;
        patch.itemsError = null;
      } else if (prev.itemsTotal === 0 && prev.items.length === 0) {
        // 失败/取消且本地没有扫描清单时（例如从 sessionStorage 恢复），用任务自带的命中项兜底。
        patch.items = normalizeItems(job.items);
        patch.itemsTotal = job.hits;
        patch.itemsJobId = job.id;
        patch.itemsLoaded = true;
        patch.itemsError = null;
      }
    }
    return patch;
  }

  //#endregion

  //#region 剪贴板与 sessionStorage

  /**
   * 复制文本：优先 navigator.clipboard，失败退化为 textarea + execCommand。
   *
   * @param text - 要复制的文本。
   * @returns Promise 结果（boolean）：是否成功。
   */
  function copyToClipboard(text) {
    return new Promise(function (resolve) {
      if (typeof text !== 'string' || text === '') {
        resolve(false);
        return;
      }
      var nav = typeof navigator === 'undefined' ? null : navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        var pending;
        try {
          pending = nav.clipboard.writeText(text);
        } catch (error) {
          resolve(fallbackCopy(text));
          return;
        }
        if (pending && typeof pending.then === 'function') {
          pending.then(
            function () {
              resolve(true);
            },
            function () {
              resolve(fallbackCopy(text));
            },
          );
        } else {
          resolve(true);
        }
        return;
      }
      resolve(fallbackCopy(text));
    });
  }

  /**
   * 剪贴板 API 缺失/被拒时的兜底复制。
   *
   * @param text - 要复制的文本。
   * @returns 是否成功。
   */
  function fallbackCopy(text) {
    if (typeof document === 'undefined' || !document.body) return false;
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.left = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
      document.body.removeChild(area);
      return ok === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 取 sessionStorage；不可用时返回 null（隐私模式/被策略禁用）。
   *
   * @returns Storage 或 null。
   */
  function storageOf() {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return null;
      return window.sessionStorage;
    } catch (error) {
      return null;
    }
  }

  /**
   * 读某会话记住的 jobId。
   *
   * @param sessionId - 会话 id。
   * @returns jobId；没有/读不到时 ''。
   */
  function readStoredJob(sessionId) {
    var storage = storageOf();
    if (storage === null || sessionId === '') return '';
    try {
      var value = storage.getItem(STORAGE_PREFIX + String(sessionId));
      return typeof value === 'string' ? value : '';
    } catch (error) {
      return '';
    }
  }

  /**
   * 写/清某会话记住的 jobId。
   *
   * @param sessionId - 会话 id。
   * @param jobId - 要记住的 jobId；空串表示清除。
   */
  function writeStoredJob(sessionId, jobId) {
    var storage = storageOf();
    if (storage === null || sessionId === '') return;
    try {
      var key = STORAGE_PREFIX + String(sessionId);
      if (typeof jobId === 'string' && jobId !== '') storage.setItem(key, jobId);
      else storage.removeItem(key);
    } catch (error) {
      /* sessionStorage 写满/被禁用：任务恢复降级为不恢复，不影响面板本身 */
    }
  }

  /**
   * 清掉某会话记住的 jobId。
   *
   * @param sessionId - 会话 id。
   */
  function removeStoredJob(sessionId) {
    writeStoredJob(sessionId, '');
  }

  /**
   * 从 slot props 取 sessionId（防御旧/新版本 props 形状差异）。
   *
   * @param props - 插槽组件 props。
   * @returns 会话 id；取不到时 ''。
   */
  function readSessionId(props) {
    if (props === null || typeof props !== 'object') return '';
    if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
    if (typeof props.session === 'string' && props.session !== '') return props.session;
    if (props.session !== null && typeof props.session === 'object') {
      if (typeof props.session.id === 'string' && props.session.id !== '') return props.session.id;
    }
    if (props.tab !== null && typeof props.tab === 'object') {
      if (typeof props.tab.sessionId === 'string' && props.tab.sessionId !== '') return props.tab.sessionId;
    }
    return '';
  }

  //#endregion

  //#region 会话行未读状态（任务结束紫点）

  /**
   * 枚举 sessionStorage 里本插件记录的「会话 → 当前任务」映射。
   *
   * @param storage - sessionStorage（可能为 null）。
   * @returns {Array<{ sessionId: string, jobId: string }>}。
   */
  function trackedJobsOf(storage) {
    if (storage === null) return [];
    var out = [];
    try {
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (typeof key !== 'string' || key.indexOf(STORAGE_PREFIX) !== 0) continue;
        var sessionId = key.slice(STORAGE_PREFIX.length);
        if (sessionId === '') continue;
        var value = storage.getItem(key);
        if (typeof value === 'string' && value !== '') out.push({ sessionId: sessionId, jobId: value });
      }
    } catch (error) {
      return [];
    }
    return out;
  }

  /**
   * 造「任务结束未读」watcher：轮询被跟踪任务的状态，维护会话 id → 是否未读。
   *
   * 单例（每个插件 factory 一个），所有会话行 occupant 共享同一份状态与订阅。
   *
   * @returns { isUnread, subscribe, ack, start }。
   */
  function createUnreadWatcher() {
    /** 会话 id → 是否未读（真源只在这个闭包里）。 */
    var unread = {};
    var subscribers = [];
    var timer = null;
    var visibilityHandler = null;
    var started = false;
    var stopped = false;
    var inFlight = false;

    /**
     * 某会话当前是否未读。
     *
     * @param sessionId - 会话 id。
     * @returns true 表示应显示紫点。
     */
    function isUnread(sessionId) {
      var sid = typeof sessionId === 'string' ? sessionId : '';
      return sid !== '' && unread[sid] === true;
    }

    /**
     * 订阅未读状态变化。
     *
     * @param fn - 变化回调（无参数）。
     * @returns 取消订阅函数；坏参数返回空操作。
     */
    function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      subscribers.push(fn);
      return function () {
        var index = subscribers.indexOf(fn);
        if (index !== -1) subscribers.splice(index, 1);
      };
    }

    /** 通知所有订阅者；单个回调异常不影响其他订阅者。 */
    function notify() {
      var list = subscribers.slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i]();
        } catch (error) {
          console.warn(LOG_PREFIX + ' 未读状态订阅回调失败（已忽略）：', error);
        }
      }
    }

    /**
     * 读取某会话已经「已读」到的 jobId。
     *
     * @param storage - sessionStorage。
     * @param sessionId - 会话 id。
     * @returns 已读 jobId；没有时 ''。
     */
    function readAck(storage, sessionId) {
      try {
        var value = storage.getItem(ACK_PREFIX + sessionId);
        return typeof value === 'string' ? value : '';
      } catch (error) {
        return '';
      }
    }

    /**
     * 标记某会话已读：记住当前 jobId、清掉未读并通知。
     *
     * @param sessionId - 会话 id。
     */
    function ack(sessionId) {
      var sid = typeof sessionId === 'string' ? sessionId : '';
      if (sid === '') return;
      var storage = storageOf();
      if (storage !== null) {
        var jobId = readStoredJob(sid);
        if (jobId !== '') {
          try {
            storage.setItem(ACK_PREFIX + sid, jobId);
          } catch (error) {
            /* 写满/被禁用：只影响下次刷新，本次清除照常 */
          }
        }
      }
      if (unread[sid] === true) {
        delete unread[sid];
        notify();
      }
    }

    /**
     * 清掉「当前没有任务映射」的会话未读（映射消失说明任务已不可跟踪）。
     *
     * @param tracked - 当前枚举到的任务映射。
     * @returns 是否有变化。
     */
    function pruneUntracked(tracked) {
      var seen = {};
      for (var i = 0; i < tracked.length; i++) seen[tracked[i].sessionId] = true;
      var changed = false;
      var keys = Object.keys(unread);
      for (var j = 0; j < keys.length; j++) {
        if (seen[keys[j]] !== true) {
          delete unread[keys[j]];
          changed = true;
        }
      }
      return changed;
    }

    /**
     * 应用一批任务查询结果，更新未读映射。
     *
     * 规则：terminal（succeeded/failed/cancelled）且 ack !== jobId → 未读；
     * running → 已读；404 → 清映射并已读；其他错误 → 保持原状。
     *
     * @param storage - sessionStorage。
     * @param tracked - 本轮枚举到的任务映射。
     * @param results - [{ pair, res }]。
     * @returns 状态是否有变化。
     */
    function applyResults(storage, tracked, results) {
      var changed = false;
      for (var i = 0; i < results.length; i++) {
        var pair = results[i].pair;
        var res = results[i].res;
        var sid = pair.sessionId;
        if (res !== null && res.ok === true) {
          var rawJob =
            res.data !== null && typeof res.data === 'object' && res.data.job !== null && typeof res.data.job === 'object'
              ? res.data.job
              : null;
          var status = rawJob === null ? '' : asString(rawJob.status);
          if (status === 'running') {
            if (unread[sid] === true) {
              delete unread[sid];
              changed = true;
            }
          } else if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
            if (readAck(storage, sid) === pair.jobId) {
              if (unread[sid] === true) {
                delete unread[sid];
                changed = true;
              }
            } else if (unread[sid] !== true) {
              unread[sid] = true;
              changed = true;
            }
          }
        } else if (res !== null && res.ok === false && (res.code === 'job-not-found' || res.status === 404)) {
          // 过期/不存在的任务：清掉映射，避免紫点常驻。
          removeStoredJob(sid);
          if (unread[sid] === true) {
            delete unread[sid];
            changed = true;
          }
        }
      }
      if (pruneUntracked(tracked)) changed = true;
      return changed;
    }

    /** 一次轮询的收尾：释放 inFlight，状态变化则通知。 */
    function finish(changed) {
      inFlight = false;
      if (stopped) return;
      if (changed === true) notify();
    }

    /** 轮询一次：枚举映射 → 并发查询任务状态 → 更新未读。 */
    function tick() {
      if (stopped || inFlight) return;
      if (typeof document !== 'undefined' && document !== null && document.hidden === true) return;
      var storage = storageOf();
      var tracked = trackedJobsOf(storage);
      if (tracked.length === 0) {
        if (pruneUntracked(tracked)) notify();
        return;
      }
      inFlight = true;
      var results = [];
      var pending = [];
      var requestFor = function (pair) {
        return requestJson({ path: '/jobs/' + encodeURIComponent(pair.jobId), method: 'GET' }).then(function (res) {
          results.push({ pair: pair, res: res });
        });
      };
      for (var i = 0; i < tracked.length; i++) pending.push(requestFor(tracked[i]));
      Promise.all(pending)
        .then(function () {
          var changed = false;
          try {
            changed = applyResults(storage, tracked, results);
          } catch (error) {
            console.warn(LOG_PREFIX + ' 未读状态更新失败（已忽略）：', error);
          }
          finish(changed);
        })
        .catch(function (error) {
          console.warn(LOG_PREFIX + ' 未读状态查询失败（已忽略）：', error);
          finish(false);
        });
    }

    /**
     * 启动轮询：立即查一次，之后每 UNREAD_POLL_MS 查一次；页面重新可见时补查。
     *
     * @returns 停止函数（清定时器、可见性监听与订阅）。
     */
    function start() {
      if (started) return function () {};
      started = true;
      stopped = false;
      try {
        tick();
      } catch (error) {
        console.warn(LOG_PREFIX + ' 未读状态首次轮询失败（已忽略）：', error);
      }
      try {
        if (typeof window !== 'undefined' && window !== null && typeof window.setInterval === 'function') {
          timer = window.setInterval(function () {
            try {
              tick();
            } catch (error) {
              console.warn(LOG_PREFIX + ' 未读状态轮询失败（已忽略）：', error);
            }
          }, UNREAD_POLL_MS);
        }
      } catch (error) {
        console.warn(LOG_PREFIX + ' 未读状态定时器启动失败（已忽略）：', error);
      }
      try {
        if (typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function') {
          visibilityHandler = function () {
            if (document.hidden === true) return;
            try {
              tick();
            } catch (error) {
              console.warn(LOG_PREFIX + ' 未读状态恢复轮询失败（已忽略）：', error);
            }
          };
          document.addEventListener('visibilitychange', visibilityHandler);
        }
      } catch (error) {
        console.warn(LOG_PREFIX + ' 未读状态可见性监听失败（已忽略）：', error);
      }
      return function () {
        stopped = true;
        started = false;
        if (timer !== null) {
          try {
            window.clearInterval(timer);
          } catch (error) {
            /* 清理失败不影响页面 */
          }
          timer = null;
        }
        if (visibilityHandler !== null) {
          try {
            document.removeEventListener('visibilitychange', visibilityHandler);
          } catch (error) {
            /* 清理失败不影响页面 */
          }
          visibilityHandler = null;
        }
        subscribers.length = 0;
        unread = {};
        inFlight = false;
      };
    }

    return { isUnread: isUnread, subscribe: subscribe, ack: ack, start: start };
  }

  //#endregion

  //#region 纯渲染辅助

  /**
   * 造一个按钮。
   *
   * @param h - React.createElement。
   * @param options - { label, onClick, variant?, small?, disabled?, title?, key? }。
   * @returns 按钮元素。
   */
  function actionButton(h, options) {
    var className = 'fi-btn';
    if (options.variant === 'primary') className += ' fi-btn-primary';
    else if (options.variant === 'danger') className += ' fi-btn-danger';
    if (options.small === true) className += ' fi-btn-small';
    var props = {
      type: 'button',
      className: className,
      disabled: options.disabled === true,
      onClick: options.onClick,
    };
    if (typeof options.title === 'string' && options.title !== '') props.title = options.title;
    if (typeof options.key === 'string') props.key = options.key;
    return h('button', props, options.label);
  }

  /**
   * 造一个提示条。
   *
   * @param h - React.createElement。
   * @param options - { tone: 'info'|'warn'|'error'|'success', title?, text?, key? }。
   * @returns 提示条元素。
   */
  function banner(h, options) {
    var className = 'fi-banner fi-banner-info';
    if (options.tone === 'warn') className = 'fi-banner fi-banner-warn';
    else if (options.tone === 'error') className = 'fi-banner fi-banner-error';
    else if (options.tone === 'success') className = 'fi-banner fi-banner-success';
    var children = [];
    if (typeof options.title === 'string' && options.title !== '') {
      children.push(h('div', { className: 'fi-banner-title', key: 'title' }, options.title));
    }
    if (typeof options.text === 'string' && options.text !== '') {
      children.push(h('div', { className: 'fi-banner-text', key: 'text' }, options.text));
    }
    return h('div', { className: className, key: typeof options.key === 'string' ? options.key : undefined }, children);
  }

  /**
   * 把错误对象翻成一句本地化文案（坏值一律兜底）。
   *
   * @param t - locale 绑定函数。
   * @param error - { code, message } 或任意值。
   * @returns 可展示文案。
   */
  function describeError(t, error) {
    if (error === null || error === undefined) return '';
    var code = '';
    var message = '';
    if (typeof error === 'string') {
      message = error;
    } else if (typeof error === 'object') {
      code = asString(error.code);
      message = asString(error.message);
    }
    if (message.length > 400) message = message.slice(0, 400) + '…';
    var base;
    if (code !== '' && KNOWN_ERROR_CODES[code] === true) base = t('error.' + code);
    else base = t('error.generic', { message: message !== '' ? message : code !== '' ? code : '?' });
    if (message !== '' && KNOWN_ERROR_CODES[code] === true) return base + ' · ' + message;
    return base;
  }

  /**
   * 一行「标签 + 路径 + 复制」；可选「打开文件夹」按钮。
   *
   * @param h - React.createElement。
   * @param t - locale 绑定函数。
   * @param actions - 面板动作（含 copy）。
   * @param label - 行标题。
   * @param path - 路径文本；空串时显示「宿主未返回路径」。
   * @param key - React key。
   * @param openAction - 可选：点击打开所在文件夹。
   * @param opening - 是否正在打开。
   * @returns 行元素。
   */
  function artifactRow(h, t, actions, label, path, key, openAction, opening) {
    var value = typeof path === 'string' ? path : '';
    var pathNode =
      value !== ''
        ? h('code', { className: 'fi-path', title: value }, value)
        : h('span', { className: 'fi-muted' }, t('repair.pathMissing'));
    var copyNode =
      value !== ''
        ? actionButton(h, {
            label: t('artifact.copy'),
            variant: 'ghost',
            small: true,
            onClick: function () {
              actions.copy(value);
            },
          })
        : null;
    var openNode =
      value !== '' && typeof openAction === 'function'
        ? actionButton(h, {
            label: opening === true ? t('repair.openingFolder') : t('repair.openFolder'),
            variant: 'ghost',
            small: true,
            disabled: opening === true,
            onClick: openAction,
          })
        : null;
    return h('div', { className: 'fi-col', key: key }, h('span', { className: 'fi-label' }, label), h('div', { className: 'fi-row' }, pathNode, copyNode, openNode));
  }

  /**
   * 单条命中行：相对路径 + 类型 + 显式/继承 + 复制完整路径。
   *
   * @param h - React.createElement。
   * @param t - locale 绑定函数。
   * @param actions - 面板动作。
   * @param item - 命中项。
   * @param index - 序号（React key 用）。
   * @returns 行元素。
   */
  function hitRow(h, t, actions, item, index) {
    var kindLabel = item.kind === 'dir' ? t('hits.kind.dir') : t('hits.kind.file');
    var explicitLabel = item.explicit ? t('hits.badge.explicit') : t('hits.badge.inherited');
    return h(
      'div',
      { className: 'fi-hit', key: (item.path || '') + '#' + index },
      h('code', { className: 'fi-hit-path', title: item.path }, item.relativePath || item.path),
      h(
        'span',
        { className: 'fi-badges' },
        h('span', { className: 'fi-badge', key: 'kind' }, kindLabel),
        h('span', { className: 'fi-badge ' + (item.explicit ? 'fi-badge-warn' : ''), key: 'scope' }, explicitLabel),
      ),
      actionButton(h, {
        label: t('action.copy'),
        title: t('hits.copyPath'),
        small: true,
        onClick: function () {
          actions.copy(item.path);
        },
      }),
    );
  }

  //#endregion

  //#region 面板渲染

  /**
   * 顶部：标题 + 只读/运行中角标。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 头部元素或 null。
   */
  function renderHeader(view) {
    var h = view.h;
    var t = view.t;
    var flags = view.flags;
    var badges = [];
    if (flags.readOnly) badges.push(h('span', { className: 'fi-badge fi-badge-warn', key: 'readonly' }, t('badge.readonly')));
    if (flags.running) badges.push(h('span', { className: 'fi-badge', key: 'running' }, t('badge.running')));
    return h(
      'div',
      { className: 'fi-head' },
      h(
        'div',
        { className: 'fi-head-main' },
        h('div', { className: 'fi-title' }, t('tab.title')),
        h('div', { className: 'fi-sub' }, t('header.subtitle')),
      ),
      badges.length > 0 ? h('div', { className: 'fi-badges' }, badges) : null,
    );
  }

  /**
   * 工作区卡片：路径（可复制）+ 会话计数 + 活跃会话风险 + 解析/重试。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 卡片元素。
   */
  function renderWorkspace(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var workspace = state.workspace;
    var meta = state.workspaceMeta;
    var children = [];
    children.push(
      h(
        'div',
        { className: 'fi-row', key: 'head' },
        h('span', { className: 'fi-label' }, t('workspace.label')),
        h('span', { className: 'fi-spacer' }),
        workspace !== null
          ? actionButton(h, {
              label: t('action.copy'),
              variant: 'ghost',
              small: true,
              onClick: function () {
                actions.copy(workspace.path);
              },
            })
          : null,
        actionButton(h, {
          label: workspace === null ? t('action.resolve') : t('action.retry'),
          variant: 'ghost',
          small: true,
          onClick: actions.retryLoad,
        }),
      ),
    );
    if (workspace !== null) {
      children.push(h('code', { className: 'fi-path', key: 'path', title: workspace.path }, workspace.path));
    } else if (state.loaded) {
      children.push(h('div', { className: 'fi-muted', key: 'empty' }, t('workspace.pathEmpty')));
    } else {
      children.push(h('div', { className: 'fi-muted', key: 'loading' }, t('loading.workspace')));
    }
    if (meta !== null) {
      children.push(
        h(
          'div',
          { className: 'fi-muted', key: 'meta' },
          t('workspace.sessionCount', { count: meta.sessionCount }) + ' · ' + t('workspace.liveAgents', { count: meta.liveAgentCount }),
        ),
      );
      if (meta.liveAgentCount > 0) {
        children.push(h('div', { className: 'fi-warn-text', key: 'risk' }, t('workspace.riskLive', { count: meta.liveAgentCount })));
      }
      if (meta.warnings.length > 0) {
        children.push(h('div', { className: 'fi-warn-text', key: 'warnings' }, t('workspace.warnings', { count: meta.warnings.length })));
      }
    }
    return h('div', { className: 'fi-card' }, children);
  }

  /**
   * 全局提示条集合：只读、引擎不可用、health/workspace/poll/action/export 错误、复制提示。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 提示条容器或 null。
   */
  function renderBanners(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    var nodes = [];
    if (flags.readOnly) {
      nodes.push(banner(h, { tone: 'warn', text: t('readonly.banner', { platform: flags.platform || '—' }), key: 'readonly' }));
    }
    if (state.health !== null && state.health.engine !== null && state.health.engine.available === false) {
      var reason = state.health.engine.reason !== '' ? state.health.engine.reason : state.health.engine.integrity !== '' ? state.health.engine.integrity : '—';
      nodes.push(banner(h, { tone: 'warn', text: t('engine.unavailable', { reason: reason }), key: 'engine' }));
    }
    if (state.health !== null && state.health.engine !== null && state.health.engine.available !== false && flags.engineRestricted) {
      var integrityLabel = state.health.engine.integrity !== '' ? state.health.engine.integrity : '—';
      nodes.push(banner(h, { tone: 'warn', text: t('engine.restricted', { integrity: integrityLabel }), key: 'engine-restricted' }));
    }
    if (state.health !== null && state.health.platform === '') {
      nodes.push(banner(h, { tone: 'error', text: t('health.bad'), key: 'health-bad' }));
    }
    if (state.healthError !== null) {
      nodes.push(
        banner(h, {
          tone: 'error',
          title: t('health.error', { message: describeError(t, state.healthError) }),
          key: 'health-error',
        }),
      );
    }
    if (state.workspaceError !== null) {
      nodes.push(
        banner(h, {
          tone: 'error',
          title: describeError(t, state.workspaceError),
          key: 'workspace-error',
        }),
      );
    }
    if (state.pollError !== null) {
      nodes.push(
        banner(h, {
          tone: 'warn',
          text: t('poll.failed', { message: describeError(t, state.pollError) }),
          key: 'poll-error',
        }),
      );
    }
    if (state.actionError !== null) {
      var actionError = state.actionError;
      var actionText;
      if (actionError.code === 'job-not-found') {
        actionText = t('job.expired');
      } else if (actionError.context === 'scan') {
        actionText = t('scan.startFailed', { message: describeError(t, actionError) });
      } else if (actionError.context === 'repair') {
        actionText = t('repair.startFailed', { message: describeError(t, actionError) });
      } else {
        actionText = describeError(t, actionError);
      }
      nodes.push(banner(h, { tone: 'error', title: actionText, key: 'action-error' }));
    }
    if (state.exportError !== null) {
      nodes.push(
        banner(h, { tone: 'error', text: t('export.failed', { message: describeError(t, state.exportError) }), key: 'export-error' }),
      );
    }
    if (state.notice !== '') {
      nodes.push(banner(h, { tone: 'info', text: state.notice, key: 'notice' }));
    }
    if (nodes.length === 0) return null;
    return h('div', { className: 'fi-banners' }, nodes);
  }

  /**
   * 动作行：扫描/重扫、导出清单、一键清除、取消任务。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 动作行。
   */
  function renderActions(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    var buttons = [];
    buttons.push(
      actionButton(h, {
        label: flags.scanJob !== null ? t('action.rescan') : t('action.scan'),
        variant: 'primary',
        disabled: !flags.canScan,
        onClick: actions.startScan,
        key: 'scan',
      }),
    );
    if (flags.showExport) {
      buttons.push(
        actionButton(h, {
          label: state.exporting ? t('loading.items') : t('action.export'),
          variant: 'ghost',
          disabled: !flags.canExport,
          onClick: actions.exportList,
          key: 'export',
        }),
      );
    }
    if (flags.showRepair) {
      buttons.push(
        actionButton(h, {
          label: t('action.repair'),
          variant: 'danger',
          disabled: !flags.canRepair,
          onClick: actions.openConfirm,
          key: 'repair',
        }),
      );
    }
    if (flags.running) {
      buttons.push(
        actionButton(h, {
          label: state.cancelling ? t('action.cancelling') : t('action.cancel'),
          variant: 'danger',
          disabled: state.cancelling,
          onClick: actions.cancelJob,
          key: 'cancel',
        }),
      );
    }
    return h('div', { className: 'fi-row' }, buttons);
  }

  /**
   * 破坏性确认条：预计修复数 + 快照/恢复文件提示 + workspace-write 风险。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 确认条或 null。
   */
  function renderConfirm(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    if (!state.confirmOpen) return null;
    var liveCount = state.workspaceMeta !== null ? state.workspaceMeta.liveAgentCount : 0;
    var children = [
      h('div', { className: 'fi-banner-title', key: 'title' }, t('repair.confirm.title')),
      h('div', { className: 'fi-banner-text', key: 'count' }, t('repair.confirm.count', { count: flags.confirmHits })),
      h('div', { className: 'fi-banner-text', key: 'backup' }, t('repair.confirm.backup')),
      h('div', { className: 'fi-banner-text', key: 'risk' }, t('repair.confirm.risk', { count: liveCount })),
      flags.engineRestricted ? h('div', { className: 'fi-banner-text', key: 'engine' }, t('repair.confirm.engineLimited')) : null,
      h(
        'div',
        { className: 'fi-row', key: 'buttons' },
        actionButton(h, {
          label: t('action.dismiss'),
          variant: 'ghost',
          onClick: actions.closeConfirm,
        }),
        actionButton(h, {
          label: t('action.confirm'),
          variant: 'danger',
          disabled: !flags.canRepair || state.starting,
          onClick: actions.startRepair,
        }),
      ),
    ];
    return h('div', { className: 'fi-card fi-card-danger' }, children);
  }

  /**
   * 阶段码 → 本地化阶段文案（枚举/读取/修复/验证各一句；未知阶段兜底显示原值）。
   *
   * @param t - locale 绑定函数。
   * @param phase - 引擎给的阶段码（可能为空/未知）。
   * @returns 可展示文案。
   */
  function phaseLabel(t, phase) {
    var code = typeof phase === 'string' ? phase : '';
    if (code === 'starting') return t('phase.starting');
    if (code === 'enumerate') return t('phase.enumerate');
    if (code === 'read') return t('phase.read');
    if (code === 'repair') return t('phase.repair');
    if (code === 'verify') return t('phase.verify');
    if (code !== '') return t('phase.other', { phase: code });
    return t('phase.waiting');
  }

  /**
   * 扫描选项：深度模式开关（关闭=快速模式）。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 选项卡片。
   */
  function renderScanOptions(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    var disabled = flags.running || state.starting;
    var inputProps = {
      type: 'checkbox',
      checked: state.deepScan === true,
      disabled: disabled,
      'aria-label': t('scan.depth.label'),
      onChange: actions.toggleDeepScan,
    };
    return h(
      'div',
      { className: 'fi-card' },
      h(
        'label',
        { className: 'fi-toggle' + (disabled ? ' is-disabled' : '') },
        h('input', inputProps),
        h('span', null, t('scan.depth.label')),
      ),
      h('div', { className: 'fi-muted' }, t('scan.depth.hint')),
    );
  }

  /**
   * 运行中：阶段 / 已扫描 / 命中 / 速率 / ETA / 耗时 + 进度条（取消按钮在动作行）。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 运行卡片或 null。
   */
  function renderRunning(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var flags = view.flags;
    if (!flags.running || state.job === null) return null;
    var job = state.job;
    var actionLabel = job.action === 'repair' ? t('action.label.repair') : t('action.label.scan');
    var done = job.action === 'repair' ? job.fixed + job.failedCount : job.scanned;
    var hasTotal = job.total > 0;
    var percent = hasTotal ? Math.max(0, Math.min(100, Math.round((done / job.total) * 100))) : 0;
    var rate = flags.rate;
    var rateText = rate > 0 ? t('job.rateValue', { rate: formatRate(rate) }) : t('job.rateEmpty');
    var etaText;
    if (!hasTotal) etaText = t('job.etaUnknown');
    else if (rate > 0) etaText = t('job.etaValue', { duration: formatDuration(flags.eta) });
    else etaText = t('job.etaCalculating');
    var children = [];
    children.push(
      h(
        'div',
        { className: 'fi-row', key: 'head' },
        h('span', { className: 'fi-label' }, t('job.running', { action: actionLabel })),
        h('span', { className: 'fi-spacer' }),
        h('span', { className: 'fi-muted' }, t('job.elapsed', { duration: formatDuration(flags.elapsed) })),
      ),
    );
    children.push(h('div', { className: 'fi-muted', key: 'phase' }, phaseLabel(t, job.phase)));
    children.push(
      h(
        'div',
        { className: 'fi-kv', key: 'scanned' },
        h('span', null, t('job.scanned', { scanned: job.scanned, total: hasTotal ? job.total : '?' })),
        h('span', { className: 'fi-kv-value' }, t('job.hits', { count: job.hits })),
      ),
    );
    children.push(
      h(
        'div',
        { className: 'fi-kv', key: 'rate' },
        h('span', null, t('job.rate')),
        h('span', { className: 'fi-kv-value' }, rateText),
      ),
    );
    children.push(
      h(
        'div',
        { className: 'fi-kv', key: 'eta' },
        h('span', null, t('job.eta')),
        h('span', { className: 'fi-kv-value' }, etaText),
      ),
    );
    if (hasTotal) {
      children.push(h('div', { className: 'fi-progress-track', key: 'progress' }, h('div', { className: 'fi-progress-fill', style: { width: percent + '%' } })));
    }
    return h('div', { className: 'fi-card' }, children);
  }

  /**
   * 扫描结果：两态 + 聚合计数（N 个 Low：X 显式 / Y 继承）+ 模式/引擎角标 + 继承项聚合说明。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 结果卡片或 null。
   */
  function renderScanResult(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    var scanJob = flags.scanJob;
    if (scanJob === null) return null;
    var depth = effectiveScanDepth(scanJob);
    var engineLabel =
      scanJob.engine === 'csharp'
        ? t('scan.engine.csharp')
        : scanJob.engine === 'powershell'
          ? t('scan.engine.powershell')
          : '';
    var children = [];
    if (scanJob.status === 'succeeded') {
      var badges = [h('span', { className: 'fi-badge', key: 'mode' }, depth === 'quick' ? t('scan.depth.quick') : t('scan.depth.deep'))];
      if (engineLabel !== '') badges.push(h('span', { className: 'fi-badge', key: 'engine' }, engineLabel));
      children.push(h('div', { className: 'fi-badges', key: 'badges' }, badges));
      if (scanJob.hits === 0) {
        children.push(banner(h, { tone: 'success', title: t('scan.result.none'), key: 'title' }));
      } else {
        children.push(
          banner(h, {
            tone: 'warn',
            title: t('scan.result.aggregate', {
              count: scanJob.hits,
              explicit: scanJob.explicitCount,
              inherited: scanJob.inheritedCount,
            }),
            key: 'title',
          }),
        );
      }
      if (scanJob.inheritedCount > 0) {
        var parents = countExplicitDirs(scanJob.items);
        var inheritedNote =
          depth === 'quick'
            ? parents > 0
              ? t('scan.inherited.quick', { count: scanJob.inheritedCount, parents: parents })
              : t('scan.inherited.quickPlain', { count: scanJob.inheritedCount })
            : t('scan.inherited.deep', { count: scanJob.inheritedCount });
        children.push(h('div', { className: 'fi-muted', key: 'inherited' }, inheritedNote));
      }
      if (scanJob.depth === '') {
        children.push(h('div', { className: 'fi-muted', key: 'legacy' }, t('scan.legacy')));
      }
      if (scanJob.truncated) {
        children.push(h('div', { className: 'fi-warn-text', key: 'truncated' }, t('scan.truncated')));
      }
      if (scanJob.scanned > 0 || scanJob.finishedAt > 0) {
        children.push(
          h(
            'div',
            { className: 'fi-muted', key: 'meta' },
            t('scan.result.meta', {
              scanned: scanJob.scanned,
              duration: formatDuration(Math.max(0, scanJob.finishedAt - scanJob.startedAt)),
            }),
          ),
        );
      }
      if (scanJob.rootLabel !== '') {
        children.push(h('div', { className: 'fi-muted', key: 'root' }, t('scan.result.root', { rootLabel: scanJob.rootLabel })));
      }
    } else if (scanJob.status === 'cancelled') {
      children.push(banner(h, { tone: 'info', title: t('job.cancelled'), key: 'title' }));
    } else {
      children.push(
        banner(h, {
          tone: 'error',
          title: t('scan.failed'),
          text: scanJob.message,
          key: 'title',
        }),
      );
    }
    return h('div', { className: 'fi-card' }, children);
  }

  /**
   * 清除结果：成功（N 项 + 复扫结果 + 快照/恢复路径）或失败（N 项失败）。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 结果卡片或 null。
   */
  function renderRepairResult(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    var job = flags.repairJob;
    if (job === null || !flags.repairTerminal) return null;
    var children = [];
    if (job.status === 'succeeded') {
      children.push(banner(h, { tone: 'success', title: t('repair.success', { count: job.fixed }), key: 'title' }));
      var remaining = remainingHitsOf(job);
      if (remaining === 0) {
        children.push(h('div', { className: 'fi-success-text', key: 'rescan' }, t('repair.rescan.none')));
      } else {
        children.push(h('div', { className: 'fi-warn-text', key: 'rescan' }, t('repair.rescan.found', { count: remaining })));
      }
      children.push(
        h(
          'div',
          { className: 'fi-muted', key: 'meta' },
          t('scan.result.meta', {
            scanned: job.scanned,
            duration: formatDuration(Math.max(0, job.finishedAt - job.startedAt)),
          }),
        ),
      );
      children.push(
        artifactRow(
          h,
          t,
          actions,
          t('repair.snapshot'),
          job.snapshotPath,
          'snapshot',
          function () {
            actions.openArtifactFolder(job.id, 'snapshot');
          },
          state.openingFolder === true,
        ),
      );
      children.push(
        artifactRow(
          h,
          t,
          actions,
          t('repair.restore'),
          job.restorePath,
          'restore',
          function () {
            actions.openArtifactFolder(job.id, 'restore');
          },
          state.openingFolder === true,
        ),
      );
    } else if (job.status === 'cancelled') {
      children.push(banner(h, { tone: 'info', title: t('job.cancelled'), key: 'title' }));
    } else {
      children.push(banner(h, { tone: 'error', title: t('repair.failed', { count: job.failedCount }), key: 'title' }));
      if (job.message !== '') {
        children.push(h('div', { className: 'fi-error-text', key: 'message' }, job.message));
      }
      if (job.fixed > 0) {
        children.push(h('div', { className: 'fi-muted', key: 'fixed' }, t('repair.partialFixed', { count: job.fixed })));
      }
    }
    return h('div', { className: 'fi-card' }, children);
  }

  /**
   * 命中清单：quick 只列显式项（继承项聚合说明）、deep 列全部；首屏 200 + 分页。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 清单卡片或 null。
   */
  function renderHits(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var flags = view.flags;
    if (!flags.showHits) return null;
    var scope = flags.listScope;
    // 展示范围再兜一层：即使 Host 给了全部 items，quick 也绝不逐行渲染继承项。
    var items = filterItemsByScope(state.items, scope);
    var total = flags.listTotal > 0 ? flags.listTotal : state.itemsTotal;
    var children = [];
    children.push(
      h(
        'div',
        { className: 'fi-row', key: 'head' },
        h('span', { className: 'fi-label' }, t('hits.title')),
        h(
          'span',
          { className: 'fi-badges' },
          h('span', { className: 'fi-badge', key: 'scope' }, scope === 'explicit' ? t('hits.badge.mode.quick') : t('hits.badge.mode.all')),
        ),
        h('span', { className: 'fi-spacer' }),
        h('span', { className: 'fi-muted' }, t('hits.shown', { shown: items.length, total: total })),
      ),
    );
    if (scope === 'explicit' && flags.inheritedRemaining > 0) {
      children.push(h('div', { className: 'fi-muted', key: 'quick-note' }, t('hits.quickNote', { count: flags.inheritedRemaining })));
    }
    if (items.length > 0) {
      children.push(
        h('div', { className: 'fi-hits', key: 'list' }, items.map(function (item, index) {
          return hitRow(h, t, actions, item, index);
        })),
      );
    } else {
      children.push(h('div', { className: 'fi-muted', key: 'empty' }, t('hits.empty')));
    }
    if (items.length < total) {
      children.push(
        h(
          'div',
          { className: 'fi-row', key: 'more' },
          actionButton(h, {
            label: state.itemsLoading ? t('loading.items') : t('action.loadMore'),
            variant: 'ghost',
            small: true,
            disabled: state.itemsLoading,
            onClick: actions.loadMore,
          }),
          h('span', { className: 'fi-muted' }, t('hits.more', { count: Math.max(0, total - items.length) })),
        ),
      );
    }
    if (state.itemsError !== null) {
      children.push(
        h('div', { className: 'fi-error-text', key: 'error' }, t('hits.loadFailed', { message: describeError(t, state.itemsError) })),
      );
    }
    return h('div', { className: 'fi-card' }, children);
  }

  /**
   * 清除失败列表（限制展示条数，其余只给计数）。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 失败列表卡片或 null。
   */
  /**
   * 把引擎诊断多行文本压成一行，供面板展示（日志文件已删除，诊断只在面板/接口里）。
   *
   * @param output - 引擎失败对象的 output 字段。
   * @returns 一行诊断文本（最长 360 字）。
   */
  function diagnosticLine(output) {
    var raw = asString(output);
    if (raw === '') return '';
    var text = raw.replace(/\s+/g, ' ').trim();
    if (text.length > 360) text = text.slice(0, 360) + '…';
    return text;
  }

  function renderFailures(view) {
    var h = view.h;
    var t = view.t;
    var flags = view.flags;
    var job = flags.repairJob;
    if (job === null || job.status !== 'failed') return null;
    // result.failed 带引擎可读诊断（Win32 码 / DACL before-after / guidance），优先展示；
    // 旧任务或没有 result.failed 时退回错误列表（只有 path/message）。
    var failures = job.failed.length > 0 ? job.failed : job.errors;
    if (failures.length === 0) return null;
    var shown = failures.slice(0, MAX_FAILURE_ROWS);
    var rows = shown.map(function (entry, index) {
      var text = entry.message !== '' ? entry.message : t('scan.failed');
      var detail = diagnosticLine(entry.output);
      return h(
        'div',
        { className: 'fi-failure', key: (entry.path || '') + '#' + index },
        h('code', { className: 'fi-path', title: entry.path !== '' ? entry.path : text }, entry.path !== '' ? entry.path : text),
        entry.path !== '' ? h('div', { className: 'fi-muted' }, text) : null,
        detail !== '' ? h('div', { className: 'fi-muted', title: detail }, detail) : null,
      );
    });
    var children = [h('div', { className: 'fi-row', key: 'head' }, h('span', { className: 'fi-label' }, t('repair.failures')))];
    children.push(h('div', { className: 'fi-list', key: 'list' }, rows));
    var reportedFailures = Math.max(job.errorCount, job.failedCount, failures.length);
    if (reportedFailures > shown.length) {
      children.push(h('div', { className: 'fi-muted', key: 'more' }, t('repair.failuresMore', { count: reportedFailures - shown.length })));
    }
    return h('div', { className: 'fi-card' }, children);
  }

  /**
   * 产物路径（导出清单 / 引擎报告）：生成后显示返回路径并可复制。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 产物卡片或 null。
   */
  function renderArtifacts(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var actions = view.actions;
    var rows = [];
    if (state.exportPath !== '') rows.push(artifactRow(h, t, actions, t('artifact.export'), state.exportPath, 'export'));
    // 引擎直写报告（task-4 起 Host 在 reportPath 存在时原样返回）：未导出时也可提前展示。
    var reportJob = state.scanJob !== null ? state.scanJob : state.job !== null && state.job.action === 'scan' ? state.job : null;
    var reportPath = reportJob !== null ? reportJob.reportPath : '';
    if (reportPath !== '' && reportPath !== state.exportPath) {
      rows.push(
        artifactRow(
          h,
          t,
          actions,
          t('artifact.report'),
          reportPath,
          'report',
          function () {
            actions.openArtifactFolder(reportJob.id, 'report');
          },
          state.openingFolder === true,
        ),
      );
    }
    if (rows.length === 0) return null;
    return h('div', { className: 'fi-card' }, rows);
  }

  /**
   * 尚未扫描时的引导文案。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 文案元素或 null。
   */
  function renderIntro(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var flags = view.flags;
    if (!state.loaded || flags.running || state.jobLoading) return null;
    if (flags.scanJob !== null || state.job !== null) return null;
    if (state.workspace === null) return null;
    return h('div', { className: 'fi-card' }, h('div', { className: 'fi-muted' }, t('intro.hint')));
  }

  /**
   * 恢复任务中。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 提示元素或 null。
   */
  function renderJobLoading(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    if (!state.jobLoading) return null;
    return h('div', { className: 'fi-muted' }, t('loading.job'));
  }

  /**
   * 底部宿主信息（版本 / 平台 / 引擎 / 注册表 / 警告）。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 底部元素或 null。
   */
  function renderFooter(view) {
    var h = view.h;
    var t = view.t;
    var state = view.state;
    var health = state.health;
    if (health === null) return null;
    var parts = [];
    if (health.version !== '') parts.push(t('health.version', { version: health.version }));
    parts.push(t('health.platform', { platform: health.platform !== '' ? health.platform : '—' }));
    if (health.engine !== null && health.engine.integrity !== '') {
      parts.push(t('footer.engine', { integrity: health.engine.integrity }));
    }
    if (health.registry !== null && health.registry.count > 0) {
      parts.push(t('footer.registry', { count: health.registry.count }));
    }
    var children = [h('div', { className: 'fi-muted', key: 'meta' }, parts.join(' · '))];
    // 产物目录：Host 在 /health 里给出时展示一行，并提示到设置页修改。
    if (health.dataDir !== '') {
      children.push(
        h('div', { className: 'fi-muted', key: 'dataDir' }, t('dataDir.panelValue', { path: health.dataDir })),
        h('div', { className: 'fi-muted', key: 'dataDirHint' }, t('dataDir.panelHint')),
      );
    }
    if (health.dataDirError !== '') {
      children.push(
        h('div', { className: 'fi-muted fi-warn-text', key: 'dataDirError' }, t('dataDir.error', { message: health.dataDirError })),
      );
    }
    if (health.warnings.length > 0) {
      children.push(
        h(
          'div',
          { className: 'fi-muted fi-warn-text', key: 'warnings' },
          t('health.warnings', { count: health.warnings.length, first: health.warnings.slice(0, 3).join('; ') }),
        ),
      );
    }
    return h('div', { className: 'fi-footer' }, children);
  }

  /**
   * 面板根元素（纯渲染，不含状态）。
   *
   * @param view - { h, t, state, actions, flags }。
   * @returns 根元素。
   */
  function renderPanel(view) {
    var h = view.h;
    return h(
      'div',
      { className: 'fi-panel' },
      renderHeader(view),
      renderWorkspace(view),
      renderBanners(view),
      renderIntro(view),
      renderScanOptions(view),
      renderActions(view),
      renderConfirm(view),
      renderJobLoading(view),
      renderRunning(view),
      renderScanResult(view),
      renderRepairResult(view),
      renderArtifacts(view),
      renderHits(view),
      renderFailures(view),
      renderFooter(view),
    );
  }

  //#endregion

  //#region 面板组件

  /**
   * 造面板组件（注入 React 与 locale 绑定；组件本身只在 apply 里创建一次）。
   *
   * @param runtime - { React, h, t }。
   * @returns 可直接注册到 sidebar.right.pane.tab 的组件。
   */
  function makePanel(runtime) {
    var React = runtime.React;
    var h = runtime.h;
    var t = runtime.t;

    /** slot 组件崩溃会让整块区域空白：这里兜住渲染异常并提供重试。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, attempt: 0 };
        this.handleRetry = this.handleRetry.bind(this);
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error(LOG_PREFIX + ' 面板渲染失败（已兜底，不影响页面）：', error);
      }

      handleRetry() {
        this.setState(function (prev) {
          return { failed: false, attempt: prev.attempt + 1 };
        });
      }

      render() {
        if (this.state.failed) {
          return h(
            'div',
            { className: 'fi-panel fi-fatal' },
            h('div', { className: 'fi-fatal-title' }, t('error.boundary')),
            h('button', { type: 'button', className: 'fi-btn', onClick: this.handleRetry }, t('action.retry')),
          );
        }
        // attempt 变化 → key 变化 → 子面板重新挂载一次（面板自愈的最后一招）。
        return h('div', { className: 'fi-fatal-holder', key: 'attempt-' + this.state.attempt }, this.props.children);
      }
    }

    /**
     * 面板主体。
     *
     * @param props - 插槽标准 props（sessionId 等）。
     * @returns 面板根元素。
     */
    function Panel(props) {
      var sessionId = readSessionId(props);

      var [state, setState] = React.useState(function () {
        return initialPanelState();
      });
      var [loadNonce, setLoadNonce] = React.useState(0);

      var mountedRef = React.useRef(true);
      var sessionIdRef = React.useRef(sessionId);
      sessionIdRef.current = sessionId;

      /**
       * 运行中进度采样：给速率/ETA 用。
       * 结构 { jobId, phase, samples:[{t,s}], rate, eta }；只在轮询回调里更新（不参与 hook 依赖）。
       */
      var progressRef = React.useRef({ jobId: '', phase: '', samples: [], rate: 0, eta: 0 });

      /**
       * 重置进度采样。
       *
       * @param jobId - 新任务 id；空串表示当前没有在跟踪的任务。
       */
      function resetProgress(jobId) {
        progressRef.current = { jobId: typeof jobId === 'string' ? jobId : '', phase: '', samples: [], rate: 0, eta: 0 };
      }

      /**
       * 记录一次任务进度：按当前阶段收集样本，估算速率与 ETA。
       * 阶段切换、任务切换都会清空样本，避免跨阶段混算。
       *
       * @param job - 归一化后的 task 快照。
       */
      function observeProgress(job) {
        if (job === null || typeof job !== 'object') return;
        var now = Date.now();
        if (progressRef.current.jobId !== job.id) resetProgress(job.id);
        var ref = progressRef.current;
        if (ref.phase !== job.phase) {
          ref.phase = job.phase;
          ref.samples = [];
          ref.rate = 0;
          ref.eta = 0;
        }
        var scanned = Math.max(0, job.scanned);
        var samples = ref.samples;
        var last = samples.length > 0 ? samples[samples.length - 1] : null;
        if (last === null || now - last.t >= 150) {
          samples.push({ t: now, s: scanned });
          while (samples.length > 8) samples.shift();
          while (samples.length > 2 && now - samples[0].t > 6000) samples.shift();
        } else {
          last.t = now;
          last.s = scanned;
        }
        var first = samples[0];
        var tail = samples[samples.length - 1];
        var dt = tail.t - first.t;
        var ds = tail.s - first.s;
        ref.rate = dt > 0 && ds > 0 ? ds / (dt / 1000) : 0;
        if (job.total > 0 && ref.rate > 0.01) ref.eta = (Math.max(0, job.total - scanned) / ref.rate) * 1000;
        else ref.eta = 0;
      }

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      /** 异步回调里判断「还是同一个面板、同一个会话」。 */
      function isCurrent(session) {
        return mountedRef.current === true && sessionIdRef.current === session;
      }

      /** 复制并展示提示。 */
      function copyValue(text) {
        if (typeof text !== 'string' || text === '') return;
        copyToClipboard(text).then(function (ok) {
          if (!mountedRef.current) return;
          setState(function (prev) {
            return Object.assign({}, prev, { notice: ok ? t('notice.copied') : t('notice.copyFailed') });
          });
        });
      }

      /** 切换下一次扫描的深度模式（快速 ↔ 深度）。 */
      function toggleDeepScan(event) {
        var checked = event !== null && typeof event === 'object' && event.target !== null && typeof event.target === 'object'
          ? event.target.checked === true
          : state.deepScan !== true;
        setState(function (prev) {
          return Object.assign({}, prev, { deepScan: checked });
        });
      }

      /** 发一次任务请求（扫描/清除共用）：成功后写入任务并交给轮询。 */
      function startJob(action) {
        if (sessionId === '' || state.starting) return;
        if (state.job !== null && state.job.status === 'running') return;
        var mySession = sessionId;
        var scanDepth = state.deepScan === true ? 'deep' : 'quick';
        var requestBody = action === 'scan' ? { action: 'scan', sessionId: mySession, depth: scanDepth } : { action: 'repair', sessionId: mySession };
        resetProgress('');
        setState(function (prev) {
          return Object.assign({}, prev, {
            starting: true,
            confirmOpen: false,
            actionError: null,
            pollError: null,
            notice: '',
            exportError: null,
          });
        });
        requestJson({ path: '/jobs', method: 'POST', body: requestBody }).then(function (res) {
          if (!isCurrent(mySession)) return;
          if (!res.ok) {
            setState(function (prev) {
              return Object.assign({}, prev, {
                starting: false,
                actionError: { code: res.code, message: res.message, context: action },
              });
            });
            return;
          }
          var jobId = res.data !== null && typeof res.data === 'object' ? asString(res.data.jobId) : '';
          if (jobId === '') {
            setState(function (prev) {
              return Object.assign({}, prev, { starting: false, actionError: { code: 'bad-response', message: '' } });
            });
            return;
          }
          writeStoredJob(mySession, jobId);
          setState(function (prev) {
            var patch = {
              starting: false,
              jobId: jobId,
              job: provisionalJob(action, jobId, scanDepth),
              pollError: null,
              actionError: null,
              now: Date.now(),
            };
            if (action === 'scan') {
              patch.scanJob = null;
              patch.items = [];
              patch.itemsTotal = 0;
              patch.itemsJobId = '';
              patch.itemsLoaded = false;
              patch.itemsError = null;
              patch.exportPath = '';
              patch.exportError = null;
            }
            return Object.assign({}, prev, patch);
          });
        });
      }

      /** 取消运行中的任务。 */
      function cancelJob() {
        var target = state.job;
        if (target === null || target.status !== 'running' || state.cancelling) return;
        var mySession = sessionId;
        setState(function (prev) {
          return Object.assign({}, prev, { cancelling: true, actionError: null });
        });
        requestJson({ path: '/jobs/' + encodeURIComponent(target.id) + '/cancel', method: 'POST', body: {} }).then(function (res) {
          if (!isCurrent(mySession)) return;
          if (!res.ok) {
            setState(function (prev) {
              var patch = { cancelling: false, actionError: { code: res.code, message: res.message } };
              if (res.code === 'job-not-found' || res.status === 404) {
                removeStoredJob(mySession);
                patch.job = null;
                patch.jobId = '';
              }
              return Object.assign({}, prev, patch);
            });
            return;
          }
          setState(function (prev) {
            return Object.assign({}, prev, { cancelling: false, notice: t('job.cancelled') });
          });
        });
      }

      /** 导出当前扫描清单，展示宿主返回的路径。 */
      function exportList() {
        var target = state.scanJob;
        if (target === null || target.status === 'running' || state.exporting) return;
        var mySession = sessionId;
        setState(function (prev) {
          return Object.assign({}, prev, { exporting: true, exportError: null });
        });
        requestJson({ path: '/jobs/' + encodeURIComponent(target.id) + '/export', method: 'POST', body: {} }).then(function (res) {
          if (!isCurrent(mySession)) return;
          if (!res.ok) {
            setState(function (prev) {
              return Object.assign({}, prev, { exporting: false, exportError: { code: res.code, message: res.message } });
            });
            return;
          }
          var path = res.data !== null && typeof res.data === 'object' ? asString(res.data.path) : '';
          setState(function (prev) {
            return Object.assign({}, prev, {
              exporting: false,
              exportPath: path,
              exportError: null,
              notice: path !== '' ? t('export.ok') : '',
            });
          });
        });
      }

      /** 打开快照/恢复文件或引擎报告所在文件夹（Host 校验路径后由系统资源管理器打开）。 */
      function openArtifactFolder(jobId, target) {
        if (typeof jobId !== 'string' || jobId === '' || state.openingFolder === true) return;
        var mySession = sessionId;
        var artifactTarget = target === 'restore' ? 'restore' : target === 'report' ? 'report' : 'snapshot';
        setState(function (prev) {
          return Object.assign({}, prev, { openingFolder: true, actionError: null });
        });
        requestJson({ path: '/open-folder', method: 'POST', body: { jobId: jobId, target: artifactTarget } }).then(function (res) {
          if (!isCurrent(mySession)) return;
          setState(function (prev) {
            if (res.ok) return Object.assign({}, prev, { openingFolder: false });
            return Object.assign({}, prev, {
              openingFolder: false,
              actionError: {
                code: res.code,
                message: res.message,
              },
            });
          });
        });
      }

      /** 命中清单分页：从已加载条数开始再取一页。 */
      function loadMore() {
        var jobId = state.itemsJobId;
        if (jobId === '' || state.itemsLoading) return;
        if (state.itemsTotal > 0 && state.items.length >= state.itemsTotal) return;
        var mySession = sessionId;
        var offset = state.items.length;
        setState(function (prev) {
          return Object.assign({}, prev, { itemsLoading: true, itemsError: null });
        });
        requestJson({
          path: '/jobs/' + encodeURIComponent(jobId) + '/items?offset=' + encodeURIComponent(String(offset)) + '&limit=' + PAGE_SIZE,
          method: 'GET',
        }).then(function (res) {
          if (!isCurrent(mySession)) return;
          if (!res.ok) {
            if (res.code === 'job-not-found' || res.status === 404) {
              removeStoredJob(mySession);
              setState(function (prev) {
                return Object.assign({}, prev, {
                  itemsLoading: false,
                  itemsError: null,
                  jobId: '',
                  job: null,
                  actionError: { code: 'job-not-found', message: '' },
                });
              });
              return;
            }
            setState(function (prev) {
              return Object.assign({}, prev, { itemsLoading: false, itemsError: { code: res.code, message: res.message } });
            });
            return;
          }
          var data = res.data !== null && typeof res.data === 'object' ? res.data : {};
          var pageItems = normalizeItems(data.items);
          var reportedTotal = typeof data.total === 'number' && isFinite(data.total) ? data.total : -1;
          setState(function (prev) {
            var merged = mergeItems(prev.items, pageItems);
            return Object.assign({}, prev, {
              itemsLoading: false,
              items: merged,
              itemsTotal: reportedTotal >= 0 ? reportedTotal : prev.itemsTotal,
              itemsLoaded: true,
              itemsError: null,
            });
          });
        });
      }

      /** 重新解析工作区 / 重试加载（含 health 与任务恢复）。 */
      function retryLoad() {
        setLoadNonce(function (prev) {
          return prev + 1;
        });
      }

      /** 打开破坏性确认条。 */
      function openConfirm() {
        setState(function (prev) {
          return Object.assign({}, prev, { confirmOpen: true, actionError: null });
        });
      }

      /** 收起确认条。 */
      function closeConfirm() {
        setState(function (prev) {
          return Object.assign({}, prev, { confirmOpen: false });
        });
      }

      // ---- 加载：health + workspace + 任务恢复（会话切换时重置） ----
      React.useEffect(
        function () {
          var alive = true;
          var controller = typeof AbortController === 'function' ? new AbortController() : null;
          var signal = controller === null ? undefined : controller.signal;

          setState(function () {
            return initialPanelState();
          });
          resetProgress('');

          if (sessionId === '') {
            setState(function (prev) {
              return Object.assign({}, prev, {
                loaded: true,
                workspaceError: { code: 'no-session', message: '' },
              });
            });
            return function () {
              alive = false;
              if (controller !== null) controller.abort();
            };
          }

          function isAlive() {
            return alive === true && mountedRef.current === true && sessionIdRef.current === sessionId;
          }

          function restoreJob() {
            var storedJobId = readStoredJob(sessionId);
            if (storedJobId === '') return;
            setState(function (prev) {
              return Object.assign({}, prev, { jobLoading: true });
            });
            requestJson({ path: '/jobs/' + encodeURIComponent(storedJobId), method: 'GET', signal: signal }).then(function (res) {
              if (!isAlive()) return;
              if (!res.ok) {
                if (res.code === 'job-not-found' || res.status === 404) {
                  removeStoredJob(sessionId);
                  setState(function (prev) {
                    return Object.assign({}, prev, {
                      jobLoading: false,
                      jobId: '',
                      job: null,
                      actionError: { code: 'job-not-found', message: '' },
                    });
                  });
                } else if (!res.aborted) {
                  setState(function (prev) {
                    return Object.assign({}, prev, { jobLoading: false, pollError: { code: res.code, message: res.message } });
                  });
                }
                return;
              }
              var restored = normalizeJob(res.data !== null && typeof res.data === 'object' ? res.data.job : null);
              if (restored === null) {
                removeStoredJob(sessionId);
                setState(function (prev) {
                  return Object.assign({}, prev, { jobLoading: false, actionError: { code: 'bad-response', message: '' } });
                });
                return;
              }
              observeProgress(restored);
              var restorePatch = { jobLoading: false };
              // 恢复到的扫描任务是什么模式，开关就回显什么模式（下一次重扫沿用它）。
              if (restored.action === 'scan') restorePatch.deepScan = effectiveScanDepth(restored) === 'deep';
              setState(function (prev) {
                return Object.assign({}, prev, restorePatch, jobPatch(prev, restored));
              });
            });
          }

          Promise.all([
            requestJson({ path: '/health', method: 'GET', signal: signal }),
            requestJson({ path: '/workspace', method: 'POST', body: { sessionId: sessionId }, signal: signal }),
          ]).then(function (results) {
            if (!isAlive()) return;
            var healthRes = results[0];
            var workspaceRes = results[1];
            var patch = { loaded: true, now: Date.now() };
            if (healthRes.ok === true) {
              var health = normalizeHealth(healthRes.data);
              patch.health = health;
              patch.healthError = health.platform === '' ? { code: 'bad-response', message: '' } : null;
            } else if (healthRes.aborted !== true) {
              patch.healthError = { code: healthRes.code, message: healthRes.message };
            }
            if (workspaceRes.ok === true) {
              var workspace = normalizeWorkspace(workspaceRes.data !== null && typeof workspaceRes.data === 'object' ? workspaceRes.data.workspace : null);
              if (workspace === null) {
                patch.workspace = null;
                patch.workspaceError = { code: 'bad-response', message: '' };
              } else {
                patch.workspace = workspace;
                patch.workspaceMeta = normalizeWorkspaceMeta(workspaceRes.data);
                patch.workspaceError = null;
              }
            } else if (workspaceRes.aborted !== true) {
              patch.workspaceError = { code: workspaceRes.code, message: workspaceRes.message };
            }
            setState(function (prev) {
              return Object.assign({}, prev, patch);
            });
            restoreJob();
          });

          return function () {
            alive = false;
            if (controller !== null) controller.abort();
          };
        },
        [sessionId, loadNonce],
      );

      // ---- 轮询：运行中的任务每 800ms 刷新一次；cleanup 清定时器与 AbortController ----
      var pollStatus = state.job !== null ? state.job.status : '';
      React.useEffect(
        function () {
          if (state.jobId === '' || pollStatus !== 'running') return undefined;
          var jobId = state.jobId;
          var mySession = sessionId;
          var disposed = false;
          var busy = false;
          var controller = null;

          function tick() {
            if (disposed || busy) return;
            busy = true;
            controller = typeof AbortController === 'function' ? new AbortController() : null;
            var signal = controller === null ? undefined : controller.signal;
            requestJson({ path: '/jobs/' + encodeURIComponent(jobId), method: 'GET', signal: signal })
              .then(function (res) {
                if (disposed) return;
                if (!res.ok) {
                  if (res.code === 'job-not-found' || res.status === 404) {
                    removeStoredJob(mySession);
                    setState(function (prev) {
                      return Object.assign({}, prev, {
                        jobId: '',
                        job: null,
                        jobLoading: false,
                        actionError: { code: 'job-not-found', message: '' },
                      });
                    });
                    return;
                  }
                  if (res.aborted !== true) {
                    setState(function (prev) {
                      return Object.assign({}, prev, { pollError: { code: res.code, message: res.message }, now: Date.now() });
                    });
                  }
                  return;
                }
                var job = normalizeJob(res.data !== null && typeof res.data === 'object' ? res.data.job : null);
                if (job === null) {
                  setState(function (prev) {
                    return Object.assign({}, prev, { pollError: { code: 'bad-response', message: '' }, now: Date.now() });
                  });
                  return;
                }
                observeProgress(job);
                setState(function (prev) {
                  return Object.assign({}, prev, jobPatch(prev, job), { pollError: null });
                });
              })
              .then(function () {
                busy = false;
              });
          }

          var timer = window.setInterval(tick, POLL_INTERVAL_MS);
          tick();
          return function () {
            disposed = true;
            if (timer !== undefined && timer !== null) window.clearInterval(timer);
            if (controller !== null) controller.abort();
          };
        },
        [sessionId, state.jobId, pollStatus],
      );

      // ---- 提示自动消失 ----
      React.useEffect(
        function () {
          if (state.notice === '') return undefined;
          var timer = window.setTimeout(function () {
            setState(function (prev) {
              return Object.assign({}, prev, { notice: '' });
            });
          }, NOTICE_MS);
          return function () {
            window.clearTimeout(timer);
          };
        },
        [state.notice],
      );

      // ---- 派生视图状态 ----
      var health = state.health;
      var platform = health !== null ? health.platform : '';
      var readOnly = health !== null && platform !== '' && platform !== 'win32';
      var engineReady = health !== null && health.engine !== null && health.engine.available !== false;
      // Host 提示：canWriteLabel === false，或当前进程完整性标签不是 Medium 时无法写回 Medium。
      var engineRestricted =
        health !== null &&
        health.engine !== null &&
        (health.engine.canWriteLabel === false ||
          (health.engine.integrity !== '' && health.engine.integrity !== 'Medium'));
      var writable = health !== null && platform === 'win32' && engineReady;
      var job = state.job;
      var running = job !== null && job.status === 'running';
      var scanJob = state.scanJob !== null && state.scanJob.status !== 'running' ? state.scanJob : null;
      var repairJob = job !== null && job.action === 'repair' ? job : null;
      var repairTerminal = repairJob !== null && repairJob.status !== 'running';
      var workspace = state.workspace;
      var liveAgentCount = state.workspaceMeta !== null ? state.workspaceMeta.liveAgentCount : 0;
      var canScan = workspace !== null && sessionId !== '' && writable && !running && !state.starting;
      var showExport = scanJob !== null && scanJob.hits > 0;
      var canExport = showExport && !running && !state.exporting && !readOnly;
      var showRepair = scanJob !== null && scanJob.hits > 0;
      var canRepair = showRepair && writable && !engineRestricted && !running && !state.starting;
      var showHits = state.itemsTotal > 0 || state.items.length > 0;
      // 清单范围：优先看最近一次扫描结果的 depth/itemsScope；没有扫描结果时按 all 处理。
      var listJob = scanJob !== null ? scanJob : job !== null && job.action === 'scan' ? job : null;
      var listScope = listJob !== null ? effectiveItemsScope(listJob) : 'all';
      var inheritedRemaining = listScope === 'explicit' && scanJob !== null ? scanJob.inheritedCount : 0;
      var progress = progressRef.current;
      var elapsed = 0;
      if (job !== null) {
        var startAt = job.startedAt;
        var endAt = job.status === 'running' ? state.now : job.finishedAt !== 0 ? job.finishedAt : state.now;
        if (startAt > 0 && endAt >= startAt) elapsed = endAt - startAt;
      }
      var flags = {
        readOnly: readOnly,
        writable: writable,
        engineReady: engineReady,
        engineRestricted: engineRestricted,
        platform: platform,
        running: running,
        job: job,
        scanJob: scanJob,
        repairJob: repairJob,
        repairTerminal: repairTerminal,
        liveAgentCount: liveAgentCount,
        canScan: canScan,
        showExport: showExport,
        canExport: canExport,
        showRepair: showRepair,
        canRepair: canRepair,
        showHits: showHits,
        confirmHits: scanJob !== null ? scanJob.hits : state.itemsTotal,
        elapsed: elapsed,
        deepScan: state.deepScan === true,
        listScope: listScope,
        listTotal: state.itemsTotal,
        inheritedRemaining: inheritedRemaining,
        rate: running ? progress.rate : 0,
        eta: running ? progress.eta : 0,
      };
      var actions = {
        copy: copyValue,
        retryLoad: retryLoad,
        toggleDeepScan: toggleDeepScan,
        startScan: function () {
          startJob('scan');
        },
        startRepair: function () {
          startJob('repair');
        },
        openConfirm: openConfirm,
        closeConfirm: closeConfirm,
        cancelJob: cancelJob,
        exportList: exportList,
        openArtifactFolder: openArtifactFolder,
        loadMore: loadMore,
      };

      return renderPanel({ h: h, t: t, state: state, actions: actions, flags: flags });
    }

    /**
     * 注册到插槽的组件：外层先挂错误边界，任何渲染异常都不会让整块侧栏空白。
     *
     * @param props - 插槽标准 props。
     * @returns 面板元素。
     */
    return function LowIntegrityPanel(props) {
      return h(PanelBoundary, null, h(Panel, props));
    };
  }

  /**
   * 面板初始状态（每个会话/每次重载都从干净状态开始）。
   *
   * @returns 初始状态对象。
   */
  function initialPanelState() {
    return {
      loaded: false,
      health: null,
      healthError: null,
      workspace: null,
      workspaceMeta: null,
      workspaceError: null,
      job: null,
      scanJob: null,
      jobId: '',
      jobLoading: false,
      pollError: null,
      items: [],
      itemsTotal: 0,
      itemsJobId: '',
      itemsLoaded: false,
      itemsLoading: false,
      itemsError: null,
      exporting: false,
      exportPath: '',
      exportError: null,
      openingFolder: false,
      confirmOpen: false,
      starting: false,
      cancelling: false,
      actionError: null,
      notice: '',
      deepScan: false,
      now: 0,
    };
  }

  //#endregion

  //#region 设置页组件

  /**
   * 设置页初始状态。
   *
   * @returns { loading, loadError, dataDir, defaultDataDir, isDefault, input, saving, saveError,
   *   pickError, notice, retentionDays, retentionPresets, retentionChoice, retentionInput, lastCleanup }。
   */
  function initialSettingsState() {
    return {
      loading: true,
      loadError: null,
      dataDir: '',
      defaultDataDir: '',
      isDefault: true,
      input: '',
      saving: false,
      saveError: null,
      pickError: '',
      notice: '',
      retentionDays: RETENTION_DEFAULT_DAYS,
      retentionPresets: RETENTION_PRESETS.slice(),
      retentionChoice: RETENTION_DEFAULT_DAYS,
      retentionInput: '',
      lastCleanup: null,
    };
  }

  /**
   * 造设置页组件（注册到 settings.section）：读取/保存产物目录与自动清理保留天数，
   * 可选择文件夹并展示上次清理结果。
   *
   * @param runtime - { React, h, t, pickDirectory }（pickDirectory 为 null 表示平台不支持选择）。
   * @returns 可直接注册到 settings.section 的组件。
   */
  function makeSettingsPage(runtime) {
    var React = runtime.React;
    var h = runtime.h;
    var t = runtime.t;
    var pickDirectory = typeof runtime.pickDirectory === 'function' ? runtime.pickDirectory : null;

    /** 设置页崩溃会让整块设置区域空白：兜住渲染异常并提供重试。 */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, attempt: 0 };
        this.handleRetry = this.handleRetry.bind(this);
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error(LOG_PREFIX + ' 设置页渲染失败（已兜底，不影响页面）：', error);
      }

      handleRetry() {
        this.setState(function (prev) {
          return { failed: false, attempt: prev.attempt + 1 };
        });
      }

      render() {
        if (this.state.failed) {
          return h(
            'div',
            { className: 'fi-settings fi-fatal' },
            h('div', { className: 'fi-fatal-title' }, t('error.boundary')),
            h('button', { type: 'button', className: 'fi-btn', onClick: this.handleRetry }, t('action.retry')),
          );
        }
        // attempt 变化 → key 变化 → 重新挂载一次（设置页自愈的最后一招）。
        return h('div', { className: 'fi-fatal-holder', key: 'attempt-' + this.state.attempt }, this.props.children);
      }
    }

    /**
     * 设置页主体。
     *
     * @param props - 设置插槽标准 props（close 等；本页按需忽略）。
     * @returns 设置页根元素。
     */
    function SettingsPage(props) {
      var [state, setState] = React.useState(function () {
        return initialSettingsState();
      });
      var [loadNonce, setLoadNonce] = React.useState(0);
      var mountedRef = React.useRef(true);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      // 挂载与「重试」时各读取一次当前设置；成功后把当前值填进输入框。
      React.useEffect(
        function () {
          var alive = true;
          setState(function (prev) {
            return Object.assign({}, prev, { loading: true, loadError: null, saveError: null, pickError: '' });
          });
          requestJson({ path: '/settings', method: 'GET' }).then(function (res) {
            if (!alive) return;
            if (!res.ok) {
              setState(function (prev) {
                return Object.assign({}, prev, { loading: false, loadError: { code: res.code, message: res.message } });
              });
              return;
            }
            var data = res.data !== null && typeof res.data === 'object' ? res.data : {};
            var dataDir = asString(data.dataDir);
            var retentionDays = asRetentionDays(data.retentionDays);
            var presets = normalizeRetentionPresets(data.retentionPresets);
            setState(function (prev) {
              var retentionView = retentionViewOf(retentionDays, presets);
              return Object.assign({}, prev, {
                loading: false,
                loadError: null,
                dataDir: dataDir,
                defaultDataDir: asString(data.defaultDataDir),
                isDefault: data.isDefault === true,
                input: dataDir,
                notice: '',
                retentionDays: retentionDays,
                retentionPresets: presets,
                retentionChoice: retentionView.choice,
                retentionInput: retentionView.input,
                lastCleanup: normalizeLastCleanup(data.lastCleanup),
              });
            });
          });
          return function () {
            alive = false;
          };
        },
        [loadNonce],
      );

      // 保存成功提示自动消失。
      React.useEffect(
        function () {
          if (state.notice === '') return undefined;
          var timer = window.setTimeout(function () {
            if (!mountedRef.current) return;
            setState(function (prev) {
              return Object.assign({}, prev, { notice: '' });
            });
          }, NOTICE_MS);
          return function () {
            window.clearTimeout(timer);
          };
        },
        [state.notice],
      );

      /** 当前选择对应的保留天数；自定义非法时 null。 */
      function effectiveRetentionDays() {
        if (state.retentionChoice === 'custom') return parseRetentionDays(state.retentionInput);
        return typeof state.retentionChoice === 'number' ? state.retentionChoice : null;
      }

      /**
       * 提交设置：产物目录 + 保留天数一起保存。
       *
       * @param options - { resetDirectory?: boolean }；true 时只把产物目录恢复默认，保留天数保持当前值。
       */
      function saveSettings(options) {
        if (state.saving === true) return;
        var opts = options !== null && typeof options === 'object' ? options : {};
        var isReset = opts.resetDirectory === true;
        var body = { dataDir: isReset ? '' : state.input.trim() };
        if (!isReset) {
          var retentionDays = effectiveRetentionDays();
          if (retentionDays === null) return; // 自定义天数非法：保存按钮已禁用，这里兜底
          body.retentionDays = retentionDays;
        }
        setState(function (prev) {
          return Object.assign({}, prev, { saving: true, saveError: null, pickError: '', notice: '' });
        });
        requestJson({ path: '/settings', method: 'POST', body: body }).then(function (res) {
          if (!mountedRef.current) return;
          if (!res.ok) {
            setState(function (prev) {
              return Object.assign({}, prev, { saving: false, saveError: { code: res.code, message: res.message } });
            });
            return;
          }
          var data = res.data !== null && typeof res.data === 'object' ? res.data : {};
          var nextDir = asString(data.dataDir);
          var nextDefault = asString(data.defaultDataDir);
          var nextRetention = asRetentionDays(data.retentionDays);
          setState(function (prev) {
            var patch = {
              saving: false,
              saveError: null,
              dataDir: nextDir,
              defaultDataDir: nextDefault !== '' ? nextDefault : prev.defaultDataDir,
              isDefault: data.isDefault === true,
              input: nextDir,
              notice: isReset ? t('settings.resetDone') : t('settings.saved'),
            };
            // 恢复默认只重置目录：保留天数的选择与当前值都保持不动。
            if (!isReset) {
              var retentionView = retentionViewOf(nextRetention, prev.retentionPresets);
              patch.retentionDays = nextRetention;
              patch.retentionChoice = retentionView.choice;
              patch.retentionInput = retentionView.input;
            }
            return Object.assign({}, prev, patch);
          });
        });
      }

      /**
       * 选中一个预设保留天数。
       *
       * @param days - 预设天数。
       */
      function selectRetentionPreset(days) {
        setState(function (prev) {
          return Object.assign({}, prev, { retentionChoice: days, saveError: null });
        });
      }

      /** 切到「自定义」：保留已有输入，为空时回填当前保留天数。 */
      function selectCustomRetention() {
        setState(function (prev) {
          var input = prev.retentionInput !== '' ? prev.retentionInput : String(prev.retentionDays);
          return Object.assign({}, prev, { retentionChoice: 'custom', retentionInput: input, saveError: null });
        });
      }

      /**
       * 自定义天数输入变化。
       *
       * @param event - React change 事件。
       */
      function changeRetentionInput(event) {
        var value = '';
        if (event !== null && typeof event === 'object' && event.target !== null && typeof event.target === 'object') {
          value = asString(event.target.value);
        }
        setState(function (prev) {
          return Object.assign({}, prev, { retentionInput: value, saveError: null });
        });
      }

      /**
       * 造一个预设保留天数按钮。
       *
       * @param days - 预设天数。
       * @returns 分段按钮。
       */
      function retentionPresetButton(days) {
        return actionButton(h, {
          label: t('settings.retention.option', { days: days }),
          variant: state.retentionChoice === days ? 'primary' : 'ghost',
          small: true,
          disabled: state.saving === true,
          onClick: function () {
            selectRetentionPreset(days);
          },
          key: 'preset-' + days,
        });
      }

      /** 选择文件夹并填入输入框（服务缺失时按钮已禁用）。 */
      function pickFolder() {
        if (pickDirectory === null || state.saving === true) return;
        var pending;
        try {
          pending = pickDirectory();
        } catch (error) {
          setState(function (prev) {
            return Object.assign({}, prev, { pickError: errorMessageOf(error) });
          });
          return;
        }
        Promise.resolve(pending).then(
          function (dir) {
            if (!mountedRef.current) return;
            if (typeof dir === 'string' && dir !== '') {
              setState(function (prev) {
                return Object.assign({}, prev, { input: dir, pickError: '', saveError: null });
              });
            }
          },
          function (error) {
            if (!mountedRef.current) return;
            setState(function (prev) {
              return Object.assign({}, prev, { pickError: errorMessageOf(error) });
            });
          },
        );
      }

      /**
       * 输入框变化。
       *
       * @param event - React change 事件。
       */
      function changeInput(event) {
        var value = '';
        if (event !== null && typeof event === 'object' && event.target !== null && typeof event.target === 'object') {
          value = asString(event.target.value);
        }
        setState(function (prev) {
          return Object.assign({}, prev, { input: value, saveError: null });
        });
      }

      /**
       * 输入框回车 = 保存。
       *
       * @param event - React keydown 事件。
       */
      function submitOnEnter(event) {
        if (event !== null && typeof event === 'object' && event.key === 'Enter') {
          event.preventDefault();
          saveSettings({});
        }
      }

      var children = [
        h(
          'div',
          { className: 'fi-head', key: 'head' },
          h(
            'div',
            { className: 'fi-head-main' },
            h('div', { className: 'fi-title' }, t('settings.title')),
            h('div', { className: 'fi-sub' }, t('settings.description')),
          ),
        ),
      ];

      if (state.loading === true) {
        children.push(h('div', { className: 'fi-muted', key: 'loading' }, t('settings.loading')));
        return h('div', { className: 'fi-settings' }, children);
      }
      if (state.loadError !== null) {
        children.push(
          banner(h, {
            tone: 'error',
            title: t('settings.loadFailed', { message: describeError(t, state.loadError) }),
            key: 'load-error',
          }),
        );
        children.push(
          h(
            'div',
            { className: 'fi-row', key: 'retry' },
            actionButton(h, {
              label: t('action.retry'),
              variant: 'ghost',
              onClick: function () {
                setLoadNonce(function (prev) {
                  return prev + 1;
                });
              },
            }),
          ),
        );
        return h('div', { className: 'fi-settings' }, children);
      }

      var disabled = state.saving === true;
      var placeholder = state.defaultDataDir !== '' ? state.defaultDataDir : t('settings.placeholder');
      var retentionInvalid = state.retentionChoice === 'custom' && parseRetentionDays(state.retentionInput) === null;
      var saveDisabled = disabled || retentionInvalid;
      var buttons = [];
      buttons.push(
        actionButton(h, {
          label: t('action.pickFolder'),
          variant: 'ghost',
          disabled: disabled || pickDirectory === null,
          title: pickDirectory === null ? t('settings.pickUnavailable') : '',
          onClick: pickFolder,
          key: 'pick',
        }),
      );
      buttons.push(
        actionButton(h, {
          label: disabled ? t('action.saving') : t('action.save'),
          variant: 'primary',
          disabled: saveDisabled,
          onClick: function () {
            saveSettings({});
          },
          key: 'save',
        }),
      );
      buttons.push(
        actionButton(h, {
          label: t('action.resetDefault'),
          variant: 'ghost',
          disabled: disabled || state.isDefault === true,
          onClick: function () {
            saveSettings({ resetDirectory: true });
          },
          key: 'reset',
        }),
      );

      var cardChildren = [];
      cardChildren.push(h('span', { className: 'fi-label', key: 'current-label' }, t('settings.current')));
      if (state.dataDir !== '') {
        cardChildren.push(h('code', { className: 'fi-path', key: 'current-value', title: state.dataDir }, state.dataDir));
      } else {
        cardChildren.push(h('div', { className: 'fi-muted', key: 'current-value' }, t('settings.currentEmpty')));
      }
      cardChildren.push(
        h(
          'label',
          { className: 'fi-col', key: 'input' },
          h('span', { className: 'fi-label' }, t('settings.inputLabel')),
          h('input', {
            className: 'fi-settings-input',
            type: 'text',
            value: state.input,
            placeholder: placeholder,
            spellCheck: false,
            disabled: disabled,
            'aria-label': t('settings.inputLabel'),
            onChange: changeInput,
            onKeyDown: submitOnEnter,
          }),
        ),
      );
      if (state.defaultDataDir !== '') {
        cardChildren.push(h('div', { className: 'fi-muted', key: 'default' }, t('settings.defaultHint', { path: state.defaultDataDir })));
      }
      children.push(h('div', { className: 'fi-card', key: 'data-dir-card' }, cardChildren));

      // 自动清理卡片：保留天数（预设 + 自定义）、清理范围提示、上次清理结果。
      var retentionChildren = [];
      retentionChildren.push(h('span', { className: 'fi-label', key: 'title' }, t('settings.retention.title')));
      retentionChildren.push(
        h('div', { className: 'fi-muted', key: 'current' }, t('settings.retention.current', { days: state.retentionDays })),
      );
      retentionChildren.push(h('span', { className: 'fi-label', key: 'label' }, t('settings.retention.label')));
      var segmentNodes = [];
      for (var presetIndex = 0; presetIndex < state.retentionPresets.length; presetIndex++) {
        segmentNodes.push(retentionPresetButton(state.retentionPresets[presetIndex]));
      }
      segmentNodes.push(
        actionButton(h, {
          label: t('settings.retention.custom'),
          variant: state.retentionChoice === 'custom' ? 'primary' : 'ghost',
          small: true,
          disabled: disabled,
          onClick: selectCustomRetention,
          key: 'custom',
        }),
      );
      retentionChildren.push(h('div', { className: 'fi-seg', key: 'segments' }, segmentNodes));
      if (state.retentionChoice === 'custom') {
        retentionChildren.push(
          h(
            'label',
            { className: 'fi-col', key: 'custom-input' },
            h('span', { className: 'fi-label' }, t('settings.retention.customLabel')),
            h('input', {
              className: 'fi-settings-input fi-settings-number',
              type: 'number',
              min: RETENTION_MIN_DAYS,
              max: RETENTION_MAX_DAYS,
              step: 1,
              value: state.retentionInput,
              placeholder: String(state.retentionDays),
              disabled: disabled,
              'aria-label': t('settings.retention.customLabel'),
              onChange: changeRetentionInput,
              onKeyDown: submitOnEnter,
            }),
          ),
        );
        if (retentionInvalid) {
          retentionChildren.push(h('div', { className: 'fi-error-text', key: 'custom-error' }, t('settings.retention.invalid')));
        }
      }
      retentionChildren.push(h('div', { className: 'fi-muted', key: 'scope-hint' }, t('settings.retention.scopeHint')));
      retentionChildren.push(h('span', { className: 'fi-label', key: 'last-title' }, t('settings.retention.lastTitle')));
      if (state.lastCleanup === null) {
        retentionChildren.push(h('div', { className: 'fi-muted', key: 'last-never' }, t('settings.retention.never')));
      } else {
        var lastCleanup = state.lastCleanup;
        var lastAtText = formatDateTime(lastCleanup.at);
        retentionChildren.push(
          h(
            'div',
            { className: 'fi-muted', key: 'last-at' },
            t('settings.retention.lastAt', { time: lastAtText !== '' ? lastAtText : '—' }),
          ),
        );
        retentionChildren.push(
          h(
            'div',
            { className: 'fi-muted', key: 'last-count' },
            t('settings.retention.lastCount', {
              count: lastCleanup.deletedCount,
              size: formatBytes(lastCleanup.freedBytes),
            }),
          ),
        );
        if (lastCleanup.error !== '') {
          retentionChildren.push(
            h('div', { className: 'fi-warn-text', key: 'last-error' }, t('settings.retention.lastError', { message: lastCleanup.error })),
          );
        }
      }
      children.push(h('div', { className: 'fi-card', key: 'retention-card' }, retentionChildren));
      children.push(h('div', { className: 'fi-muted', key: 'apply-hint' }, t('settings.applyHint')));
      children.push(h('div', { className: 'fi-row', key: 'actions' }, buttons));

      if (state.saveError !== null) {
        children.push(banner(h, { tone: 'error', text: describeError(t, state.saveError), key: 'save-error' }));
      }
      if (state.pickError !== '') {
        children.push(
          banner(h, {
            tone: 'error',
            text: t('settings.pickFailed', { message: state.pickError !== '' ? state.pickError : '—' }),
            key: 'pick-error',
          }),
        );
      }
      if (state.notice !== '') {
        children.push(banner(h, { tone: 'success', text: state.notice, key: 'notice' }));
      }
      return h('div', { className: 'fi-settings' }, children);
    }

    /**
     * 注册到插槽的组件：外层先挂错误边界。
     *
     * @param props - 设置插槽标准 props。
     * @returns 设置页元素。
     */
    return function LowIntegritySettingsPage(props) {
      return h(SettingsBoundary, null, h(SettingsPage, props));
    };
  }

  //#endregion

  //#region 会话行紫点组件

  /**
   * 从组件自身 DOM 向上最多 6 层找会话行（A/BUTTON/LI 或 role=button/treeitem）。
   *
   * @param node - 紫点容器元素。
   * @returns 会话行元素；找不到时 null。
   */
  function findSessionRowNode(node) {
    var current = node;
    for (var depth = 0; depth < 6; depth++) {
      if (current === null || current === undefined || typeof current !== 'object') return null;
      var tag = typeof current.tagName === 'string' ? current.tagName.toUpperCase() : '';
      var role = typeof current.getAttribute === 'function' ? current.getAttribute('role') : null;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'LI' || role === 'button' || role === 'treeitem') return current;
      current = current.parentElement !== undefined ? current.parentElement : null;
    }
    return null;
  }

  /**
   * 造会话列表行 leading occupant：任务结束未读时画紫色实心点，否则画 idle 空心点。
   *
   * 宿主只在该行主状态 idle 时把 16px 状态圆点单元格让给 occupant，所以非未读时
   * 必须补一个近似宿主的空心圆，避免所有会话行的状态点消失。
   *
   * @param runtime - { React, h, t, watcher }。
   * @returns 可注册到 sidebar.session.row.leading 的组件。
   */
  function makeSessionLeadingDot(runtime) {
    var React = runtime.React;
    var h = runtime.h;
    var t = runtime.t;
    var watcher = runtime.watcher;

    /**
     * 会话行 leading occupant。
     *
     * @param props - 行 ownerProps（只含 sessionId）。
     * @returns 16px 单元格内的状态点。
     */
    function SessionLeadingDot(props) {
      var sessionId = readSessionId(props);
      var mountedRef = React.useRef(true);
      var dotRef = React.useRef(null);
      var sessionIdRef = React.useRef(sessionId);
      sessionIdRef.current = sessionId;

      var [unread, setUnread] = React.useState(function () {
        return sessionId !== '' && watcher.isUnread(sessionId);
      });

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      // 订阅 watcher：任何行状态变化时同步本行。
      React.useEffect(
        function () {
          var sid = sessionId;
          var sync = function () {
            if (!mountedRef.current) return;
            setUnread(sid !== '' && watcher.isUnread(sid));
          };
          var unsubscribe = watcher.subscribe(sync);
          sync();
          return function () {
            unsubscribe();
          };
        },
        [sessionId],
      );

      // 点击会话行（捕获阶段）时清除未读：祖先最多找 6 层，找不到退化为父元素。
      React.useEffect(
        function () {
          var node = dotRef.current;
          if (node === null || node === undefined) return undefined;
          var row = findSessionRowNode(node);
          var target =
            row !== null ? row : node.parentElement !== null && node.parentElement !== undefined ? node.parentElement : node;
          if (target === null || target === undefined || typeof target.addEventListener !== 'function') return undefined;
          var onClick = function () {
            var sid = sessionIdRef.current;
            if (sid !== '' && watcher.isUnread(sid)) watcher.ack(sid);
          };
          target.addEventListener('click', onClick, true);
          return function () {
            target.removeEventListener('click', onClick, true);
          };
        },
        [sessionId],
      );

      var unreadNow = unread === true;
      var containerProps = {
        ref: dotRef,
        className: 'fi-session-leading',
        'data-fi-unread': unreadNow ? '1' : '0',
      };
      if (unreadNow) {
        containerProps.title = t('session.unreadHint');
        containerProps['aria-label'] = t('session.unreadTitle');
        containerProps.role = 'img';
      }
      return h(
        'span',
        containerProps,
        h('span', {
          className: 'fi-session-dot ' + (unreadNow ? 'fi-session-dot-unread' : 'fi-session-dot-idle'),
          'aria-hidden': 'true',
        }),
      );
    }

    return SessionLeadingDot;
  }

  //#endregion

  //#region 模块装配

  /**
   * 创建 DSH 插件 factory。
   *
   * @returns (require) => module.exports。
   */
  function makeFactory() {
    return function factory(require) {
      var module = { exports: {} };
      var name = TAB_ID;
      var inject = ['slots', 'locale'];

      var React;
      try {
        React = require('react');
      } catch (error) {
        console.error(LOG_PREFIX + ' 无法加载 react（插件降级为空实现）：', error);
        module.exports = { name: name, inject: inject, apply: function () {} };
        return module.exports;
      }
      var h = React.createElement;
      /** 会话行紫点 watcher：单例，供所有行共享（组件实例不各自轮询）。 */
      var unreadWatcher = createUnreadWatcher();

      /**
       * 激活：注册 locale、样式、右侧栏标签类型与正文插槽、设置页、会话行紫点。
       *
       * 任何一步失败都只降级功能，绝不让插件抛错——否则整个 Web 端可能进不去。
       *
       * @param ctx - 浏览器侧 Cordis 上下文。
       */
      function apply(ctx) {
        try {
          applyInner(ctx);
        } catch (error) {
          console.error(LOG_PREFIX + ' 插件激活失败（已忽略，不影响页面）：', error);
        }
      }

      /**
       * 真正的注册流程。
       *
       * @param ctx - 浏览器侧 Cordis 上下文。
       */
      function applyInner(ctx) {
        // locale：所有可见文案走 t()。
        var t = function (key) {
          return key;
        };
        try {
          ctx.effect(function () {
            return ctx.locale.register(NS, DICTS);
          }, 'dsh-low-integrity-check: dictionaries');
          t = ctx.locale.bind(NS);
        } catch (error) {
          console.error(LOG_PREFIX + ' locale 注册失败（文案退化为键名）：', error);
        }

        // 样式：照抄 dsh-pet 的引用计数注入/清理。
        try {
          ctx.effect(function () {
            return injectPanelCss();
          }, 'dsh-low-integrity-check: panel styles');
        } catch (error) {
          console.error(LOG_PREFIX + ' 面板样式注入失败（不影响功能）：', error);
        }

        // 会话行紫点：轮询本插件任务状态；定时器与可见性监听都挂在 ctx.effect 上。
        try {
          ctx.effect(function () {
            return unreadWatcher.start();
          }, 'dsh-low-integrity-check: session row unread watcher');
        } catch (error) {
          console.warn(LOG_PREFIX + ' 未读状态 watcher 启动失败（已忽略）：', error);
        }

        var Panel = makePanel({ React: React, h: h, t: t });

        /**
         * 软取右侧栏导航控制器并打开本标签（服务缺失时静默）。
         *
         * @param kind - 标签类型。
         */
        function openSidebarTab(kind) {
          try {
            var controller = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
            if (controller !== undefined && controller !== null && typeof controller.openTab === 'function') {
              controller.openTab(kind);
            }
          } catch (error) {
            console.warn(LOG_PREFIX + ' 打开右侧栏标签失败（已忽略）：', error);
          }
        }

        // 右侧栏是可选能力：服务可能晚到，做 20 × 250ms 有界重试；失败只告警。
        try {
          ctx.effect(
            function () {
              var disposed = false;
              var timer = null;
              var attempts = 0;
              var disposers = [];

              function giveUp() {
                console.warn(LOG_PREFIX + ' 右侧栏不可用：20 次重试内没有 sidebarRightTabs 服务，面板标签未注册');
              }

              function registerTabType() {
                if (disposed) return;
                var tabs;
                try {
                  tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined;
                } catch (error) {
                  tabs = undefined;
                }
                if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') {
                  attempts += 1;
                  if (attempts >= SIDEBAR_RETRY_TRIES) {
                    giveUp();
                    return;
                  }
                  timer = window.setTimeout(registerTabType, SIDEBAR_RETRY_DELAY_MS);
                  return;
                }
                try {
                  var disposeType = tabs.register({
                    id: TAB_ID,
                    kind: TAB_KIND,
                    // extension 是外部插件最高优先带：不与内置类型抢地址，但可以覆盖同名 kind
                    priority: 'extension',
                    title: function () {
                      return t('tab.title');
                    },
                    guide: [
                      {
                        id: TAB_KIND,
                        order: 300,
                        title: function () {
                          return t('tab.title');
                        },
                        description: function () {
                          return t('tab.description');
                        },
                      },
                    ],
                  });
                  if (typeof disposeType === 'function') disposers.push(disposeType);
                } catch (error) {
                  console.error(LOG_PREFIX + ' 标签类型注册失败（面板不可用，其余功能不受影响）：', error);
                }
                // 正文插槽：等 sidebar.right.pane.tab 被声明后注册，避免「打开标签却空白」。
                try {
                  ctx.slots.inject('sidebar.right.pane.tab', function* () {
                    yield ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, order: 100 }, Panel);
                  });
                } catch (error) {
                  console.error(LOG_PREFIX + ' 面板正文插槽注册失败（已忽略）：', error);
                }
                // 服务是重试后才出现的：说明右侧栏比本插件晚就绪，主动打开一次让用户看见入口。
                if (attempts > 0) openSidebarTab(TAB_KIND);
              }

              registerTabType();

              return function () {
                disposed = true;
                if (timer !== null) window.clearTimeout(timer);
                for (var i = 0; i < disposers.length; i++) {
                  try {
                    disposers[i]();
                  } catch (error) {
                    /* 注销失败不影响页面 */
                  }
                }
              };
            },
            'dsh-low-integrity-check: sidebar panel tab',
          );
        } catch (error) {
          console.error(LOG_PREFIX + ' 右侧栏注册抛出异常（已忽略，不影响页面）：', error);
        }

        // 会话行 leading occupant：占用「状态圆点」单元格，显示任务结束紫点。
        try {
          var SessionLeadingDot = makeSessionLeadingDot({ React: React, h: h, t: t, watcher: unreadWatcher });
          ctx.slots.inject('sidebar.session.row.leading', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.session.row.leading',
                id: 'low-integrity-unread',
                order: 20,
              },
              SessionLeadingDot,
            );
          });
        } catch (error) {
          console.warn(LOG_PREFIX + ' 会话行未读紫点注册失败（已忽略，其余功能不受影响）：', error);
        }

        // 设置页（可选能力）：注册到「设置 → 文件完整性检查」。
        // uiWorkspace 软取：服务缺失时「选择文件夹…」按钮禁用，其余功能照常。
        try {
          var workspaceUi = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
          var pickDirectory = null;
          if (workspaceUi !== undefined && workspaceUi !== null && typeof workspaceUi.pickDirectory === 'function') {
            pickDirectory = function () {
              return workspaceUi.pickDirectory();
            };
          }
          var SettingsPage = makeSettingsPage({ React: React, h: h, t: t, pickDirectory: pickDirectory });
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'low-integrity',
                order: 50,
                label: function () {
                  return t('settings.sectionTitle');
                },
              },
              SettingsPage,
            );
          });
        } catch (error) {
          console.warn(LOG_PREFIX + ' 设置页注册失败（已忽略，其余功能不受影响）：', error);
        }
      }

      module.exports = { name: name, inject: inject, apply: apply };
      return module.exports;
    };
  }

  // 浏览器模块入口：id 是插件身份，factory 返回 { name, inject, apply }。
  try {
    window.__ModuleLoader__.load({ id: TAB_ID, factory: makeFactory() });
  } catch (error) {
    console.error(LOG_PREFIX + ' 模块加载失败：', error);
  }

  //#endregion
})();
