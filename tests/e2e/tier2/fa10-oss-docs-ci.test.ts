import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertNoImportCycles } from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { runCommand } from '../lib/process-runner.ts';

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
  const ci = await readFile(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  return (
    /format:check|prettier\s+--check/.test(ci) && /cycle|assertNoImportCycles|circular/i.test(ci)
  );
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

describe('FA10 Tier 2: OSS Docs, CI & Hygiene boundary / negative tests', () => {
  it('fa10.t2.1 detects zero broken relative markdown links and zero local path leaks', async (t) => {
    const ready = (await hasM6BrandAndReadmes()) && (await hasM6ContributorDocs());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Features #24, #25): README/CONTRIBUTING/ADD_ENGINE docs not delivered',
      )
    ) {
      return;
    }

    const docRels = [
      'README.md',
      'README.zh-CN.md',
      'CONTRIBUTING.md',
      'docs/README.md',
      'docs/guide/ADD_ENGINE.md',
    ];
    for (const rel of docRels) {
      const abs = path.join(REPO_ROOT, rel);
      const text = await readFile(abs, 'utf8');
      assert.doesNotMatch(
        text,
        /file:\/\/|\/home\/aoike|\/media\/aoike|\/Users\/(?!<[^>]+>|your[-_]?name|username|user\b|\.\.\.)[A-Za-z0-9_.-]+|[CD]:\\Users\\(?!<[^>]+>|your[-_]?name|username|user\b|\.\.\.)|[CD]:\\Code\b/i,
        `${rel} leaks local host path`,
      );
      const baseDir = path.dirname(abs);
      for (const rawTarget of extractRelativeMarkdownLinks(text)) {
        const clean = rawTarget.split('#')[0]?.split('?')[0] ?? '';
        if (!clean) continue;
        const resolved = path.resolve(baseDir, clean);
        assert.equal(existsSync(resolved), true, `Broken link "${rawTarget}" in ${rel}`);
      }
    }
  });

  it('fa10.t2.2 rejects legacy brand or R9700-only regression while retaining llm-backend & ./lab compat', async (t) => {
    const ready = await hasM6BrandAndReadmes();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #24): VramDeck unified branding across docs & UI not delivered',
      )
    ) {
      return;
    }

    const filesToCheck = [
      'README.md',
      'README.zh-CN.md',
      ...(existsSync(path.join(REPO_ROOT, 'CONTRIBUTING.md')) ? ['CONTRIBUTING.md'] : []),
      ...(existsSync(path.join(REPO_ROOT, 'docs', 'guide', 'ADD_ENGINE.md'))
        ? ['docs/guide/ADD_ENGINE.md']
        : []),
    ];
    const layoutRel = await findFirstExisting([
      'platforms/workbench/app/layout.tsx',
      'platforms/workbench/app/layout.jsx',
    ]);
    const pageRel = await findFirstExisting([
      'platforms/workbench/app/page.tsx',
      'platforms/workbench/app/page.jsx',
    ]);
    if (layoutRel) filesToCheck.push(layoutRel);
    if (pageRel) filesToCheck.push(pageRel);

    for (const rel of filesToCheck) {
      const content = await readFile(path.join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(content, /^#\s*本地 AI 工作台/m, `${rel} retains old Chinese title`);
      assert.doesNotMatch(content, /AI Workbench/, `${rel} retains AI Workbench branding`);
      assert.doesNotMatch(content, /单卡 AMD AI 工作台/, `${rel} retains single-GPU brand`);
      assert.doesNotMatch(content, /\/home\/aoike|\/media\/aoike/, `${rel} leaks local path`);
    }

    const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
    assert.match(readme, /llm-backend/);
    assert.match(readme, /\.\/lab|vramdeck/);
  });

  it('fa10.t2.3 verifies CI 3-OS safety invariants and check-project.py --suite invalid non-zero exit', async (t) => {
    const invalidSuite = await runCommand('python', [
      path.join(REPO_ROOT, '.workbench', 'scripts', 'check-project.py'),
      '--suite',
      'invalid',
    ]);
    assert.notEqual(invalidSuite.code, 0, 'check-project.py --suite invalid must exit non-zero');

    const ready = await hasM6CiEnhancements();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #27): .github/workflows/ci.yml Prettier & cycle checks not delivered',
      )
    ) {
      return;
    }

    const ciText = await readFile(path.join(REPO_ROOT, '.github', 'workflows/ci.yml'), 'utf8');
    assert.match(ciText, /fail-fast:\s*false/);
    assert.match(ciText, /WORKBENCH_NEXT_DIST:\s*\.next-ci/);

    const aptIdx = ciText.indexOf('apt-get');
    if (aptIdx >= 0) {
      const context = ciText.slice(Math.max(0, aptIdx - 160), aptIdx);
      assert.match(context, /runner\.os\s*==\s*'Linux'/);
    }
    const brewIdx = ciText.indexOf('brew install');
    if (brewIdx >= 0) {
      const context = ciText.slice(Math.max(0, brewIdx - 160), brewIdx);
      assert.match(context, /runner\.os\s*==\s*'macOS'/);
    }
    const chocoIdx = ciText.indexOf('choco install');
    if (chocoIdx >= 0) {
      const context = ciText.slice(Math.max(0, chocoIdx - 160), chocoIdx);
      assert.match(context, /runner\.os\s*==\s*'Windows'/);
    }

    const pkg = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'platforms', 'workbench', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const match of ciText.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      const scriptName = match[1];
      assert.equal(
        Object.hasOwn(scripts, scriptName),
        true,
        `ci.yml references missing workbench npm script "${scriptName}"`,
      );
    }
  });

  it('fa10.t2.4 negative hygiene checks catch synthetic non-erasable TS, unformatted code, and 3-file import cycles', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa10-t2-4-');
    t.after(() => ws.cleanup());

    const scratchDir = path.join(ws.rootDir, 'hygiene');
    await mkdir(scratchDir, { recursive: true });

    const badTsPath = path.join(scratchDir, 'bad-erasable.ts');
    await writeFile(
      badTsPath,
      [
        'export enum BadMode { Fast = 1 }',
        'export class BadBox { constructor(public value: number) {} }',
        '',
      ].join('\n'),
      'utf8',
    );
    const tsconfigBadPath = path.join(scratchDir, 'tsconfig.json');
    await writeFile(
      tsconfigBadPath,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          erasableSyntaxOnly: true,
          noEmit: true,
        },
        include: ['./bad-erasable.ts'],
      }),
      'utf8',
    );

    const nodeBin = resolveNode22Plus();
    const tscBin = path.join(
      REPO_ROOT,
      'platforms',
      'workbench',
      'node_modules',
      'typescript',
      'bin',
      'tsc',
    );
    const prettierBin = path.join(
      REPO_ROOT,
      'platforms',
      'workbench',
      'node_modules',
      'prettier',
      'bin',
      'prettier.cjs',
    );

    const tscRes = await runCommand(nodeBin, [tscBin, '--noEmit', '-p', tsconfigBadPath]);
    assert.notEqual(tscRes.code, 0, 'tsc --erasableSyntaxOnly must reject enum/param-prop');
    assert.match(
      tscRes.stdout + tscRes.stderr,
      /TS1294|erasableSyntaxOnly|enum|parameter properties/i,
    );

    const uglyTsPath = path.join(scratchDir, 'ugly.ts');
    await writeFile(uglyTsPath, 'export const   ugly =   {a:1,b:2}\n', 'utf8');
    const prettierRes = await runCommand(nodeBin, [
      prettierBin,
      '--config',
      path.join(REPO_ROOT, '.prettierrc.json'),
      '--check',
      uglyTsPath,
    ]);
    assert.notEqual(prettierRes.code, 0, 'prettier --check must reject unformatted TS');

    const cycleDir = path.join(scratchDir, 'cycles');
    await mkdir(cycleDir, { recursive: true });
    await writeFile(
      path.join(cycleDir, 'a.ts'),
      "import { b } from './b.ts'; export const a = b + 1;\n",
    );
    await writeFile(
      path.join(cycleDir, 'b.ts'),
      "import { c } from './c.ts'; export const b = c + 1;\n",
    );
    await writeFile(
      path.join(cycleDir, 'c.ts'),
      "import { a } from './a.ts'; export const c = a + 1;\n",
    );

    await assert.rejects(() => assertNoImportCycles(cycleDir), /Circular imports detected/);
  });

  it('fa10.t2.5 validates Issue/PR template metadata and ADD_ENGINE.md engine-sdk boundary rule', async (t) => {
    const ready = (await hasM6GithubTemplates()) && (await hasM6ContributorDocs());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Features #25, #26): Issue/PR templates & docs/guide/ADD_ENGINE.md not delivered',
      )
    ) {
      return;
    }

    const issueDir = path.join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE');
    const entries = await readdir(issueDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && /\.(?:ya?ml|md)$/i.test(e.name));
    assert.ok(files.length >= 1);

    for (const file of files) {
      const content = await readFile(path.join(issueDir, file.name), 'utf8');
      assert.ok(content.trim().length > 20, `${file.name} must be non-empty`);
      assert.match(content, /^name\s*:/m, `${file.name} missing name: metadata`);
      assert.match(
        content,
        /^(?:description|about)\s*:/m,
        `${file.name} missing description:/about: metadata`,
      );
    }

    const prContent = await readFile(
      path.join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'),
      'utf8',
    );
    assert.ok(prContent.trim().length > 20);
    assert.match(prContent, /- \[ \]/);

    const addEngine = await readFile(
      path.join(REPO_ROOT, 'docs', 'guide', 'ADD_ENGINE.md'),
      'utf8',
    );
    assert.match(addEngine, /engine-sdk/);
    assert.match(
      addEngine,
      /(?:never|do not|must not|prohibit|forbidden|禁止|不要).*?(?:core|llm|backend)/is,
      'ADD_ENGINE.md must prohibit direct core/llm/backend imports bypassing engine-sdk',
    );
  });

  it('fa10.t2.6 checks ci.yml lockfile/working-dir/node-version consistency and .prettierignore safety', async (t) => {
    const ready = await hasM6CiEnhancements();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M6 (Feature #27): .github/workflows/ci.yml Prettier & cycle checks not delivered',
      )
    ) {
      return;
    }

    const ciText = await readFile(path.join(REPO_ROOT, '.github', 'workflows/ci.yml'), 'utf8');
    for (const match of ciText.matchAll(/working-directory:\s*([^\s#]+)/g)) {
      const dir = path.join(REPO_ROOT, match[1]);
      assert.equal(existsSync(dir), true, `ci.yml working-directory missing: ${match[1]}`);
    }
    for (const match of ciText.matchAll(/(platforms\/[^\s]+package-lock\.json)/g)) {
      const lockPath = path.join(REPO_ROOT, match[1]);
      assert.equal(existsSync(lockPath), true, `ci.yml lockfile missing: ${match[1]}`);
    }

    const nodeVersionMatch = /node-version:\s*['"]?(\d+)/.exec(ciText);
    assert.ok(nodeVersionMatch, 'ci.yml must specify node-version');
    assert.ok(Number(nodeVersionMatch[1]) >= 22, 'ci.yml node-version must be >= 22');

    const prettierIgnore = await readFile(path.join(REPO_ROOT, '.prettierignore'), 'utf8');
    assert.match(prettierIgnore, /\.next-\*\//);
    assert.match(prettierIgnore, /node_modules\//);
    assert.match(prettierIgnore, /workspace\//);
  });
});
