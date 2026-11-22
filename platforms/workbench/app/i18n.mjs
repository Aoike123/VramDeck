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
    brandTagline: '1–4 GPU Control Plane',
    sidebarControl: 'INFERENCE CONTROL',
    loading: 'Loading…',
    standby: 'Standby',
    idle: 'Idle',
    navOverview: 'Overview',
    navOverviewDesc: 'GPUs & Pool',
    navHub: 'Engine & Model Hub',
    navHubDesc: 'Scan, Pull & Adopt',
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
    topologyTitle: 'Multi-GPU VRAM Topology',
    topologySubtitle: 'Live device memory, backend capabilities & active PoolAllocation slots',
    topologyStandbyTitle: '0-GPU / CPU Standby Pool',
    topologyStandbyDesc: 'No discrete GPU detected; compatible CPU runtimes remain available.',
    topologyAllocated: 'Allocated Pool Slots',
    topologyNoAllocations: 'No resident engine allocations right now; workers launch on demand.',
    hubScanTitle: 'Local AI Service Scanner',
    hubScanButton: 'Scan Local Services',
    hubAdoptButton: 'Adopt Service',
    hubEnginesTitle: 'Engine Catalog',
    hubModelsTitle: 'Model Weights & Mirror Pull',
    hubLinkTitle: 'Link Local Weights Directory',
    hubLinkSubmit: 'Link Directory',
    hubPullButton: 'Download',
    hubEnableButton: 'Enable',
    hubMirrorLabel: 'Download Mirror',
    apiErrorBanner: 'Request failed',
  },
  'zh-CN': {
    brand: 'VramDeck',
    brandTagline: '少卡统一控制台',
    sidebarControl: '推理控制平面',
    loading: '读取中…',
    standby: '待机',
    idle: '空闲',
    navOverview: '总览',
    navOverviewDesc: '多卡设备与调度',
    navHub: '引擎与模型中心',
    navHubDesc: '扫描、下载与接管',
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
    topologyTitle: '多卡显存拓扑 (PoolStatus)',
    topologySubtitle: '实时检测设备显存、计算后端与活动 PoolAllocation 槽位',
    topologyStandbyTitle: '0 卡 / CPU 待机模式',
    topologyStandbyDesc: '当前无独立 GPU，兼容 CPU 的轻量引擎仍可按需调度。',
    topologyAllocated: '已分配显存槽位',
    topologyNoAllocations: '当前无常驻引擎占用，收到任务后按需拉起。',
    hubScanTitle: '本机 AI 服务扫描与接管',
    hubScanButton: '扫描本机服务',
    hubAdoptButton: '一键接管',
    hubEnginesTitle: '引擎目录',
    hubModelsTitle: '模型权重与镜像下载',
    hubLinkTitle: '挂载本地权重目录',
    hubLinkSubmit: '挂载目录',
    hubPullButton: '拉取下载',
    hubEnableButton: '启用',
    hubMirrorLabel: '下载镜像源',
    apiErrorBanner: '操作失败',
  },
};

export function t(locale, key) {
  const loc = normalizeLocale(locale);
  return MESSAGES[loc]?.[key] ?? MESSAGES.en[key] ?? key;
}

export function formatNumber(value, locale = DEFAULT_LOCALE, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const loc = normalizeLocale(locale);
  return new Intl.NumberFormat(loc, { maximumFractionDigits: digits }).format(Number(value));
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
