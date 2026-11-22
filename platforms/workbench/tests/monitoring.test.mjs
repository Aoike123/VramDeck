import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { monitoring, resetSharedQueries } from '../lib/monitoring.mjs';
import { RingTelemetry } from '../lib/telemetry.ts';

// Answers are shared for a few seconds; each test stubs its own and starts from none.
beforeEach(() => {
  resetSharedQueries();
  delete process.env.WORKBENCH_PROMETHEUS_URL;
});

test('default ring-buffer mode makes zero Prometheus fetch calls and emits gpus, host, values, and trends', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Default mode must not call fetch');
  };
  try {
    const nowSec = Math.floor(Date.now() / 5000) * 5;
    const mockSnap = {
      collected_at: Date.now(),
      host: { os: 'linux', arch: 'x64', ram_total_mb: 65536, ram_free_mb: 32768 },
      gpus: [
        {
          id: 'nvidia:0',
          index: 0,
          vendor: 'nvidia',
          backend: 'cuda',
          name: 'RTX 4090',
          unified_memory: false,
          vram_total_mb: 24576,
          vram_used_mb: 6144,
          vram_free_mb: 18432,
          utilization_pct: 55,
          temperature_c: 61,
          power_w: 180,
        },
      ],
    };
    const telemetry = new RingTelemetry({ now: () => nowSec * 1000 });
    telemetry.record(
      {
        timestamp: nowSec - 10,
        values: { gpu: 40, vram: 4096 * 1048576, output: 18, input: 120, running: 1 },
      },
      mockSnap,
    );
    telemetry.record(
      {
        timestamp: nowSec,
        values: { gpu: 55, vram: 6144 * 1048576, output: 24, input: 150, running: 2, api: 1 },
      },
      mockSnap,
    );

    const coordinator = {
      status: () => ({ current: 'llm', llm_engine: { kv_budget_bytes: 7 * 2 ** 30 } }),
      backend: { residency: async () => ({ enabled: false, llm: 'cold' }) },
    };
    const metrics = {
      active: { llm: 1 },
      state: {
        totals: [{ model: 'llm', outcome: 'success', count: 5, seconds: 20 }],
        last_seconds: { llm: 4.2 },
        last_queue: { llm: 0.3 },
        recent: [{ model: 'llm', outcome: 'success', finished_at: 1700000100 }],
      },
    };

    const d = await monitoring(coordinator, metrics, 15, 30, undefined, { telemetry });
    assert.equal(d.gpus.length, 1);
    assert.equal(d.gpus[0].name, 'RTX 4090');
    assert.equal(d.host.ram_total_mb, 65536);
    assert.equal(d.values.vram, 6144 * 1048576);
    assert.equal(d.values.vram_total, 24576 * 1048576);
    assert.equal(d.values.gpu, 55);
    assert.equal(d.values.temperature, 61);
    assert.equal(d.values.last, 4.2);
    assert.equal(d.values.wait, 0.3);
    assert.equal(d.values.last_completed, 1700000100);
    assert.equal(d.values.success, 5);
    assert.equal(d.values.output, 24);
    assert.equal(d.trends.main.length, 181);
    assert.deepEqual(d.trends.main.slice(-3), [
      [nowSec - 10, 18],
      [nowSec - 5, null],
      [nowSec, 24],
    ]);
  } finally {
    globalThis.fetch = saved;
  }
});

test('0-GPU ring-buffer mode emits vram: null and vram_total: null so UI never renders / 0 GiB', async () => {
  const telemetry = new RingTelemetry({
    deviceProvider: {
      id: 'empty',
      async detect() {
        return {
          collected_at: Date.now(),
          host: { os: 'win32', arch: 'x64', ram_total_mb: 16384, ram_free_mb: 8192 },
          gpus: [],
        };
      },
    },
  });
  await telemetry.sampleNow();

  const d = await monitoring(
    { status: () => ({ current: null }), backend: { residency: async () => ({}) } },
    { active: {}, state: { recent: [] } },
    15,
    30,
    undefined,
    { telemetry },
  );
  assert.deepEqual(d.gpus, []);
  assert.equal(d.values.vram, null);
  assert.equal(d.values.vram_total, null);
  assert.equal(d.values.memory, 8192 * 1048576);
});

test('optional Prometheus mode preserves missing samples as chart gaps and avoids hardcoded model_name', async () => {
  const saved = globalThis.fetch;
  const queries = [];
  const now = Math.floor(Date.now() / 5000) * 5;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('query');
    queries.push(q);
    return {
      json: async () => ({
        status: 'success',
        data: {
          result: u.pathname.endsWith('query_range')
            ? [
                {
                  values: [
                    [now - 10, '12'],
                    [now, '0'],
                  ],
                },
              ]
            : [{ value: [now, q.includes('up{job="cpu_vision"}') ? 'NaN' : '0'] }],
        },
      }),
    };
  };
  try {
    const d = await monitoring(
      {
        status: () => ({ current: 'llm', llm_engine: { kv_budget_bytes: 7 * 2 ** 30 } }),
        backend: { residency: async () => ({}) },
      },
      { active: {}, state: { recent: [] } },
      15,
      30,
      undefined,
      { prometheusUrl: 'http://127.0.0.1:19090' },
    );
    assert.ok(queries.every((q) => !q.includes('qwen38-27b-w3a4')));
    assert.ok(
      queries.some((q) => q.includes('rate(vllm:generation_tokens_total') && q.includes('[30s]')),
    );
    assert.ok(
      queries.some((q) => q.includes('increase(vllm:prompt_tokens_total') && q.includes('[1m]')),
    );
    assert.ok(queries.some((q) => q.includes('min_over_time(up{job="llm"}[30s])')));
    assert.ok(queries.some((q) => q.includes('max_over_time(') && q.includes('[1m:5s]')));
    assert.equal(d.trends.main.length, 181);
    assert.deepEqual(d.trends.main.slice(-3), [
      [now - 10, 12],
      [now - 5, null],
      [now, 0],
    ]);
    assert.equal(d.values.vision_encode, null);
    assert.equal(d.sampling.output_window_seconds, 30);
    assert.equal(d.llm_engine.kv_budget_bytes, 7 * 2 ** 30);
  } finally {
    globalThis.fetch = saved;
  }
});

test('unavailable Prometheus falls back silently without inventing idle zeroes', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const d = await monitoring(
      { status: () => ({ current: 'llm' }), backend: { residency: async () => ({}) } },
      { active: {}, state: { recent: [] } },
      15,
      30,
      undefined,
      { prometheusUrl: 'http://127.0.0.1:19090' },
    );
    assert.equal(d.values.output, null);
    assert.equal(d.values.vision_up, null);
    assert.equal(d.trends.main, null);
  } finally {
    globalThis.fetch = saved;
  }
});

test('chart selection changes the curve while keeping the peak window fixed in Prometheus mode', async () => {
  const saved = globalThis.fetch;
  let queries = [];
  globalThis.fetch = async (url) => {
    queries.push(new URL(url).searchParams.get('query'));
    return { json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  try {
    for (const window of [5, 15, 30, 60]) {
      queries = [];
      resetSharedQueries();
      const d = await monitoring(
        { status: () => ({ current: 'llm' }), backend: { residency: async () => ({}) } },
        { active: {}, state: { recent: [] } },
        15,
        window,
        undefined,
        { prometheusUrl: 'http://127.0.0.1:19090' },
      );
      assert.equal(d.sampling.output_window_seconds, window);
      assert.ok(
        queries.some(
          (q) =>
            q.startsWith(
              window === 5
                ? 'sum(irate(vllm:generation_tokens_total'
                : 'sum(rate(vllm:generation_tokens_total',
            ) && q.includes(`[${window === 5 ? 30 : window}s]`),
        ),
      );
      assert.ok(queries.some((q) => q.includes('max_over_time(') && q.includes('[1m:5s]')));
    }
  } finally {
    globalThis.fetch = saved;
  }
});

test('requested service metrics remain separate from the actual and switching engines', async () => {
  const saved = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    queries.push(u.searchParams.get('query'));
    return {
      json: async () => ({
        status: 'success',
        data: { result: u.pathname.endsWith('query_range') ? [] : [{ value: [0, '42'] }] },
      }),
    };
  };
  try {
    const coordinator = {
      status: () => ({ current: 'llm', switching: true, switching_target: 'wan' }),
      backend: { residency: async () => ({}) },
    };
    const metrics = { active: { anima: 2 }, state: { recent: [] } };
    const anima = await monitoring(coordinator, metrics, 15, 30, 'anima', {
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    assert.equal(anima.model, 'anima');
    assert.equal(anima.current_model, 'llm');
    assert.equal(anima.switching_target, 'wan');
    assert.equal(anima.active, 2);
    assert.ok(queries.some((q) => q === 'lab_gateway_last_request_seconds{model="anima"}'));
    assert.equal(anima.trends.main, undefined);
    assert.equal(anima.values.kv, undefined);
    queries.length = 0;
    const llm = await monitoring(coordinator, metrics, 15, 30, 'llm', {
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    assert.equal(llm.values.output, null);
    assert.equal(llm.values.kv, null);
    assert.equal(llm.values.running, null);
    assert.equal(llm.values.gpu, 42);
  } finally {
    globalThis.fetch = saved;
  }
});

test('readers within a few seconds share one round of queries; the KV tables ride only on full requests', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  try {
    const coordinator = {
      status: () => ({ current: 'llm', kv_forecast: { big: true } }),
      backend: { residency: async () => ({}), previewPlan: async () => ({ plan: true }) },
    };
    const metrics = { active: {}, state: { recent: [] } };
    const lite = await monitoring(coordinator, metrics, 15, 30, undefined, {
      full: false,
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    const first = calls;
    await monitoring(coordinator, metrics, 15, 30, undefined, {
      full: false,
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    assert.equal(calls, first, 'a second reader reuses the answers');
    assert.deepEqual([lite.kv_forecast, lite.kv_preview_plan], [null, null]);
    const full = await monitoring(coordinator, metrics, 15, 30, undefined, {
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    assert.deepEqual([full.kv_forecast, full.kv_preview_plan], [{ big: true }, { plan: true }]);
    assert.equal(calls, first, 'full still shares the queries');
    await monitoring(coordinator, metrics, 30, 30, undefined, {
      full: false,
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    assert.ok(calls > first, 'another range is a different question');
  } finally {
    globalThis.fetch = saved;
  }
});

test('shareFor cache key separates ring mode from prometheusUrl mode', async () => {
  const saved = globalThis.fetch;
  let promCalls = 0;
  globalThis.fetch = async () => {
    promCalls++;
    return { json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  try {
    const coordinator = {
      status: () => ({ current: 'llm' }),
      backend: { residency: async () => ({}) },
    };
    const metrics = { active: {}, state: { recent: [] } };
    await monitoring(coordinator, metrics, 15, 30);
    assert.equal(promCalls, 0);
    await monitoring(coordinator, metrics, 15, 30, undefined, {
      prometheusUrl: 'http://127.0.0.1:19090',
    });
    assert.ok(promCalls > 0);
  } finally {
    globalThis.fetch = saved;
  }
});
