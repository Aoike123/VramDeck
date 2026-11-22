import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import {
  assertErasableTypeScript,
  assertNoImportCycles,
  assertPrettierConventions,
} from './lib/assertions.ts';
import { E2E_ROOT, isNode22Plus, isStrictMode } from './lib/env.ts';

type TierSelection = '1' | '2' | '3' | '4' | 'all';

interface CliOptions {
  tier: TierSelection;
  strict: boolean;
  areas: string[];
  json: boolean;
  help: boolean;
}

interface SkipOrTodoRecord {
  file: string;
  name: string;
  reason: string | boolean;
  kind: string;
}

interface FailureRecord {
  file: string;
  name: string;
  error: string;
}

interface GlobalSummaryData {
  success: boolean;
  counts: {
    tests: number;
    failed: number;
    passed: number;
    cancelled: number;
    skipped: number;
    todo: number;
  };
}

function printHelp(): void {
  const text = [
    'Usage: node tests/e2e/run-e2e.ts [options]',
    '',
    'Options:',
    '  --tier <1|2|3|4|all>   Select E2E tier to execute (default: all)',
    '  --area <prefix>        Filter test files by prefix (repeatable or comma-separated)',
    '  --strict               Fail if any test or suite is skipped or todo (E2E_STRICT=1)',
    '  --json                 Emit structured JSON report to stdout',
    '  -h, --help             Show this help message',
  ].join('\n');
  process.stdout.write(`${text}\n`);
}

function parseCliArgs(argv: string[]): CliOptions {
  let tier: TierSelection = 'all';
  let strict = isStrictMode();
  const areas: string[] = [];
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--tier' || arg.startsWith('--tier=')) {
      const value = arg.includes('=') ? arg.slice('--tier='.length) : argv[++i];
      if (!value || !['1', '2', '3', '4', 'all'].includes(value)) {
        throw new Error(`Invalid --tier value "${String(value)}"; expected 1|2|3|4|all`);
      }
      tier = value as TierSelection;
    } else if (arg === '--area' || arg.startsWith('--area=')) {
      const value = arg.includes('=') ? arg.slice('--area='.length) : argv[++i];
      if (!value) {
        throw new Error('--area requires a non-empty prefix');
      }
      for (const part of value.split(',')) {
        const normalized = part.trim().toLowerCase();
        if (normalized) areas.push(normalized);
      }
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return { tier, strict, areas: [...new Set(areas)], json, help };
}

async function collectTsFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...(await collectTsFilesRecursive(path.join(dir, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files.sort();
}

async function discoverTestFiles(tier: TierSelection, areas: string[]): Promise<string[]> {
  const tierDirs = tier === 'all' ? ['tier1', 'tier2', 'tier3', 'tier4'] : [`tier${tier}`];
  const discovered: string[] = [];

  for (const dirName of tierDirs) {
    const dirPath = path.join(E2E_ROOT, dirName);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') continue;
      throw err;
    }
    const tierFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map((entry) => entry.name)
      .sort()
      .filter((name) => {
        if (areas.length === 0) return true;
        const lower = name.toLowerCase();
        return areas.some((prefix) => lower.startsWith(prefix));
      })
      .map((name) => path.join(dirPath, name));
    discovered.push(...tierFiles);
  }

  return discovered;
}

async function runPreflightChecks(): Promise<string[]> {
  const errors: string[] = [];
  const tsFiles = await collectTsFilesRecursive(E2E_ROOT);

  try {
    await assertNoImportCycles(E2E_ROOT, tsFiles);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  for (const file of tsFiles) {
    const rel = path.relative(E2E_ROOT, file);
    const source = await readFile(file, 'utf8');
    try {
      assertErasableTypeScript(source, rel);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    try {
      assertPrettierConventions(source, rel);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return errors;
}

function formatTestError(errorObj: unknown): string {
  if (!errorObj) return 'Unknown test failure';
  if (errorObj instanceof Error) {
    const cause = (errorObj as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
    return `${errorObj.message}${causeMsg}`;
  }
  if (typeof errorObj === 'object') {
    const rec = errorObj as { message?: unknown; cause?: unknown };
    if (typeof rec.message === 'string') return rec.message;
  }
  return String(errorObj);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let opts: CliOptions;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  if (!isNode22Plus()) {
    const msg = `Node.js >=22.19.0 is required to run E2E tests (current: ${process.versions.node})`;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const preflightErrors = await runPreflightChecks();
  if (preflightErrors.length > 0) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, preflightErrors }, null, 2)}\n`);
    } else {
      process.stderr.write(`E2E preflight failed:\n${preflightErrors.join('\n')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const files = await discoverTestFiles(opts.tier, opts.areas);
  if (files.length === 0) {
    const msg = `No E2E test files matched (tier=${opts.tier}, area=${opts.areas.join(',') || '*'})`;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (opts.strict) {
    process.env.E2E_STRICT = '1';
  }

  let passed = 0;
  const skipped: SkipOrTodoRecord[] = [];
  const todos: SkipOrTodoRecord[] = [];
  const failures: FailureRecord[] = [];
  const diagnostics: string[] = [];
  const summaryState: { global: GlobalSummaryData | null } = { global: null };

  const stream = run({ files, isolation: 'process' });

  stream.on('test:pass', (data) => {
    const file = data.file ? path.relative(E2E_ROOT, data.file) : '<unknown>';
    const kind = data.details?.type ?? 'test';
    if (data.skip !== undefined) {
      skipped.push({ file, name: data.name, reason: data.skip, kind });
      return;
    }
    if (data.todo !== undefined) {
      todos.push({ file, name: data.name, reason: data.todo, kind });
      return;
    }
    if (kind !== 'suite') {
      passed += 1;
    }
  });

  stream.on('test:fail', (data) => {
    const file = data.file ? path.relative(E2E_ROOT, data.file) : '<unknown>';
    const kind = data.details?.type ?? 'test';
    const errObj = data.details?.error as { failureType?: string } | undefined;
    if (kind === 'suite' && errObj?.failureType === 'subtestsFailed') {
      return;
    }
    failures.push({
      file,
      name: data.name,
      error: formatTestError(data.details?.error),
    });
  });

  stream.on('test:summary', (data) => {
    if (data.file === undefined) {
      const counts = data.counts as typeof data.counts & { failed?: number };
      summaryState.global = {
        success: data.success,
        counts: {
          tests: counts.tests,
          failed: counts.failed ?? failures.length,
          passed: counts.passed,
          cancelled: counts.cancelled,
          skipped: counts.skipped,
          todo: counts.todo,
        },
      };
    }
  });

  if (opts.json) {
    stream.on('test:stdout', (data) => {
      if (data.message) diagnostics.push(data.message);
    });
    stream.on('test:stderr', (data) => {
      if (data.message) diagnostics.push(data.message);
    });
    for await (const _chunk of stream) {
      // Drained via event listeners.
    }
  } else {
    for await (const chunk of stream.compose(spec)) {
      process.stdout.write(chunk);
    }
  }

  const strictViolation =
    opts.strict &&
    (skipped.length > 0 ||
      todos.length > 0 ||
      (summaryState.global?.counts.skipped ?? 0) > 0 ||
      (summaryState.global?.counts.todo ?? 0) > 0);

  const hasTestsOrSkips = passed + skipped.length + todos.length + failures.length > 0;
  const ok =
    failures.length === 0 &&
    (summaryState.global?.success ?? false) &&
    hasTestsOrSkips &&
    !strictViolation;

  const durationMs = Date.now() - startedAt;

  if (opts.json) {
    const report = {
      ok,
      strict: opts.strict,
      nodeVersion: process.versions.node,
      filters: { tier: opts.tier, areas: opts.areas },
      files: files.map((f) => path.relative(E2E_ROOT, f)),
      counts: {
        passed,
        failed: failures.length,
        skipped: skipped.length,
        todo: todos.length,
      },
      skipped,
      todos,
      failures,
      diagnostics,
      durationMs,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (strictViolation) {
    process.stderr.write(
      `\n[E2E_STRICT] Refusing ${skipped.length} skipped and ${todos.length} todo entries:\n`,
    );
    for (const item of [...skipped, ...todos]) {
      process.stderr.write(`  - ${item.file} :: ${item.name} (${String(item.reason)})\n`);
    }
  }

  process.exitCode = ok ? 0 : 1;
}

void main();
