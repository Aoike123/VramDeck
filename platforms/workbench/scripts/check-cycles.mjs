import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKBENCH_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(WORKBENCH_DIR, '../..');

const ROOTS = [
  path.join(REPO_ROOT, 'platforms/workbench/lib'),
  path.join(REPO_ROOT, 'platforms/workbench/app'),
  path.join(REPO_ROOT, 'platforms/mcp'),
];

const SOURCE_EXTS = /\.(?:js|jsx|mjs|ts|tsx)$/;

async function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.next')) continue;
      out.push(...(await collectFiles(full)));
    } else if (entry.isFile() && SOURCE_EXTS.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function resolveRelativeImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return path.normalize(c);
  }
  return null;
}

function extractRelativeImports(source) {
  const specs = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re =
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const m of stripped.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

async function checkDir(rootDir) {
  const files = await collectFiles(rootDir);
  const graph = new Map();
  for (const file of files) {
    const norm = path.normalize(file);
    const src = await readFile(norm, 'utf8');
    const deps = [];
    for (const spec of extractRelativeImports(src)) {
      const target = resolveRelativeImport(norm, spec);
      if (target) deps.push(target);
    }
    graph.set(norm, deps);
  }

  const state = new Map(); // 0=unvisited, 1=visiting, 2=done
  const stack = [];
  const cycles = [];

  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const idx = stack.indexOf(dep);
        const cycle = stack
          .slice(idx)
          .concat(dep)
          .map((p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
        cycles.push(cycle.join(' -> '));
      } else if (s === 0) {
        dfs(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  }

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) dfs(node);
  }
  return cycles;
}

const allCycles = [];
for (const root of ROOTS) {
  allCycles.push(...(await checkDir(root)));
}

if (allCycles.length > 0) {
  console.error('Circular imports detected:\n' + allCycles.join('\n'));
  process.exit(1);
}
console.log('Zero circular imports across workbench/lib, workbench/app, and mcp.');
