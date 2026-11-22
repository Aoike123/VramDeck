import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, pause } from '../lib/core.mjs';
import { enginePolicyKey } from '../lib/llm.mjs';
import { servingPolicy, policyBudget } from '../../../engines/shared/paiton/client.mjs';
function fake() {
  return {
    models: { llm: [], media: [] },
    calls: [],
    busy: false,
    async ensure(model) {
      this.calls.push(model);
    },
    async idle() {
      return !this.busy;
    },
  };
}
test('loaded LLM batches a later shared request before switching to waiting media', async () => {
  const b = fake(),
    c = new Coordinator(b),
    first = await c.acquire('llm', { timeout: 2 }),
    order = [];
  const media = c.acquire('media', { timeout: 2 }).then(async (t) => {
    order.push('media');
    await c.release(t.token);
  });
  await pause(10);
  const llm = c.acquire('llm', { timeout: 2 }).then(async (t) => {
    order.push('llm');
    await c.release(t.token);
  });
  await pause(20);
  assert.deepEqual(b.calls, ['llm']);
  assert.equal(c.status().queued, 1);
  assert.deepEqual(order, ['llm']);
  await c.release(first.token);
  await Promise.all([media, llm]);
  assert.deepEqual(order, ['llm', 'media']);
});
test('shared leases avoid reload and final busy lease is retained', async () => {
  const b = fake(),
    c = new Coordinator(b),
    a = await c.acquire('llm', { timeout: 2 }),
    d = await c.acquire('llm', { timeout: 2, slot: '128k' });
  assert.deepEqual(b.calls, ['llm']);
  b.busy = true;
  await c.release(a.token);
  await assert.rejects(c.release(d.token), /still busy/);
  assert.equal(c.status().active_leases, 1);
  b.busy = false;
  await c.release(d.token);
});
test('expired busy ownership cannot be reclaimed', async () => {
  const b = fake();
  let now = 0;
  const c = new Coordinator(b, { clock: () => now, leaseSeconds: 1 }),
    a = await c.acquire('media');
  now = 2;
  b.busy = true;
  await c.recover();
  assert.equal(c.status().leased, true);
  b.busy = false;
  await c.recover();
  assert.equal(c.status().leased, false);
  await assert.rejects(c.release(a.token), /Invalid/);
});
test('renewal during idle check prevents expired ownership reclamation', async () => {
  const b = fake();
  let now = 0;
  const c = new Coordinator(b, { clock: () => now, leaseSeconds: 1 }),
    a = await c.acquire('llm', { exclusive: true });
  now = 2;
  b.idle = async () => {
    c.renew(a.token);
    return true;
  };
  await c.recover();
  assert.equal(c.status().leased, true);
});
test('queue timeout removes ticket and preserves ownership', async () => {
  const c = new Coordinator(fake()),
    a = await c.acquire('media');
  await assert.rejects(c.acquire('llm', { timeout: 0.03, exclusive: true }), /timeout/);
  assert.equal(c.status().queued, 0);
  assert.equal(c.status().leased, true);
  await c.release(a.token);
});
test('failed load clears target and queue, allows subsequent acquisition', async () => {
  const b = fake(),
    c = new Coordinator(b);
  b.ensure = async () => {
    assert.equal(c.status().switching_target, 'media');
    throw new Error('load failed');
  };
  await assert.rejects(c.acquire('media'), /load failed/);
  assert.equal(c.status().queued, 0);
  assert.equal(c.status().switching_target, null);
  assert.equal(c.status().leased, false);
  b.ensure = async () => {};
  await c.release((await c.acquire('llm', { exclusive: true })).token);
});
test('shared limit queues additional requests', async () => {
  const c = new Coordinator(fake(), { sharedLimit: 1 }),
    a = await c.acquire('llm', { timeout: 2 }),
    pending = c.acquire('llm', { timeout: 2 });
  await pause(20);
  assert.equal(c.status().queued, 1);
  await c.release(a.token);
  await c.release((await pending).token);
});
test('unknown models and tokens cannot change ownership', async () => {
  const c = new Coordinator(fake());
  await assert.rejects(c.acquire('__proto__'), /Unknown/);
  const a = await c.acquire('media');
  assert.throws(() => c.renew('wrong'), /Invalid/);
  await assert.rejects(c.release('wrong'), /Invalid/);
  assert.equal(c.status().leased, true);
  await c.release(a.token);
});
test('different public profiles share one unified backend without reload', async () => {
  const b = fake(),
    c = new Coordinator(b),
    a = await c.acquire('llm', { timeout: 2, slot: '192k' }),
    second = await c.acquire('llm', { timeout: 2, slot: '64k' });
  assert.equal(c.status().active_leases, 2);
  assert.deepEqual(b.calls, ['llm']);
  assert.deepEqual(c.status().active_slots, { '192k': 1, '64k': 1 });
  await c.release(a.token);
  await c.release(second.token);
});
test('configuration drains leases and rejects new requests before loading selected limits', async () => {
  const b = fake(),
    c = new Coordinator(b),
    a = await c.acquire('llm', { timeout: 2 }),
    second = await c.acquire('llm', { timeout: 2 });
  let loaded;
  b.ensure = async (model, deadline, clock, policy) => {
    loaded = policy;
    b.calls.push(model);
  };
  const throughput = servingPolicy('throughput');
  const switching = c.reconfigure('llm', throughput);
  await pause(20);
  assert.equal(c.reconfiguring.phase, 'draining');
  assert.equal(loaded, undefined);
  await assert.rejects(c.acquire('llm', { timeout: 2 }), /in progress/);
  await c.release(a.token);
  assert.equal(loaded, undefined);
  await c.release(second.token);
  await switching;
  assert.equal(loaded.context_tokens, 65536);
  assert.equal(loaded.concurrency, 8);
  assert.equal(loaded.kv_budget_bytes, 8859648000);
  assert.equal(c.reconfiguring, null);
  const ticket = await c.acquire('llm', { timeout: 2 });
  await c.release(ticket.token);
});
test('a final release racing with new shared requests frees its slot', async () => {
  const b = fake(),
    c = new Coordinator(b);
  await c.reconfigure('llm', servingPolicy('throughput'));
  const first = await c.acquire('llm', { timeout: 2, slot: '64k', concurrency: 8 });
  let finishIdle;
  b.idle = () =>
    new Promise((resolve) => {
      finishIdle = resolve;
    });
  const releasing = c.release(first.token);
  const tickets = [];
  for (let i = 0; i < 7; i++)
    tickets.push(await c.acquire('llm', { timeout: 2, slot: '64k', concurrency: 8 }));
  finishIdle(true);
  await releasing;
  assert.equal(c.status().active_slots['64k'], 7);
  tickets.push(await c.acquire('llm', { timeout: 0.2, slot: '64k', concurrency: 8 }));
  assert.equal(c.status().active_leases, 8);
  b.idle = async () => true;
  for (const ticket of tickets) await c.release(ticket.token);
});
test('failed engine restart does not publish or save the new policy', async () => {
  const b = fake(),
    c = new Coordinator(b);
  let persisted = false;
  await c.reconfigure('llm', servingPolicy('long'));
  b.ensure = async () => {
    throw Error('engine failed');
  };
  let failedState = null;
  await assert.rejects(
    c
      .reconfigure('llm', servingPolicy('long-single'), {
        apply: () => {
          persisted = true;
        },
      })
      .catch((err) => {
        failedState = c.engineSwitch;
        throw err;
      }),
    /engine failed/,
  );
  assert.equal(c.enginePolicies.get('llm').context_tokens, 196608);
  assert.equal(persisted, false);
  assert.equal(c.switching, false);
  assert.equal(failedState.phase, 'error');
  c.assertAcceptingRequests();
});
test('custom overbudget policies retain fixed KV and load the requested engine', async () => {
  const b = fake();
  const c = new Coordinator(b);
  let persisted;
  const custom = servingPolicy('custom', 262144, 8);
  const result = await c.reconfigure('llm', custom, {
    apply: (policy) => {
      persisted = policy;
      return { budget: policyBudget(policy, 390000) };
    },
  });
  assert.equal(result.budget.risk, true);
  assert.equal(persisted.kv_budget_bytes, 8589934592);
  assert.deepEqual(b.calls, ['llm']);
  assert.throws(() => servingPolicy('custom', 262145, 8), /Context/);
  assert.throws(() => servingPolicy('custom', 65536, 9), /Concurrency/);
});
test('duplicate policy writes are blocked; failed persistence preserves old policy', async () => {
  const c = new Coordinator(fake());
  let finish;
  const pending = c.reconfigure('llm', servingPolicy('throughput'), {
    apply: () => new Promise((r) => (finish = r)),
  });
  await pause(10);
  assert.throws(() => c.assertAcceptingRequests('llm'), /in progress/);
  await assert.rejects(c.reconfigure('llm', servingPolicy('long-single')), /already in progress/);
  finish();
  await pending;
  await assert.rejects(
    c.reconfigure('llm', servingPolicy('long'), {
      apply: async () => {
        throw Error('disk failed');
      },
    }),
    /disk failed/,
  );
  assert.equal(c.enginePolicies.get('llm').context_tokens, 65536);
  c.assertAcceptingRequests();
});
test('KV reservations wait for actual capacity and are released with leases', async () => {
  const b = fake();
  const c = new Coordinator(b),
    a = await c.acquire('llm', { timeout: 2 }),
    d = await c.acquire('llm', { timeout: 2 });
  await c.reserveBudget(a.token, 70, 2, { capacity: 100 });
  let acquired = false;
  const waiting = c.reserveBudget(d.token, 50, 0.5, { capacity: 100 }).then(() => {
    acquired = true;
  });
  await pause(20);
  assert.equal(acquired, false);
  await c.release(a.token);
  await waiting;
  assert.equal(acquired, true);
  assert.equal(c.allocations.find((x) => x.tokens.has(d.token)).reservations.get(d.token), 50);
  await assert.rejects(c.reserveBudget(d.token, 101, 2, { capacity: 100 }), /capacity/);
  await c.release(d.token);
});

test('disconnected GPU waiters leave the queue without starting another engine', async () => {
  const backend = fake(),
    c = new Coordinator(backend),
    owner = await c.acquire('media');
  const controller = new AbortController(),
    pending = c.acquire('llm', { timeout: 5, signal: controller.signal });
  await pause(10);
  controller.abort();
  await assert.rejects(pending, { code: 'CLIENT_REQUEST_CANCELLED' });
  assert.equal(c.status().queued, 0);
  assert.deepEqual(backend.calls, ['media']);
  assert.equal(c.status().active_leases, 1);
  await c.release(owner.token);
});
test('TTS shares one resident model up to its topology concurrency; other media stays exclusive', async () => {
  const b = fake();
  b.models.tts = [];
  const c = new Coordinator(b, { sharedEngines: { tts: 3 } });
  const leases = await Promise.all([1, 2, 3].map(() => c.acquire('tts', { timeout: 2 })));
  assert.equal(c.status().active_leases, 3);
  assert.deepEqual(b.calls, ['tts']);
  let fourth = null;
  const pending = c.acquire('tts', { timeout: 2 }).then((t) => (fourth = t));
  await pause(20);
  assert.equal(fourth, null);
  assert.equal(c.status().queued, 1);
  await c.release(leases[0].token);
  await pending;
  assert.equal(c.status().active_leases, 3);
  for (const t of [...leases.slice(1), fourth]) await c.release(t.token);
  assert.equal(c.status().leased, false);
  const m = await c.acquire('media', { timeout: 2 });
  let second = null;
  const queued = c.acquire('media', { timeout: 2 }).then((t) => (second = t));
  await pause(20);
  assert.equal(second, null);
  await c.release(m.token);
  await c.release((await queued).token);
});
