export const LOCALES = ['en', 'zh-CN'];
export const DEFAULT_LOCALE = 'en';

export function isSupportedLocaleTag(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned === 'zh' || cleaned.startsWith('zh-')) return 'zh-CN';
  if (cleaned === 'en' || cleaned.startsWith('en-')) return 'en';
  return null;
}

export function normalizeLocale(raw) {
  return isSupportedLocaleTag(raw) ?? DEFAULT_LOCALE;
}

function parseCookies(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function resolveLocale({ lang, cookieHeader, acceptLanguage } = {}) {
  const queryMatch = isSupportedLocaleTag(lang);
  if (queryMatch) return queryMatch;

  const cookies = parseCookies(cookieHeader);
  for (const key of ['vramdeck_lang', 'lang', 'locale']) {
    const cookieMatch = isSupportedLocaleTag(cookies[key]);
    if (cookieMatch) return cookieMatch;
  }

  if (typeof acceptLanguage === 'string' && acceptLanguage.trim()) {
    for (const part of acceptLanguage.split(',')) {
      const tag = part.split(';')[0]?.trim();
      const headerMatch = isSupportedLocaleTag(tag);
      if (headerMatch) return headerMatch;
    }
  }

  return DEFAULT_LOCALE;
}

export const MESSAGES = {
  en: {
    brand: 'VramDeck',
    brandTagline: 'Unified Compute Pool',
    sidebarControl: 'Control plane',
    loading: 'Loading…',
    standby: 'Standby',
    idle: 'Idle',
    navOverview: 'Overview',
    navOverviewDesc: 'Compute Pool',
    navHub: 'Engine & Model Hub',
    navHubDesc: 'Engines & Weights',
    navLibrary: 'Artifacts',
    navLibraryDesc: 'Generated Outputs',
    navTasks: 'Tasks',
    navTasksDesc: 'Jobs & Queues',
    navServices: 'Services',
    navServicesDesc: 'Monitor & Config',
    navEngines: 'Engines',
    navEnginesDesc: 'Enable & Route',
    navApi: 'API',
    navApiDesc: 'HTTP Endpoints',
    navMcp: 'MCP',
    navMcpDesc: 'Agent Tools',
    navKeys: 'Access & Keys',
    navKeysDesc: 'Quotas & Exposure',

    headingOverviewEyebrow: 'Compute pool control plane',
    headingOverviewTitle: 'Overview',
    headingOverviewSub: 'Unified Compute Pool',
    headingOverviewText:
      'Inspect unified compute pool capacity, active runtime leases, model services, and recent outputs.',
    headingHubEyebrow: 'Engine & model hub',
    headingHubTitle: 'Hub',
    headingHubSub: 'Engines, Weights & Discovery',
    headingHubText:
      'Enable local engines, size quantized weights against the live compute pool, and adopt localhost services.',

    statusConnected: 'Gateway connected',
    statusOffline: 'Connection interrupted',
    statusConnecting: 'Connecting',
    statusSwitching: 'Switching runtime',
    statusActiveEngine: 'Active runtime',
    statusStateUnconfirmed: 'Pending check',
    statusStateSampling: 'Awaiting telemetry',
    statusStatePreparing: 'Preparing engine',
    statusStateOnDemand: 'Running on demand',
    statusStateAwaiting: 'Awaiting requests',
    statusCanvas: 'ComfyUI Canvas',
    deviceDetecting: 'Detecting devices',
    deviceCpuStandby: 'CPU Standby',
    deviceVramPending: 'Pending',
    poolBadgeCpu: 'Unified Compute Pool · CPU',
    poolBadgeOne: 'Unified Compute Pool · 1 device',
    poolBadgeMulti: 'Unified Compute Pool · {n} devices',

    kpiRuntime: 'Active runtime',
    kpiRuntimeNote: 'Scheduled on demand',
    kpiLease: 'Pool lease',
    kpiLeaseLeased: 'Leased',
    kpiLeaseNote: 'Shared by API / MCP',
    kpiQueued: 'Gateway queue',
    kpiQueuedNote: 'Requests waiting for capacity',
    kpiMediaJobs: 'Active media jobs',
    kpiMediaJobsNote: 'Queued & running API / MCP tasks',
    overviewServicesTitle: 'Model services',
    overviewServicesHint: 'Open monitor, artifacts, and tasks',
    overviewArtifactsTitle: 'Recent artifacts',
    overviewOpenLibrary: 'Open library',
    overviewMediaError: 'Failed to read media job state',
    serviceStateRunning: 'Running',
    serviceStateSwitching: 'Switching',
    serviceStateOnDemand: 'On demand',
    serviceChatSync: 'Chat · Sync API',
    serviceJobsCount: '{n} persistent jobs',
    serviceNoJobs: 'No persistent jobs',
    serviceSharedRuntime: 'Shares {runtime}',

    topologyTitle: 'Compute Pool Topology',
    topologyPoolSummary: '{free} / {total} free · {count} pool devices',
    topologyStandbySummary: 'Unified CPU memory pool · {os}/{arch}',
    topologyStandbyTitle: 'CPU Compute Standby',
    topologyStandbyDesc:
      'No discrete GPU detected; CPU-compatible engines schedule directly on host memory.',
    topologyHostRam: 'Host memory',
    topologyFree: 'free',
    topologyUsed: 'used',
    topologySystem: 'System & runtime',
    topologyUtil: 'Utilization',
    topologyTemp: 'Temperature',
    topologyPower: 'Power',
    topologyAllocated: 'Active pool allocations',
    topologyNoAllocations:
      'No resident engine allocations; workers claim compute pool slots on demand.',
    topologySlotMode: 'shared',
    topologyColEngine: 'Engine',
    topologyColRuntime: 'Runtime',
    topologyColPlacement: 'Placement',
    topologyColMode: 'Mode',
    topologyColLeases: 'Leases',

    hubStatPool: 'Compute pool',
    hubStatEngines: 'Engine catalog',
    hubStatWeights: 'Model weights',
    hubStatDiscovery: 'Local discovery',
    hubStatDevicesCount: '{n} devices · {free} free',
    hubStatCpuMode: 'CPU standby pool',
    hubStatCorePro: '{core} core · {pro} ROCm Pro',
    hubStatFitCount: '{fit} / {total} fit pool',
    hubStatDownloadsActive: '{n} active downloads',
    hubStatDiscoveredCount: '{n} found on localhost',
    hubStatReadyScan: 'Scan localhost ports',

    hubTabEngines: 'Engines',
    hubTabModels: 'Model Weights',
    hubTabDiscovery: 'Local Discovery',
    hubFilterCore: 'Core ({n})',
    hubFilterRocmPro: 'ROCm Pro ({n})',
    hubFilterAll: 'All ({n})',
    hubMinVram: 'Min {vram}',

    hubScanTitle: 'Local service discovery & adoption',
    hubScanDesc:
      'Probe localhost ports for running Ollama (:11434), ComfyUI (:18188), llama-server (:18080), or LM Studio (:1234) instances.',
    hubScanButton: 'Scan Local Services',
    hubScanningButton: 'Scanning…',
    hubScanEmpty: 'No external inference servers detected on localhost.',
    hubAdoptButton: 'Adopt Service',
    hubEnableButton: 'Enable',
    hubMirrorLabel: 'Mirror',
    hubFitSummary: '{fit} / {total} fit current pool',
    hubColModel: 'Model',
    hubColQuant: 'Quant',
    hubColSize: 'Disk size',
    hubColVram: 'Est. VRAM',
    hubColFit: 'Pool fit',
    hubColAction: 'Action',
    hubFitFits: 'Fits',
    hubFitTight: 'Tight',
    hubFitTooLarge: 'Exceeds VRAM',
    hubPullButton: 'Download',
    hubDownloadsTitle: 'Download Queue',
    hubLinkTitle: 'Link local weights directory',
    hubLinkDesc: 'Register an existing GGUF or SafeTensors directory without copying files.',
    hubLinkIdLabel: 'Model ID',
    hubLinkIdPlaceholder: 'local-qwen',
    hubLinkEngineLabel: 'Engine',
    hubLinkEnginePlaceholder: 'llama-cpp',
    hubLinkDirLabel: 'Local directory',
    hubLinkDirPlaceholder: '/path/to/weights',
    hubLinkSubmit: 'Link Directory',
    hubMsgAdopted: 'Adopted {name} into compute pool',
    hubMsgEnabled: 'Engine {id} enabled',
    hubMsgQueued: 'Queued download for {target} via {mirror}',
    hubMsgLinked: 'Linked local weights {id}',
    apiErrorBanner: 'Request failed',
  },
  'zh-CN': {
    brand: 'VramDeck',
    brandTagline: '单一算力群控制面',
    sidebarControl: '控制平面',
    loading: '读取中…',
    standby: '待机',
    idle: '空闲',
    navOverview: '总览',
    navOverviewDesc: '单一算力群',
    navHub: '引擎与模型中心',
    navHubDesc: '引擎、权重与接管',
    navLibrary: '作品库',
    navLibraryDesc: '全部生成结果',
    navTasks: '任务中心',
    navTasksDesc: '执行与队列',
    navServices: '模型服务',
    navServicesDesc: '监控与配置',
    navEngines: '引擎',
    navEnginesDesc: '接入与路由',
    navApi: 'API',
    navApiDesc: '程序接入',
    navMcp: 'MCP',
    navMcpDesc: '模型工具接入',
    navKeys: '访问与公网',
    navKeysDesc: '密钥、放行与额度',

    headingOverviewEyebrow: '单一算力群控制平面',
    headingOverviewTitle: '总览',
    headingOverviewSub: '统一本地算力池',
    headingOverviewText: '实时查看单一算力群显存余量、在途租约、模型服务状态与近期生成结果。',
    headingHubEyebrow: '引擎与模型中心',
    headingHubTitle: 'Hub',
    headingHubSub: '引擎目录、权重与本地接管',
    headingHubText: '按需启用运行时、基于当前算力池匹配量化权重尺寸，并扫描接管本机已有服务。',

    statusConnected: '网关监控已连接',
    statusOffline: '连接暂时中断',
    statusConnecting: '正在连接',
    statusSwitching: '正在切换',
    statusActiveEngine: '当前运行后端',
    statusStateUnconfirmed: '状态待确认',
    statusStateSampling: '等待采集',
    statusStatePreparing: '正在准备引擎',
    statusStateOnDemand: '按需运行',
    statusStateAwaiting: '等待任务',
    statusCanvas: 'ComfyUI 画布',
    deviceDetecting: '设备读取中',
    deviceCpuStandby: 'CPU 待机',
    deviceVramPending: '容量待采集',
    poolBadgeCpu: '单一算力群 · CPU 待机',
    poolBadgeOne: '单一算力群 · 1 个计算设备',
    poolBadgeMulti: '单一算力群 · {n} 个计算设备',

    kpiRuntime: '当前后端',
    kpiRuntimeNote: '按需启动',
    kpiLease: '算力群租约',
    kpiLeaseLeased: '占用中',
    kpiLeaseNote: 'API / MCP 共用',
    kpiQueued: '网关等待',
    kpiQueuedNote: '等待算力群空位的请求',
    kpiMediaJobs: '进行中的媒体任务',
    kpiMediaJobsNote: 'API / MCP 提交的未完成任务',
    overviewServicesTitle: '模型服务',
    overviewServicesHint: '点击查看监控、作品与任务',
    overviewArtifactsTitle: '最近作品',
    overviewOpenLibrary: '打开作品库',
    overviewMediaError: '媒体任务状态读取失败',
    serviceStateRunning: '运行中',
    serviceStateSwitching: '正在切换',
    serviceStateOnDemand: '按需启动',
    serviceChatSync: '对话 · 同步接口',
    serviceJobsCount: '{n} 个持久任务',
    serviceNoJobs: '暂无持久任务',
    serviceSharedRuntime: '共用 {runtime}',

    topologyTitle: '算力群拓扑',
    topologyPoolSummary: '剩余 {free} / 共 {total} · {count} 个算力成员',
    topologyStandbySummary: '统一主机内存池 · {os}/{arch}',
    topologyStandbyTitle: 'CPU 算力待机模式',
    topologyStandbyDesc: '当前未检测到独立 GPU，兼容 CPU 的轻量引擎仍可直接调度运行。',
    topologyHostRam: '主机内存',
    topologyFree: '可用',
    topologyUsed: '已用',
    topologySystem: '系统与运行时基线',
    topologyUtil: '计算利用率',
    topologyTemp: '核心温度',
    topologyPower: '实时功耗',
    topologyAllocated: '算力群槽位分配',
    topologyNoAllocations: '当前无常驻引擎占用，收到任务后按需分配算力槽位。',
    topologySlotMode: '共享',
    topologyColEngine: '引擎',
    topologyColRuntime: '运行时',
    topologyColPlacement: '槽位占用',
    topologyColMode: '模式',
    topologyColLeases: '活跃租约',

    hubStatPool: '算力群总容量',
    hubStatEngines: '引擎目录',
    hubStatWeights: '量化权重',
    hubStatDiscovery: '本地接管与下载',
    hubStatDevicesCount: '{n} 个设备 · 可用 {free}',
    hubStatCpuMode: 'CPU 待机模式',
    hubStatCorePro: '{core} 核心 · {pro} ROCm Pro',
    hubStatFitCount: '{fit} / {total} 项适配当前池',
    hubStatDownloadsActive: '{n} 个下载进行中',
    hubStatDiscoveredCount: '已发现 {n} 个本机服务',
    hubStatReadyScan: '待扫描本地端口',

    hubTabEngines: '引擎目录',
    hubTabModels: '模型权重与镜像',
    hubTabDiscovery: '本地发现与接管',
    hubFilterCore: '核心跨平台 ({n})',
    hubFilterRocmPro: 'ROCm Pro ({n})',
    hubFilterAll: '全部 ({n})',
    hubMinVram: '建议 ≥ {vram}',

    hubScanTitle: '本机 AI 服务扫描与接管',
    hubScanDesc:
      '自动探测本机运行中的 Ollama (:11434)、ComfyUI (:18188)、llama-server (:18080) 与 LM Studio (:1234)。',
    hubScanButton: '扫描本机服务',
    hubScanningButton: '扫描中…',
    hubScanEmpty: '本机常用端口上未发现运行中的推理服务。',
    hubAdoptButton: '一键接管',
    hubEnableButton: '启用',
    hubMirrorLabel: '镜像源',
    hubFitSummary: '当前算力池适配 {fit} / {total} 项',
    hubColModel: '模型',
    hubColQuant: '量化',
    hubColSize: '文件体积',
    hubColVram: '建议显存',
    hubColFit: '适配状态',
    hubColAction: '操作',
    hubFitFits: '显存适配',
    hubFitTight: '余量较紧',
    hubFitTooLarge: '显存不足',
    hubPullButton: '拉取下载',
    hubDownloadsTitle: '下载任务队列',
    hubLinkTitle: '挂载本地权重目录',
    hubLinkDesc: '直接登记已有 GGUF 或 SafeTensors 目录，无需重复复制权重文件。',
    hubLinkIdLabel: '模型标识',
    hubLinkIdPlaceholder: 'local-qwen',
    hubLinkEngineLabel: '目标引擎',
    hubLinkEnginePlaceholder: 'llama-cpp',
    hubLinkDirLabel: '本地绝对路径',
    hubLinkDirPlaceholder: '/path/to/weights',
    hubLinkSubmit: '挂载目录',
    hubMsgAdopted: '已将 {name} 接管至单一算力群',
    hubMsgEnabled: '引擎 {id} 已就绪',
    hubMsgQueued: '已提交 {target} 的权重下载任务（{mirror}）',
    hubMsgLinked: '已挂载本地权重 {id}',
    apiErrorBanner: '请求失败',
  },
};

export function t(locale, key, vars = null) {
  const loc = normalizeLocale(locale);
  let text = MESSAGES[loc]?.[key] ?? MESSAGES.en[key] ?? key;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v ?? ''));
    }
  }
  return text;
}

export function formatNumber(value, locale = DEFAULT_LOCALE, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const loc = normalizeLocale(locale);
  return new Intl.NumberFormat(loc, { maximumFractionDigits: digits }).format(Number(value));
}

export function formatMbToGib(mb, locale = DEFAULT_LOCALE, digits = 1) {
  if (mb == null || !Number.isFinite(Number(mb))) return '—';
  return `${formatNumber(Number(mb) / 1024, locale, digits)} GiB`;
}

export function formatBytesToGib(bytes, locale = DEFAULT_LOCALE, digits = 1) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '—';
  return `${formatNumber(Number(bytes) / 1024 ** 3, locale, digits)} GiB`;
}

export function formatPoolBadge(gpus, locale = DEFAULT_LOCALE) {
  const count = Array.isArray(gpus) ? gpus.length : 0;
  if (count > 1) return t(locale, 'poolBadgeMulti', { n: count });
  if (count === 1) return t(locale, 'poolBadgeOne');
  return t(locale, 'poolBadgeCpu');
}

export function formatSidebarDevice(device, data, locale = DEFAULT_LOCALE) {
  const loc = normalizeLocale(locale);
  if (loc === 'zh-CN') {
    return {
      label: device?.label ?? t(loc, 'deviceDetecting'),
      vramLabel: device?.vramLabel ?? t(loc, 'deviceVramPending'),
    };
  }
  const gpus = Array.isArray(device?.gpus) ? device.gpus : [];
  let label = device?.label;
  if (!data) label = t(loc, 'deviceDetecting');
  else if (gpus.length === 0 && !data?.device?.name && !data?.values?.vram_total) {
    label = t(loc, 'deviceCpuStandby');
  }
  const vramLabel =
    device?.totalVramBytes > 0
      ? `${formatNumber(device.totalVramBytes / 2 ** 30, loc, 0)} GiB`
      : t(loc, 'deviceVramPending');
  return { label, vramLabel };
}

export function formatTime(epochSeconds, locale = DEFAULT_LOCALE) {
  if (!Number.isFinite(epochSeconds)) return '—';
  const loc = normalizeLocale(locale);
  return new Intl.DateTimeFormat(loc, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

export function formatDateTime(value, locale = DEFAULT_LOCALE) {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const loc = normalizeLocale(locale);
  return new Intl.DateTimeFormat(loc, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
