import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('Cross-platform installers exist, enforce Node >= 22.19, and avoid hardcoded host paths', async () => {
  const shPath = path.join(repoRoot, 'scripts', 'install.sh');
  const ps1Path = path.join(repoRoot, 'scripts', 'install.ps1');
  assert.equal(existsSync(shPath), true);
  assert.equal(existsSync(ps1Path), true);

  const shSrc = await readFile(shPath, 'utf8');
  assert.equal(shSrc.includes('\r\n'), false, 'scripts/install.sh must use LF endings');
  assert.match(shSrc, /VramDeck/);
  assert.match(shSrc, /22\.19/);
  assert.match(shSrc, /Linux/);
  assert.match(shSrc, /Darwin/);
  assert.doesNotMatch(shSrc, /\/home\/aoike|\/media\/aoike/);

  const ps1Src = await readFile(ps1Path, 'utf8');
  assert.match(ps1Src, /VramDeck/);
  assert.match(ps1Src, /22\.19/);
  assert.match(ps1Src, /platforms\\workbench/);
  assert.doesNotMatch(ps1Src, /\/home\/aoike|\/media\/aoike/);
});
