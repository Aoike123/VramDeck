import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DownloadProgress,
  EngineManifestV2,
  GpuDevice,
  HardwareSnapshot,
  HubEngineEntry,
  HubModelEntry,
  PoolAllocation,
  PoolStatus,
  ResourceSpec,
  TelemetrySample,
  TelemetrySeries,
} from '../../../platforms/workbench/lib/types.ts';

const GPU_VENDORS = new Set(['nvidia', 'amd', 'apple', 'intel', 'cpu']);
const COMPUTE_BACKENDS = new Set(['cuda', 'rocm', 'metal', 'vulkan', 'cpu']);
const VRAM_MODES = new Set(['shared', 'exclusive']);
const COLD_START_WEIGHTS = new Set(['low', 'medium', 'high']);
const DRIVER_KINDS = new Set(['process', 'docker', 'external']);
const ENGINE_CATEGORIES = new Set(['llm', 'image', 'video', 'audio']);
const HUB_MIRRORS = new Set(['huggingface', 'hf-mirror', 'modelscope', 'local']);
const DOWNLOAD_STATUSES = new Set([
  'queued',
  'downloading',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  assertFiniteNumber(value, label);
  assert.ok(value >= 0, `${label} must be >= 0`);
}

function assertNullableFiniteNumber(value: unknown, label: string): asserts value is number | null {
  if (value !== null) {
    assertFiniteNumber(value, label);
  }
}

export function assertGpuDevice(value: unknown): asserts value is GpuDevice {
  assert.ok(isRecord(value), 'GpuDevice must be an object');
  assert.ok(typeof value.id === 'string' && value.id.length > 0, 'GpuDevice.id must be non-empty');
  assert.ok(
    Number.isInteger(value.index) && (value.index as number) >= 0,
    'GpuDevice.index must be a non-negative integer',
  );
  assert.ok(
    typeof value.vendor === 'string' && GPU_VENDORS.has(value.vendor),
    `GpuDevice.vendor invalid: ${String(value.vendor)}`,
  );
  assert.ok(
    typeof value.backend === 'string' && COMPUTE_BACKENDS.has(value.backend),
    `GpuDevice.backend invalid: ${String(value.backend)}`,
  );
  assert.equal(typeof value.name, 'string', 'GpuDevice.name must be a string');
  assert.equal(typeof value.unified_memory, 'boolean', 'GpuDevice.unified_memory must be boolean');
  assertFiniteNumber(value.vram_total_mb, 'GpuDevice.vram_total_mb');
  assertFiniteNumber(value.vram_used_mb, 'GpuDevice.vram_used_mb');
  assertFiniteNumber(value.vram_free_mb, 'GpuDevice.vram_free_mb');
  assert.ok(value.vram_total_mb >= 0, 'GpuDevice.vram_total_mb must be >= 0');
  assert.ok(value.vram_used_mb >= 0, 'GpuDevice.vram_used_mb must be >= 0');
  assert.ok(value.vram_free_mb >= 0, 'GpuDevice.vram_free_mb must be >= 0');
  assertNullableFiniteNumber(value.utilization_pct, 'GpuDevice.utilization_pct');
  assertNullableFiniteNumber(value.temperature_c, 'GpuDevice.temperature_c');
  assertNullableFiniteNumber(value.power_w, 'GpuDevice.power_w');
}

export function assertHardwareSnapshot(value: unknown): asserts value is HardwareSnapshot {
  assert.ok(isRecord(value), 'HardwareSnapshot must be an object');
  assertFiniteNumber(value.collected_at, 'HardwareSnapshot.collected_at');
  assert.ok(isRecord(value.host), 'HardwareSnapshot.host must be an object');
  assert.equal(typeof value.host.os, 'string', 'HostResources.os must be a string');
  assert.equal(typeof value.host.arch, 'string', 'HostResources.arch must be a string');
  assertFiniteNumber(value.host.ram_total_mb, 'HostResources.ram_total_mb');
  assertFiniteNumber(value.host.ram_free_mb, 'HostResources.ram_free_mb');
  assert.ok(value.host.ram_total_mb > 0, 'HostResources.ram_total_mb must be > 0');
  assert.ok(value.host.ram_free_mb >= 0, 'HostResources.ram_free_mb must be >= 0');
  assert.ok(Array.isArray(value.gpus), 'HardwareSnapshot.gpus must be an array');
  for (const gpu of value.gpus) {
    assertGpuDevice(gpu);
  }
}

export function assertPoolAllocation(value: unknown): asserts value is PoolAllocation {
  assert.ok(isRecord(value), 'PoolAllocation must be an object');
  assert.equal(typeof value.allocation_id, 'string', 'PoolAllocation.allocation_id must be string');
  assert.equal(typeof value.runtime_id, 'string', 'PoolAllocation.runtime_id must be string');
  assert.equal(typeof value.engine, 'string', 'PoolAllocation.engine must be string');
  assert.ok(Array.isArray(value.slots), 'PoolAllocation.slots must be an array');
  for (const slot of value.slots) {
    assert.ok(isRecord(slot), 'PoolSlot must be an object');
    assert.equal(typeof slot.gpu_id, 'string', 'PoolSlot.gpu_id must be string');
    assertFiniteNumber(slot.reserved_mb, 'PoolSlot.reserved_mb');
    assert.ok(slot.reserved_mb >= 0, 'PoolSlot.reserved_mb must be >= 0');
    assert.ok(
      typeof slot.mode === 'string' && VRAM_MODES.has(slot.mode),
      `PoolSlot.mode invalid: ${String(slot.mode)}`,
    );
  }
  assertFiniteNumber(value.active_leases, 'PoolAllocation.active_leases');
  assert.ok(value.active_leases >= 0, 'PoolAllocation.active_leases must be >= 0');
  assertFiniteNumber(value.capacity, 'PoolAllocation.capacity');
  assert.ok(value.capacity >= 0, 'PoolAllocation.capacity must be >= 0');
  assertFiniteNumber(value.allocated_at, 'PoolAllocation.allocated_at');
  assert.ok(value.allocated_at >= 0, 'PoolAllocation.allocated_at must be >= 0');
}

export function assertPoolStatus(value: unknown): asserts value is PoolStatus {
  assert.ok(isRecord(value), 'PoolStatus must be an object');
  assert.ok(Array.isArray(value.gpus), 'PoolStatus.gpus must be an array');
  for (const gpu of value.gpus) assertGpuDevice(gpu);
  assert.ok(Array.isArray(value.allocations), 'PoolStatus.allocations must be an array');
  for (const alloc of value.allocations) assertPoolAllocation(alloc);
  assertFiniteNumber(value.queued, 'PoolStatus.queued');
  assert.ok(value.queued >= 0, 'PoolStatus.queued must be >= 0');
  assert.ok(Array.isArray(value.switching_targets), 'PoolStatus.switching_targets must be array');
  for (const target of value.switching_targets) {
    assert.equal(typeof target, 'string', 'PoolStatus.switching_targets item must be string');
  }
}

export function assertResourceSpec(value: unknown): asserts value is ResourceSpec {
  assert.ok(isRecord(value), 'ResourceSpec must be an object');
  assert.ok(
    Array.isArray(value.backends) && value.backends.length > 0,
    'ResourceSpec.backends must be a non-empty array',
  );
  for (const backend of value.backends) {
    assert.ok(
      typeof backend === 'string' && COMPUTE_BACKENDS.has(backend),
      `ResourceSpec.backends invalid: ${String(backend)}`,
    );
  }
  assertFiniteNumber(value.gpu_count, 'ResourceSpec.gpu_count');
  assert.ok(
    Number.isInteger(value.gpu_count) && value.gpu_count >= 1,
    'ResourceSpec.gpu_count must be an integer >= 1',
  );
  assertFiniteNumber(value.vram_mb, 'ResourceSpec.vram_mb');
  assert.ok(value.vram_mb >= 0, 'ResourceSpec.vram_mb must be >= 0');
  assert.ok(
    typeof value.vram_mode === 'string' && VRAM_MODES.has(value.vram_mode),
    `ResourceSpec.vram_mode invalid: ${String(value.vram_mode)}`,
  );
  assertFiniteNumber(value.concurrency, 'ResourceSpec.concurrency');
  assert.ok(
    Number.isInteger(value.concurrency) && value.concurrency >= 1,
    'ResourceSpec.concurrency must be an integer >= 1',
  );
  if (value.affinity !== undefined) {
    assert.ok(
      typeof value.affinity === 'string' &&
        (value.affinity === 'any' ||
          (value.affinity.startsWith('prefer:') && value.affinity.length > 'prefer:'.length) ||
          (value.affinity.startsWith('pin:') && value.affinity.length > 'pin:'.length)),
      `ResourceSpec.affinity invalid: ${String(value.affinity)}`,
    );
  }
  if (value.cold_start_weight !== undefined) {
    assert.ok(
      typeof value.cold_start_weight === 'string' &&
        COLD_START_WEIGHTS.has(value.cold_start_weight),
      `ResourceSpec.cold_start_weight invalid: ${String(value.cold_start_weight)}`,
    );
  }
}

export function assertEngineManifestV2(value: unknown): asserts value is EngineManifestV2 {
  assert.ok(isRecord(value), 'EngineManifestV2 must be an object');
  assert.equal(typeof value.name, 'string', 'EngineManifestV2.name must be string');
  assert.ok(
    typeof value.category === 'string' && ENGINE_CATEGORIES.has(value.category),
    `EngineManifestV2.category invalid: ${String(value.category)}`,
  );
  assert.ok(isRecord(value.platform), 'EngineManifestV2.platform must be an object');
  const p = value.platform;
  assert.equal(typeof p.engine, 'string', 'platform.engine must be string');
  assert.equal(typeof p.adapter, 'string', 'platform.adapter must be string');
  assert.ok(isRecord(p.runtime), 'platform.runtime must be an object');
  assert.equal(typeof p.runtime.id, 'string', 'platform.runtime.id must be string');
  assert.equal(typeof p.runtime.name, 'string', 'platform.runtime.name must be string');
  assert.ok(
    typeof p.runtime.driver === 'string' && DRIVER_KINDS.has(p.runtime.driver),
    `platform.runtime.driver invalid: ${String(p.runtime.driver)}`,
  );
  assertFiniteNumber(p.runtime.port, 'platform.runtime.port');
  if (p.resources !== undefined) {
    assertResourceSpec(p.resources);
  }
  assert.ok(isRecord(p.ui), 'platform.ui must be an object');
  assert.equal(typeof p.ui.name, 'string', 'platform.ui.name must be string');
  assert.equal(typeof p.ui.description, 'string', 'platform.ui.description must be string');
  assert.equal(typeof p.ui.symbol, 'string', 'platform.ui.symbol must be string');
  assert.equal(typeof p.ui.accent, 'string', 'platform.ui.accent must be string');
  assert.ok(
    p.ui.panel === 'llm' || p.ui.panel === 'media',
    `platform.ui.panel invalid: ${String(p.ui.panel)}`,
  );
  assert.ok(Array.isArray(p.models), 'platform.models must be an array');
  for (const model of p.models) {
    assert.ok(isRecord(model), 'platform.models item must be an object');
    assert.ok(
      typeof model.id === 'string' && model.id.length > 0,
      'platform.models[].id must be non-empty string',
    );
    assert.ok(Array.isArray(model.capabilities), 'platform.models[].capabilities must be an array');
    for (const cap of model.capabilities) {
      assert.ok(
        typeof cap === 'string' && cap.length > 0,
        'platform.models[].capabilities item must be non-empty string',
      );
    }
    if (model.priority !== undefined) {
      assertFiniteNumber(model.priority, 'platform.models[].priority');
    }
    if (model.info !== undefined) {
      assert.ok(isRecord(model.info), 'platform.models[].info must be an object');
    }
  }
}

export function assertTelemetrySample(value: unknown): asserts value is TelemetrySample {
  assert.ok(isRecord(value), 'TelemetrySample must be an object');
  assertFiniteNumber(value.timestamp, 'TelemetrySample.timestamp');
  assert.ok(isRecord(value.values), 'TelemetrySample.values must be an object');
  for (const [k, v] of Object.entries(value.values)) {
    assertNullableFiniteNumber(v, `TelemetrySample.values.${k}`);
  }
}

export function assertTelemetrySeries(value: unknown): asserts value is TelemetrySeries {
  assert.ok(isRecord(value), 'TelemetrySeries must be an object');
  assert.equal(typeof value.metric, 'string', 'TelemetrySeries.metric must be string');
  assert.ok(Array.isArray(value.points), 'TelemetrySeries.points must be an array');
  for (const pt of value.points) {
    assert.ok(Array.isArray(pt) && pt.length === 2, 'TelemetrySeries point must be [ts, val]');
    assertFiniteNumber(pt[0], 'TelemetrySeries point timestamp');
    assertNullableFiniteNumber(pt[1], 'TelemetrySeries point value');
  }
}

export function assertHubEngineEntry(value: unknown): asserts value is HubEngineEntry {
  assert.ok(isRecord(value), 'HubEngineEntry must be an object');
  assert.equal(typeof value.id, 'string', 'HubEngineEntry.id must be string');
  assert.equal(typeof value.name, 'string', 'HubEngineEntry.name must be string');
  assert.ok(
    typeof value.category === 'string' && ENGINE_CATEGORIES.has(value.category),
    `HubEngineEntry.category invalid: ${String(value.category)}`,
  );
  assert.ok(
    typeof value.driver === 'string' && DRIVER_KINDS.has(value.driver),
    `HubEngineEntry.driver invalid: ${String(value.driver)}`,
  );
  assert.ok(Array.isArray(value.backends), 'HubEngineEntry.backends must be array');
  for (const backend of value.backends) {
    assert.ok(
      typeof backend === 'string' && COMPUTE_BACKENDS.has(backend),
      `HubEngineEntry.backends invalid: ${String(backend)}`,
    );
  }
  assertNonNegativeNumber(value.min_vram_mb, 'HubEngineEntry.min_vram_mb');
  assert.equal(typeof value.description, 'string', 'HubEngineEntry.description must be string');
}

export function assertHubModelEntry(value: unknown): asserts value is HubModelEntry {
  assert.ok(isRecord(value), 'HubModelEntry must be an object');
  assert.equal(typeof value.id, 'string', 'HubModelEntry.id must be string');
  assert.equal(typeof value.name, 'string', 'HubModelEntry.name must be string');
  assert.equal(typeof value.engine_id, 'string', 'HubModelEntry.engine_id must be string');
  assertFiniteNumber(value.size_bytes, 'HubModelEntry.size_bytes');
  assert.ok(value.size_bytes >= 0, 'HubModelEntry.size_bytes must be >= 0');
  assertFiniteNumber(value.recommended_vram_mb, 'HubModelEntry.recommended_vram_mb');
  assert.ok(value.recommended_vram_mb >= 0, 'HubModelEntry.recommended_vram_mb must be >= 0');
  assert.ok(Array.isArray(value.sources), 'HubModelEntry.sources must be array');
  for (const source of value.sources) {
    assert.ok(isRecord(source), 'HubModelEntry.sources item must be an object');
    assert.ok(
      typeof source.mirror === 'string' && HUB_MIRRORS.has(source.mirror),
      `HubModelEntry.sources[].mirror invalid: ${String(source.mirror)}`,
    );
    assert.ok(
      typeof source.repo === 'string' && source.repo.length > 0,
      'HubModelEntry.sources[].repo must be non-empty string',
    );
    if (source.files !== undefined) {
      assert.ok(Array.isArray(source.files), 'HubModelEntry.sources[].files must be an array');
      for (const file of source.files) {
        assert.equal(typeof file, 'string', 'HubModelEntry.sources[].files item must be string');
      }
    }
  }
}

export function assertDownloadProgress(value: unknown): asserts value is DownloadProgress {
  assert.ok(isRecord(value), 'DownloadProgress must be an object');
  assert.equal(typeof value.task_id, 'string', 'DownloadProgress.task_id must be string');
  assert.equal(typeof value.target, 'string', 'DownloadProgress.target must be string');
  assert.ok(
    typeof value.status === 'string' && DOWNLOAD_STATUSES.has(value.status),
    `DownloadProgress.status invalid: ${String(value.status)}`,
  );
  assertFiniteNumber(value.downloaded_bytes, 'DownloadProgress.downloaded_bytes');
  assert.ok(value.downloaded_bytes >= 0, 'DownloadProgress.downloaded_bytes must be >= 0');
  assertNullableFiniteNumber(value.total_bytes, 'DownloadProgress.total_bytes');
  if (value.total_bytes !== null) {
    assert.ok(value.total_bytes >= 0, 'DownloadProgress.total_bytes must be >= 0');
  }
  assertFiniteNumber(value.speed_bps, 'DownloadProgress.speed_bps');
  assert.ok(value.speed_bps >= 0, 'DownloadProgress.speed_bps must be >= 0');
}

export function assertApiErrorShape(value: unknown, expectedCode?: string): void {
  assert.ok(isRecord(value), 'API error envelope must be an object');
  assert.ok(isRecord(value.error), 'API error envelope must contain an error object');
  assert.equal(typeof value.error.code, 'string', 'error.code must be a string');
  assert.equal(typeof value.error.type, 'string', 'error.type must be a string');
  assert.equal(typeof value.error.message, 'string', 'error.message must be a string');
  if (expectedCode !== undefined) {
    assert.equal(value.error.code, expectedCode, `Expected error.code ${expectedCode}`);
  }
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.jsx', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.next')) continue;
      files.push(...(await collectSourceFiles(path.join(dir, entry.name))));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files.sort();
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'default',
  'delete',
  'void',
  'typeof',
  'await',
  'yield',
  'in',
  'instanceof',
  'of',
  'new',
  'else',
  'do',
  'export',
]);

interface ScannedSource {
  codeWithEmptyQuotes: string;
  codeWithPlaceholders: string;
  strings: string[];
}

function scanSource(source: string): ScannedSource {
  let emptyQuotesOut = '';
  let placeholderOut = '';
  const strings: string[] = [];

  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'bt' | 'regex' = 'code';
  let canStartRegex = true;
  let lastNonWsChar = '';
  let nextOpenParenIsCond = false;
  const parenCondStack: boolean[] = [];
  let regexInCharClass = false;
  let literalStartQuote = "'";
  let literalBody = '';
  let literalNewlines = 0;
  const templateBraceStack: number[] = [];

  const emitBoth = (text: string): void => {
    emptyQuotesOut += text;
    placeholderOut += text;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        emitBoth('  ');
        i += 2;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        emitBoth('  ');
        i += 2;
      } else if (ch === "'" || ch === '"') {
        state = ch === "'" ? 'sq' : 'dq';
        literalStartQuote = ch;
        literalBody = '';
        literalNewlines = 0;
        nextOpenParenIsCond = false;
        i += 1;
      } else if (ch === '`') {
        state = 'bt';
        nextOpenParenIsCond = false;
        emitBoth('`');
        i += 1;
      } else if (ch === '/' && canStartRegex) {
        state = 'regex';
        regexInCharClass = false;
        nextOpenParenIsCond = false;
        emitBoth(' ');
        i += 1;
      } else if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) {
          end += 1;
        }
        const word = source.slice(i, end);
        emitBoth(word);
        const notMember = lastNonWsChar !== '.';
        canStartRegex = notMember && REGEX_PREFIX_KEYWORDS.has(word);
        if (notMember && (word === 'if' || word === 'while' || word === 'for' || word === 'with')) {
          nextOpenParenIsCond = true;
        } else if (notMember && word === 'await' && nextOpenParenIsCond) {
          nextOpenParenIsCond = true;
        } else {
          nextOpenParenIsCond = false;
        }
        lastNonWsChar = word[word.length - 1];
        i = end;
      } else if (/\d/.test(ch)) {
        let end = i + 1;
        while (end < source.length && /[\dA-Za-z_.]/.test(source[end])) {
          end += 1;
        }
        const num = source.slice(i, end);
        emitBoth(num);
        canStartRegex = false;
        nextOpenParenIsCond = false;
        lastNonWsChar = num[num.length - 1];
        i = end;
      } else if (/\s/.test(ch)) {
        emitBoth(ch);
        i += 1;
      } else {
        if (ch === '{' && templateBraceStack.length > 0) {
          templateBraceStack[templateBraceStack.length - 1] += 1;
        } else if (ch === '}' && templateBraceStack.length > 0) {
          const top = templateBraceStack[templateBraceStack.length - 1];
          if (top === 0) {
            templateBraceStack.pop();
            emitBoth('}');
            state = 'bt';
            nextOpenParenIsCond = false;
            i += 1;
            continue;
          }
          templateBraceStack[templateBraceStack.length - 1] = top - 1;
        }

        if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
          emitBoth(ch + next);
          canStartRegex = false;
          nextOpenParenIsCond = false;
          lastNonWsChar = ch;
          i += 2;
        } else {
          emitBoth(ch);
          if (ch === '(') {
            parenCondStack.push(nextOpenParenIsCond);
            canStartRegex = true;
          } else if (ch === ')') {
            canStartRegex = parenCondStack.pop() ?? false;
          } else {
            canStartRegex = ch !== ']';
          }
          nextOpenParenIsCond = false;
          lastNonWsChar = ch;
          i += 1;
        }
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        emitBoth('\n');
      } else {
        emitBoth(' ');
      }
      i += 1;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        emitBoth('  ');
        i += 2;
      } else {
        emitBoth(ch === '\n' ? '\n' : ' ');
        i += 1;
      }
    } else if (state === 'sq' || state === 'dq') {
      if (ch === '\\' && i + 1 < source.length) {
        const escaped = source[i + 1];
        if (escaped === '\n') literalNewlines += 1;
        literalBody += ch + escaped;
        i += 2;
        continue;
      }
      if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"')) {
        const idx = strings.length;
        strings.push(literalBody);
        const nlPad = '\n'.repeat(literalNewlines);
        const spacePad = ' '.repeat(Math.max(0, literalBody.length - literalNewlines));
        emptyQuotesOut += `${literalStartQuote}${literalStartQuote}${nlPad}${spacePad}`;
        placeholderOut += ` __STR_${idx}__ ${nlPad}`;
        state = 'code';
        canStartRegex = false;
        lastNonWsChar = ch;
        i += 1;
      } else {
        if (ch === '\n') literalNewlines += 1;
        literalBody += ch;
        i += 1;
      }
    } else if (state === 'bt') {
      if (ch === '\\' && i + 1 < source.length) {
        const escaped = source[i + 1];
        emitBoth(escaped === '\n' ? '\n' : '  ');
        i += 2;
      } else if (ch === '$' && next === '{') {
        templateBraceStack.push(0);
        emitBoth('${');
        state = 'code';
        canStartRegex = true;
        lastNonWsChar = '{';
        i += 2;
      } else if (ch === '`') {
        emitBoth('`');
        state = 'code';
        canStartRegex = false;
        lastNonWsChar = '`';
        i += 1;
      } else {
        emitBoth(ch === '\n' ? '\n' : ' ');
        i += 1;
      }
    } else {
      // state === 'regex'
      if (ch === '\\' && i + 1 < source.length) {
        if (next === '\n') {
          emitBoth(' \n');
          state = 'code';
          canStartRegex = true;
          i += 2;
        } else {
          emitBoth('  ');
          i += 2;
        }
      } else if (ch === '\n') {
        emitBoth('\n');
        state = 'code';
        canStartRegex = true;
        i += 1;
      } else if (ch === '[' && !regexInCharClass) {
        regexInCharClass = true;
        emitBoth(' ');
        i += 1;
      } else if (ch === ']' && regexInCharClass) {
        regexInCharClass = false;
        emitBoth(' ');
        i += 1;
      } else if (ch === '/' && !regexInCharClass) {
        emitBoth(' ');
        i += 1;
        while (i < source.length && /[A-Za-z]/.test(source[i])) {
          emitBoth(' ');
          i += 1;
        }
        state = 'code';
        canStartRegex = false;
        lastNonWsChar = '/';
      } else {
        emitBoth(' ');
        i += 1;
      }
    }
  }

  return {
    codeWithEmptyQuotes: emptyQuotesOut,
    codeWithPlaceholders: placeholderOut,
    strings,
  };
}

function extractRelativeSpecifiers(source: string): string[] {
  const { codeWithPlaceholders, strings } = scanSource(source);
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[^.\w$])import\s+(__STR_(\d+)__)/g,
    /(?:^|[^.\w$])import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\})(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))*\s+from\s+(__STR_(\d+)__)/g,
    /(?:^|[^.\w$])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+(__STR_(\d+)__)/g,
    /(?:^|[^.\w$])import\s*\(\s*(__STR_(\d+)__)\s*(?:,[^)]*)?\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of codeWithPlaceholders.matchAll(pattern)) {
      const idx = Number.parseInt(match[2] ?? '', 10);
      const spec = Number.isInteger(idx) ? strings[idx] : undefined;
      if (spec && spec.startsWith('.')) {
        specifiers.push(spec);
      }
    }
  }
  return specifiers;
}

function resolveImportTarget(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}.jsx`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function findImportCycles(rootDir: string, files?: string[]): Promise<string[][]> {
  const resolvedRoot = path.resolve(rootDir);
  const targetFiles = (
    files ? files.map((f) => path.resolve(f)) : await collectSourceFiles(resolvedRoot)
  ).sort();
  const knownFiles = new Set(targetFiles);
  const graph = new Map<string, string[]>();

  for (const file of targetFiles) {
    const source = await readFile(file, 'utf8');
    const deps = new Set<string>();
    for (const spec of extractRelativeSpecifiers(source)) {
      const target = resolveImportTarget(file, spec, knownFiles);
      if (target) deps.add(target);
    }
    graph.set(file, [...deps].sort());
  }

  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function dfs(node: string): void {
    color.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const idx = stack.indexOf(next);
        const cycle = stack
          .slice(idx)
          .concat(next)
          .map((p) => path.relative(resolvedRoot, p));
        cycles.push(cycle);
      } else if (state === 0) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  }

  for (const file of targetFiles) {
    if ((color.get(file) ?? 0) === 0) {
      dfs(file);
    }
  }

  return cycles;
}

export async function assertNoImportCycles(rootDir: string, files?: string[]): Promise<void> {
  const cycles = await findImportCycles(rootDir, files);
  assert.equal(
    cycles.length,
    0,
    `Circular imports detected under ${rootDir}:\n${cycles.map((c) => `  ${c.join(' -> ')}`).join('\n')}`,
  );
}

function splitTopLevelParams(paramsText: string): Array<{ text: string; offset: number }> {
  const params: Array<{ text: string; offset: number }> = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let inInitializer = false;
  let start = 0;

  for (let i = 0; i < paramsText.length; i += 1) {
    const ch = paramsText[i];
    const prev = paramsText[i - 1] ?? '';
    const next = paramsText[i + 1] ?? '';
    if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (
      ch === '=' &&
      !inInitializer &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0 &&
      next !== '>' &&
      next !== '='
    ) {
      inInitializer = true;
    } else if (!inInitializer && ch === '<' && next !== '=' && next !== '<' && prev !== '<') {
      angleDepth += 1;
    } else if (!inInitializer && ch === '>' && angleDepth > 0 && prev !== '=') {
      angleDepth -= 1;
    } else if (
      ch === ',' &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      params.push({ text: paramsText.slice(start, i), offset: start });
      start = i + 1;
      inInitializer = false;
    }
  }
  params.push({ text: paramsText.slice(start), offset: start });
  return params;
}

export function findNonErasableSyntax(source: string, filePath: string): string[] {
  const { codeWithEmptyQuotes: clean } = scanSource(source);
  const found: Array<{ offset: number; message: string }> = [];

  const lineOffset = (offset: number): number => clean.slice(0, offset).split('\n').length;
  const statementChecks: Array<{ pattern: RegExp; label: string }> = [
    {
      pattern: /(?:^|[;{}\n])\s*((?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$])/g,
      label: 'non-erasable enum declaration',
    },
    {
      pattern: /(?:^|[;{}\n])\s*((?:export\s+)?namespace\s+[A-Za-z_$])/g,
      label: 'non-erasable namespace declaration',
    },
    {
      pattern:
        /(?:^|[;{}\n])\s*((?:export\s+)?import\s+[A-Za-z_$][\w$]*\s*=\s*(?:require\s*\(|[A-Za-z_$]))/g,
      label: 'non-erasable import = require()',
    },
    {
      pattern: /(?:^|[;{}\n])\s*(export\s*=)/g,
      label: 'non-erasable export =',
    },
  ];

  for (const { pattern, label } of statementChecks) {
    for (const match of clean.matchAll(pattern)) {
      const prefixLen = match[0].length - (match[1]?.length ?? 0);
      const absIdx = (match.index ?? 0) + prefixLen;
      found.push({ offset: absIdx, message: `${filePath}:${lineOffset(absIdx)}: ${label}` });
    }
  }

  const ctorStart = /(?:^|[^\w$.])constructor\s*\(/g;
  for (const match of clean.matchAll(ctorStart)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let cursor = openParen + 1;
    while (cursor < clean.length && depth > 0) {
      if (clean[cursor] === '(') depth += 1;
      else if (clean[cursor] === ')') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) continue;
    const paramsText = clean.slice(openParen + 1, cursor - 1);
    for (const param of splitTopLevelParams(paramsText)) {
      const trimmed = param.text.trimStart();
      if (/^(?:public|private|protected|readonly)\s+[A-Za-z_$]/.test(trimmed)) {
        const leadingWs = param.text.length - trimmed.length;
        const absIdx = openParen + 1 + param.offset + leadingWs;
        found.push({
          offset: absIdx,
          message: `${filePath}:${lineOffset(absIdx)}: non-erasable constructor parameter property`,
        });
      }
    }
  }

  found.sort((a, b) => a.offset - b.offset);
  return found.map((item) => item.message);
}

export function assertErasableTypeScript(source: string, filePath: string): void {
  const issues = findNonErasableSyntax(source, filePath);
  assert.equal(issues.length, 0, `Non-erasable TypeScript syntax:\n${issues.join('\n')}`);
}

export function findPrettierViolations(source: string, filePath: string): string[] {
  const issues: string[] = [];
  if (source.includes('\r\n')) {
    issues.push(`${filePath}: contains CRLF line endings (expected LF)`);
  }
  if (source.length > 0 && !source.endsWith('\n')) {
    issues.push(`${filePath}: missing trailing newline`);
  }
  if (source.endsWith('\n\n')) {
    issues.push(`${filePath}: extra trailing blank line at EOF`);
  }
  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/^\t+/.test(line)) {
      issues.push(`${filePath}:${lineNo}: tab indentation found (expected 2 spaces)`);
    }
    if (/[ \t]+$/.test(line)) {
      issues.push(`${filePath}:${lineNo}: trailing whitespace`);
    }
  });
  return issues;
}

export function assertPrettierConventions(source: string, filePath: string): void {
  const issues = findPrettierViolations(source, filePath);
  assert.equal(issues.length, 0, `Formatting hygiene violations:\n${issues.join('\n')}`);
}
