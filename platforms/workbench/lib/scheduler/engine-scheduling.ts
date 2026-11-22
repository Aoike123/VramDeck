// Batching policy for GPU queues. Turns count actual GPU grants, starting after
// ensure() completes, so cold loading does not consume a turn. Batches are per
// runtime, not per engine: engines sharing one process (e.g. H3 and Anima on
// ComfyUI) switch without a restart, so their requests reuse the loaded runtime
// together and only a different runtime has to wait for its turn.

export interface SchedulingPolicy {
  minBatchRequests?: number;
  maxBatchRequests?: number;
  maxBatchSeconds?: number;
  maxWaitSeconds?: number;
}

export interface NormalizedSchedulingPolicy {
  minBatchRequests: number;
  maxBatchRequests: number;
  maxBatchSeconds: number;
  maxWaitSeconds: number;
}

export interface SchedulingOptions {
  groupOf?: (engine: string) => string | null | undefined;
}

export interface SchedulingRequest {
  engine: string;
  enqueuedAt: number;
}

export interface EngineTurn {
  runtime: string;
  engine: string;
  startedAt: number;
  requests: number;
}

export interface SchedulingDecision<T extends SchedulingRequest = SchedulingRequest> {
  request: T | null;
  reason: string;
}

export class EngineScheduling {
  readonly policy: NormalizedSchedulingPolicy;
  readonly groupOf: (engine: string) => string | null | undefined;
  turn: EngineTurn | null;
  readonly runtimeTurns: Map<string, EngineTurn>;

  constructor(
    {
      minBatchRequests = 2,
      maxBatchRequests = 4,
      maxBatchSeconds = 120,
      maxWaitSeconds = 300,
    }: SchedulingPolicy = {},
    { groupOf = (engine: string) => engine }: SchedulingOptions = {},
  ) {
    for (const [name, value] of Object.entries({
      minBatchRequests,
      maxBatchRequests,
      maxBatchSeconds,
      maxWaitSeconds,
    })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid engine scheduling ${name}`);
      }
    }
    if (minBatchRequests > maxBatchRequests) {
      throw new Error('minBatchRequests exceeds maxBatchRequests');
    }
    this.policy = { minBatchRequests, maxBatchRequests, maxBatchSeconds, maxWaitSeconds };
    this.turn = null;
    this.groupOf = groupOf;
    this.runtimeTurns = new Map();
  }

  group(engine: string | null | undefined): string | null {
    if (engine == null) return null;
    return this.groupOf(engine) ?? engine;
  }

  granted(engine: string, now: number): void {
    const runtime = this.group(engine) ?? engine;
    if (this.turn?.runtime !== runtime) {
      this.turn = { runtime, engine, startedAt: now, requests: 0 };
    }
    this.turn.engine = engine;
    this.turn.requests++;

    let runtimeTurn = this.runtimeTurns.get(runtime);
    if (!runtimeTurn || runtimeTurn.runtime !== runtime) {
      runtimeTurn = { runtime, engine, startedAt: now, requests: 0 };
      this.runtimeTurns.set(runtime, runtimeTurn);
    }
    runtimeTurn.engine = engine;
    runtimeTurn.requests++;
  }

  resetRuntime(engineOrRuntime: string | null | undefined): void {
    if (!engineOrRuntime) return;
    const runtime = this.group(engineOrRuntime) ?? engineOrRuntime;
    this.runtimeTurns.delete(runtime);
    if (this.turn?.runtime === runtime) {
      this.turn = null;
    }
  }

  isBatchEligible(
    engine: string,
    now: number,
    waitingRequests: ReadonlyArray<SchedulingRequest> = [],
  ): boolean {
    const runtime = this.group(engine) ?? engine;
    const turn = this.runtimeTurns.get(runtime);
    if (!turn) return true;
    const p = this.policy;
    if (now - turn.startedAt >= p.maxBatchSeconds) return true;
    if (turn.requests >= p.maxBatchRequests) return true;
    if (turn.requests < p.minBatchRequests) return false;
    const hasSameRuntimeWaiting = waitingRequests.some((job) => this.group(job.engine) === runtime);
    const hasAgedOther = waitingRequests.some(
      (job) => this.group(job.engine) !== runtime && now - job.enqueuedAt >= p.maxWaitSeconds,
    );
    return !hasSameRuntimeWaiting || hasAgedOther;
  }

  choose<T extends SchedulingRequest>(
    requests: ReadonlyArray<T>,
    current: string | null | undefined,
    now: number,
  ): SchedulingDecision<T> {
    if (!requests.length) return { request: null, reason: 'empty' };
    const ordered = [...requests].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    // Requests for any engine on the loaded runtime count as reuse, oldest first.
    const runtime = this.group(current);
    const same = ordered.find((job) => this.group(job.engine) === runtime) ?? null;
    const other = ordered.find((job) => this.group(job.engine) !== runtime) ?? null;
    if (!same) return { request: ordered[0], reason: 'oldest_waiting_engine' };
    if (!other) return { request: same, reason: 'reuse_only_waiting_engine' };
    const turn = this.turn?.runtime === runtime ? this.turn : null;
    const p = this.policy;
    if (turn && now - turn.startedAt >= p.maxBatchSeconds) {
      return { request: other, reason: 'batch_time_limit' };
    }
    // Finish a small batch even when old queues are already aged; otherwise
    // multiple aged engines would alternate after every single request.
    if ((turn?.requests ?? 0) < p.minBatchRequests) {
      return { request: same, reason: 'minimum_engine_batch' };
    }
    if (turn && turn.requests >= p.maxBatchRequests) {
      return { request: other, reason: 'batch_request_limit' };
    }
    if (now - other.enqueuedAt >= p.maxWaitSeconds) {
      return { request: other, reason: 'waiting_engine_aged' };
    }
    return { request: same, reason: 'reuse_loaded_engine' };
  }

  status(
    requests: ReadonlyArray<SchedulingRequest>,
    current: string | null | undefined,
    now: number,
  ) {
    const decision = this.choose(requests, current, now);
    return {
      policy: this.policy,
      turn: this.turn
        ? {
            runtime: this.turn.runtime,
            engine: this.turn.engine,
            requests: this.turn.requests,
            elapsed_seconds: Math.max(0, now - this.turn.startedAt),
          }
        : null,
      next_engine: decision.request?.engine ?? null,
      next_runtime: this.group(decision.request?.engine),
      reason: decision.reason,
      waiting_by_engine: Object.fromEntries(
        [...new Set(requests.map((job) => job.engine))].map((engine) => [
          engine,
          requests.filter((job) => job.engine === engine).length,
        ]),
      ),
    };
  }
}
