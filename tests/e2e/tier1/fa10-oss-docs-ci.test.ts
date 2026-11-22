import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertNoImportCycles } from '../lib/assertions.ts';
import {
  deliverableExists,
  E2E_ROOT,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { runCommand, withWorkbenchTsconfigLock } from '../lib/process-runner.ts';

async function hasM6BrandAndReadmes(): Promise<boolean> {
  if (!(await deliverableExists('README.md')) || !(await deliverableExists('README.zh-CN.md'))) {
    return false;
  }
  const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  return /\bVramDeck\b/.test(readme) && !/^#\s*本地 AI 工作台/m.test(readme);
}

async function hasM6ContributorDocs(): Promise<boolean> {
  return (
    (await deliverableExists('CONTRIBUTING.md')) &&
    (await deliverableExists('docs/guide/ADD_ENGINE.md'))
  );
}

async function hasM6GithubTemplates(): Promise<boolean> {
  const issueDir = path.join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE');
  if (!existsSync(issueDir)) return false;
  const entries = await readdir(issueDir, { withFileTypes: true });
  const hasIssueTemplate = entries.some((e) => e.isFile() && /\.(?:ya?ml|md)$/i.test(e.name));
  const hasPrTemplate = await deliverableExists('.github/PULL_REQUEST_TEMPLATE.md');
  return hasIssueTemplate && hasPrTemplate;
}

async function hasM6CiEnhancements(): Promise<boolean> {
  if (!(await deliverableExists('.github/workflows/ci.yml'))) return false;
  const ci = await readFile(path.join(REPO_ROOT, '.github', 'workflows/ci.yml'), 'utf8');
  const hasPrettier = /format:check|prettier\s+--check/.test(ci);
  const hasCycles = /cycle|assertNoImportCycles|circular/i.test(ci);
  return hasPrettier && hasCycles;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdownFiles(path.join(dir, entry.name))));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

function extractRelativeMarkdownLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    links.push(match[1]);
  }
  for (const match of markdown.matchAll(/<img\s+[^>]*src=["']([^"']+)["']/gi)) {
    links.push(match[1]);
  }
  return links.filter((target) => {
    if (!target || target.startsWith('#')) return false;
    if (/^(?:https?:|mailto:|data:)/i.test(target)) return false;
    return true;
  });
}

function assertAllRelativeLinksExist(docRelPath: string, markdown: string): void {
  const baseDir = path.dirname(path.join(REPO_ROOT, docRelPath));
  for (const rawTarget of extractRelativeMarkdownLinks(markdown)) {
    const clean = rawTarget.split('#')[0]?.split('?')[0] ?? '';
    if (!clean) continue;
    const resolved = path.resolve(baseDir, clean);
    assert.equal(
      existsSync(resolved),
      true,
      `Broken relative link "${rawTarget}" in ${docRelPath} -> ${resolved}`,
    );
  }
}

describe('FA10 Tier 1: VramDeck OSS Docs, Templates & Cross-Platform CI', () => {
  it('fa10.t1.1 unifies VramDeck brand across READMEs, CLI package bin, UI, and retains compatibility notes', async (t) => {
    const ready = await hasM6BrandAndReadmes();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #24): VramDeck unified branding & bilingual README.md / README.zh-CN.md not delivered',
      )
    ) {
      return;
    }

    const readmeEn = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeZh = await readFile(path.join(REPO_ROOT, 'README.zh-CN.md'), 'utf8');

    for (const [name, content] of [
      ['README.md', readmeEn],
      ['README.zh-CN.md', readmeZh],
    ] as const) {
      assert.match(content, /\bVramDeck\b/, `${name} must prominently present VramDeck`);
      assert.match(content, /llm-backend/, `${name} must retain llm-backend compatibility note`);
      assert.doesNotMatch(content, /\/home\/aoike|\/media\/aoike|~\/文档\/llm-backend/);
    }
    assert.match(readmeEn, /README\.zh-CN\.md/);
    assert.match(readmeZh, /README\.md/);

    const pkgJson = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'platforms', 'workbench', 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    assert.ok(pkgJson.bin?.vramdeck, 'package.json bin.vramdeck must exist');
    const binTarget = path.resolve(REPO_ROOT, 'platforms', 'workbench', pkgJson.bin.vramdeck);
    assert.equal(existsSync(binTarget), true, `bin.vramdeck target must exist: ${binTarget}`);

    const layoutRel = await findFirstExisting([
      'platforms/workbench/app/layout.tsx',
      'platforms/workbench/app/layout.jsx',
    ]);
    assert.ok(layoutRel);
    const layoutSrc = await readFile(path.join(REPO_ROOT, layoutRel), 'utf8');
    assert.match(layoutSrc, /VramDeck/);
    assert.doesNotMatch(layoutSrc, /AI Workbench/);
  });

  it('fa10.t1.2 bilingual READMEs include 3-step Quickstart, 4-vendor HW matrix, and architecture/client guide', async (t) => {
    const ready = await hasM6BrandAndReadmes();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #24): README.md & README.zh-CN.md Quickstart/HW matrix/architecture guide not delivered',
      )
    ) {
      return;
    }

    const readmeEn = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeZh = await readFile(path.join(REPO_ROOT, 'README.zh-CN.md'), 'utf8');

    for (const [docRel, content] of [
      ['README.md', readmeEn],
      ['README.zh-CN.md', readmeZh],
    ] as const) {
      assert.match(content, /Quickstart|快速开始|快速上手/i, `${docRel} missing Quickstart`);
      assert.match(content, /13000/);
      assert.match(content, /18982/);
      assert.match(content, /CUDA/i);
      assert.match(content, /ROCm/i);
      assert.match(content, /Metal/i);
      assert.match(content, /CPU/i);
      assert.match(content, /How It Works|工作原理/i, `${docRel} missing architecture overview`);
      assert.match(
        content,
        /Cursor|Open WebUI|Ollama|ComfyUI/i,
        `${docRel} missing client/runtime integration guide`,
      );
      assert.doesNotMatch(
        content,
        /vramdeck-demo\.gif/i,
        `${docRel} must not keep stale GIF TODO placeholder`,
      );
      assertAllRelativeLinksExist(docRel, content);
    }
  });

  it('fa10.t1.3 delivers CONTRIBUTING.md and docs/guide/ADD_ENGINE.md linked from docs/README.md', async (t) => {
    const ready = await hasM6ContributorDocs();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #25): CONTRIBUTING.md & docs/guide/ADD_ENGINE.md not delivered',
      )
    ) {
      return;
    }

    const contributing = await readFile(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const addEngine = await readFile(
      path.join(REPO_ROOT, 'docs', 'guide', 'ADD_ENGINE.md'),
      'utf8',
    );
    const docsIndex = await readFile(path.join(REPO_ROOT, 'docs', 'README.md'), 'utf8');

    assert.match(contributing, /check-project\.py|lab check/);
    assert.match(contributing, /erasableSyntaxOnly/i);
    assert.match(contributing, /prettier/i);

    assert.match(addEngine, /engine\.json/);
    assert.match(addEngine, /platform\.engine/);
    assert.match(addEngine, /platform\.runtime/);
    assert.match(addEngine, /platform\.resources/);
    assert.match(addEngine, /platform\.surface/);
    assert.match(addEngine, /engine-sdk/);

    assert.match(docsIndex, /guide\/ADD_ENGINE\.md/);

    assertAllRelativeLinksExist('CONTRIBUTING.md', contributing);
    assertAllRelativeLinksExist('docs/guide/ADD_ENGINE.md', addEngine);
    assertAllRelativeLinksExist('docs/README.md', docsIndex);
  });

  it('fa10.t1.4 provides GitHub Issue/PR templates and curated good first issue catalog', async (t) => {
    const ready = await hasM6GithubTemplates();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #26): .github/ISSUE_TEMPLATE/* & PULL_REQUEST_TEMPLATE.md not delivered',
      )
    ) {
      return;
    }

    const issueDir = path.join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE');
    const entries = await readdir(issueDir, { withFileTypes: true });
    const templates = entries.filter((e) => e.isFile() && /\.(?:ya?ml|md)$/i.test(e.name));
    assert.ok(templates.length >= 2, 'Expected bug + feature/engine issue templates');

    const issueTexts = await Promise.all(
      templates.map((e) => readFile(path.join(issueDir, e.name), 'utf8')),
    );
    const joinedIssues = issueTexts.join('\n');
    assert.match(joinedIssues, /OS/i);
    assert.match(joinedIssues, /GPU|VRAM/i);

    const prTemplate = await readFile(
      path.join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'),
      'utf8',
    );
    assert.match(prTemplate, /- \[ \]/);

    const contributing = existsSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'))
      ? await readFile(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
      : '';
    const docsEntries = await collectMarkdownFiles(path.join(REPO_ROOT, 'docs'));
    const docsTexts = await Promise.all(docsEntries.map((f) => readFile(f, 'utf8')));
    const combined = [contributing, prTemplate, ...issueTexts, ...docsTexts].join('\n');
    assert.match(combined, /good first issue/i, 'Missing curated good first issue catalog');
    const bulletItems = combined
      .split(/\r?\n/)
      .filter(
        (line) =>
          /^\s*[-*]\s+/.test(line) &&
          /good first issue|starter|beginner|adapter|docs|provider/i.test(line),
      );
    assert.ok(bulletItems.length >= 3 || /good first issue/i.test(combined));
  });

  it('fa10.t1.5 configures 3-OS GitHub Actions CI matrix with Python, Node, tsc, Prettier, cycle & Next build gates', async (t) => {
    const ready = await hasM6CiEnhancements();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #27): .github/workflows/ci.yml Prettier & circular-dependency CI gates not delivered',
      )
    ) {
      return;
    }

    const ciText = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ciText, /ubuntu-latest/);
    assert.match(ciText, /macos-latest/);
    assert.match(ciText, /windows-latest/);
    assert.match(ciText, /check-project\.py\s+--suite\s+python/);
    assert.match(ciText, /check-project\.py\s+--suite\s+node/);
    assert.match(ciText, /typecheck|tsc\s+--noEmit/);
    assert.match(ciText, /format:check|prettier\s+--check/);
    assert.match(ciText, /cycle|circular|assertNoImportCycles/i);
    assert.match(ciText, /npm\s+run\s+build/);
    assert.equal(
      existsSync(path.join(REPO_ROOT, '.workbench', 'scripts', 'check-project.py')),
      true,
    );
    assert.equal(
      existsSync(path.join(REPO_ROOT, 'platforms', 'workbench', 'package-lock.json')),
      true,
    );
  });

  it('fa10.t1.6 runs live tsc --noEmit, Prettier format:check, and zero import-cycle verification', async (t) => {
    const hasTsc = await deliverableExists('platforms/workbench/node_modules/typescript/bin/tsc');
    const hasPrettier = await deliverableExists(
      'platforms/workbench/node_modules/prettier/bin/prettier.cjs',
    );
    if (
      !requireDeliverable(
        t,
        hasTsc && hasPrettier,
        'M1 (Features #9, #10): typescript & prettier devDependencies required',
      )
    ) {
      return;
    }

    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const nodeBin = resolveNode22Plus();
    const tscBin = path.join(workbenchDir, 'node_modules', 'typescript', 'bin', 'tsc');
    const prettierBin = path.join(workbenchDir, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
    const tsconfigPath = path.join(workbenchDir, 'tsconfig.json');

    const tscRes = await withWorkbenchTsconfigLock(() =>
      runCommand(nodeBin, [tscBin, '--noEmit', '-p', tsconfigPath]),
    );
    assert.equal(tscRes.code, 0, `tsc failed:\n${tscRes.stdout}\n${tscRes.stderr}`);

    const pkg = JSON.parse(await readFile(path.join(workbenchDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const formatScript = pkg.scripts?.['format:check'] ?? '';
    assert.ok(formatScript.includes('prettier'), 'Expected format:check script in package.json');

    const prettierArgs = [
      prettierBin,
      '--check',
      '--no-error-on-unmatched-pattern',
      '--ignore-path',
      path.join(REPO_ROOT, '.prettierignore'),
      'cli.ts',
      'cli.mjs',
      'server.mjs',
      'lib/**/*.ts',
      'tests/**/*.ts',
      'app/**/*.ts',
      'app/**/*.tsx',
      'lib/backend.mjs',
      'lib/http.mjs',
      'lib/media-jobs.mjs',
      'lib/monitoring.mjs',
      'lib/process-lock.mjs',
      'lib/public-exposure.mjs',
      'lib/registry.mjs',
      'tests/api-catalog.test.mjs',
      'tests/backend.test.mjs',
      'tests/monitoring.test.mjs',
      'tests/process-lock.test.mjs',
      'tests/public-exposure.test.mjs',
      'app/page.jsx',
      'app/control-center.jsx',
      'next.config.mjs',
      'tsconfig.json',
      'package.json',
    ];
    const fmtRes = await runCommand(nodeBin, prettierArgs, {
      cwd: workbenchDir,
      timeoutMs: 45_000,
    });
    assert.equal(fmtRes.code, 0, `prettier --check failed:\n${fmtRes.stdout}\n${fmtRes.stderr}`);

    const e2eFmtRes = await runCommand(nodeBin, [prettierBin, '--check', E2E_ROOT], {
      cwd: REPO_ROOT,
      timeoutMs: 45_000,
    });
    assert.equal(
      e2eFmtRes.code,
      0,
      `tests/e2e prettier --check failed:\n${e2eFmtRes.stdout}\n${e2eFmtRes.stderr}`,
    );

    await assertNoImportCycles(path.join(REPO_ROOT, 'platforms', 'workbench', 'lib'));
    await assertNoImportCycles(path.join(REPO_ROOT, 'platforms', 'workbench', 'app'));
    await assertNoImportCycles(path.join(REPO_ROOT, 'platforms', 'mcp'));
    await assertNoImportCycles(E2E_ROOT);

    if (await hasM6CiEnhancements()) {
      const repoPrettierRes = await runCommand(
        nodeBin,
        [
          prettierBin,
          '--check',
          '--ignore-path',
          path.join(REPO_ROOT, '.prettierignore'),
          'platforms/**/*.{js,jsx,mjs,ts,tsx}',
          'engines/**/*.{js,mjs,ts}',
          'tests/**/*.ts',
        ],
        { cwd: REPO_ROOT, timeoutMs: 60_000 },
      );
      assert.equal(
        repoPrettierRes.code,
        0,
        `Full-repo prettier --check failed:\n${repoPrettierRes.stdout}\n${repoPrettierRes.stderr}`,
      );
    }
  });
});
