// Console services come from the gateway's engine registry (/data → services); the page calls
// setServices with each snapshot, and every importer sees the live binding.
export let SERVICES = [];
export function setServices(list) {
  if (Array.isArray(list)) SERVICES = list;
  return SERVICES;
}
export const serviceOf = (id) => SERVICES.find((s) => s.id === id) ?? null;
// Section labels by engine category, for headings and empty states.
export const TYPE_LABEL = {
  language: { eyebrow: 'LANGUAGE', noun: '对话' },
  image: { eyebrow: 'IMAGE', noun: '图像' },
  video: { eyebrow: 'VIDEO', noun: '视频' },
  audio: { eyebrow: 'AUDIO', noun: '音频' },
};
// Jobs outlive engines: a removed engine's work stays listed under its id.
export const engineLabel = (id) =>
  id == null ? '—' : (SERVICES.find((s) => s.id === id)?.name ?? id + '（已移除）');
export const serviceName = (id) => SERVICES.find((s) => s.id === id)?.name ?? '待机';
export const cleanLogOutput = (text) =>
  (text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
export const fmt = (v, d = 1) =>
  v == null || !Number.isFinite(v)
    ? '—'
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(v);
export const clock = (t) =>
  Number.isFinite(t)
    ? new Intl.DateTimeFormat(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(t * 1000))
    : '—';
export function serviceState(data, model) {
  if (!data) return 'loading';
  // A scheduler lease cycle that targets the engine already loaded is not a switch: the page would flash "preparing" between two requests.
  if (
    (data.switching_target === model && data.current_model !== model) ||
    (model === 'llm' && data.pending_llm_mode)
  )
    return 'switching';
  if (data.current_model === model && (!data.switching || data.switching_target === model))
    return data.active > 0 ? 'busy' : 'ready';
  return 'inactive';
}
export function serviceRecords(data, model, minutes) {
  return (data?.recent ?? []).filter(
    (r) =>
      r.model === model &&
      (minutes === undefined || r.finished_at >= data.timestamp - minutes * 60),
  );
}
// Container tails overlap and can roll over. Compare the longest suffix/prefix,
// including repeated identical lines, rather than counting all lines on each poll.
export function newLogLines(previous, next) {
  const before = previous.split('\n').filter(Boolean),
    after = next.split('\n').filter(Boolean);
  if (previous === next) return [];
  if (!before.length) return after;
  for (let n = Math.min(before.length, after.length); n > 0; n--) {
    if (before.slice(-n).every((line, i) => line === after[i])) return after.slice(n);
  }
  return after;
}
export function logSummary(lines) {
  const errors = lines.filter((line) =>
    /\b(error|fatal|traceback|exception)\b|错误|异常/i.test(line),
  );
  const warnings = lines.filter((line) => /\bwarn(?:ing)?\b|警告/i.test(line));
  return {
    text: errors.at(-1) ?? warnings.at(-1) ?? lines.at(-1) ?? '',
    level: errors.length ? 'error' : warnings.length ? 'warning' : 'info',
    errors: errors.length,
  };
}

// Startup output differs by engine: media engines stream their normal container log.
export function engineLogText(logs, startup = false) {
  if (!logs) return '正在读取该服务引擎输出…';
  const events = logs.engine_switch?.events ?? logs.events ?? [];
  const progress = events.map((e) => `[${e.source ?? 'scheduler'}] ${e.message}`).join('\n');
  const output = startup
    ? logs.model === 'llm'
      ? logs.startup_output
      : (logs.startup_output ?? logs.output)
    : logs.output;
  return cleanLogOutput(
    [progress, output ?? (startup ? '等待目标引擎创建，启动输出将自动显示…' : '等待引擎输出…')]
      .filter(Boolean)
      .join('\n\n'),
  );
}

export function followedEngine(data) {
  return data?.pending_llm_mode ? 'llm' : (data?.switching_target ?? data?.current_model ?? null);
}

export function deviceSummary(data) {
  const gpus = Array.isArray(data?.gpus)
    ? data.gpus
    : Array.isArray(data?.hardware?.gpus)
      ? data.hardware.gpus
      : [];
  const gpuVramBytes = gpus.length
    ? gpus.reduce((sum, gpu) => sum + (Number(gpu?.vram_total_mb) || 0) * 1024 * 1024, 0)
    : null;
  const totalVramBytes = data?.values?.vram_total > 0 ? data.values.vram_total : gpuVramBytes;
  let label;
  if (gpus.length === 1) {
    label = gpus[0]?.name || 'GPU 设备';
  } else if (gpus.length > 1) {
    const names = [...new Set(gpus.map((g) => g?.name).filter(Boolean))];
    label =
      names.length === 1
        ? `${gpus.length}× ${names[0]}`
        : `${gpus.length} GPUs` + (names.length ? ` (${names.join(' / ')})` : '');
  } else if (data?.device?.name) {
    label = data.device.name;
  } else if (data) {
    label = data.values?.vram_total ? 'GPU 设备' : 'CPU / 设备待接入';
  } else {
    label = '设备读取中';
  }
  const vramLabel = totalVramBytes
    ? fmt(totalVramBytes / 2 ** 30, 0) + ' GiB'
    : data
      ? '容量待采集'
      : '容量读取中';
  const poolLabel = gpus.length > 1 ? `${gpus.length} 卡资源池调度` : '按需推理调度';
  return { gpus, label, vramLabel, totalVramBytes, poolLabel };
}
