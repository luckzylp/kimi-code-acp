#!/usr/bin/env node
/**
 * Guard the repository boundary: the adapter never patches the upstream
 * kimi-code source.
 *
 * Checked here:
 *   - vendor/ is disposable and untracked (a prepared tree, rebuilt from the
 *     pinned tarball by scripts/upstream.mjs);
 *   - vendor/upstream is not a git checkout, so no upstream patch can hide
 *     there;
 *   - the prepared tree matches the tag in upstream.json;
 *   - no adapter source imports a path into vendor/ (only package entry points
 *     are allowed, and type-only where possible).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

let tag;
try {
  tag = JSON.parse(readFileSync(join(repoRoot, 'upstream.json'), 'utf8')).tag;
} catch (error) {
  failures.push(`upstream.json is unreadable: ${error.message}`);
}

let tracked = '';
try {
  tracked = execFileSync('git', ['ls-files', 'vendor'], { cwd: repoRoot, encoding: 'utf8' });
} catch {
  process.stderr.write('[boundary] git is unavailable; skipping the tracked-files check\n');
}
check(tracked.trim().length === 0, 'vendor/ has tracked files; it must stay disposable');

check(!existsSync(join(repoRoot, 'vendor', 'upstream', '.git')), 'vendor/upstream is a git checkout');

const packageJsonCandidates = [
  join(repoRoot, 'vendor', 'upstream', 'apps', 'kimi-code', 'package.json'),
  join(repoRoot, 'vendor', 'upstream', 'packages', 'kimi-code', 'package.json'),
];
const packageJson = packageJsonCandidates.find((path) => existsSync(path));
if (tag !== undefined && packageJson !== undefined) {
  const version = JSON.parse(readFileSync(packageJson, 'utf8')).version;
  check(
    typeof tag === 'string' && tag.endsWith(`@${version}`),
    `vendor kimi-code is ${String(version)}, pinned tag is ${String(tag)}`,
  );
}

const sourceDir = join(repoRoot, 'packages', 'kimi-acp', 'src');
const files = execFileSync('git', ['ls-files', 'packages/kimi-acp/src'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.length > 0);
for (const file of files) {
  const text = readFileSync(join(repoRoot, file), 'utf8');
  for (const match of text.matchAll(/from\s+'([^']*vendor\/[^']*)'/g)) {
    failures.push(`${file} imports ${match[1]} (relative vendor path)`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`[boundary] FAIL ${failure}\n`);
  process.exit(1);
}
process.stderr.write(
  `[boundary] ok: ${String(tag)} prepared in vendor/upstream (untracked), ${files.length} adapter sources import no vendor path\n`,
);
