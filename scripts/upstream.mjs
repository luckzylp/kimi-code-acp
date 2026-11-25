#!/usr/bin/env node
/**
 * Fetch the pinned upstream tag and install it.
 *
 * The adapter depends on `@moonshot-ai/kimi-code-sdk`, which is `private: true`
 * in the monorepo and whose bundle leaves runtime packages undeclared, so it
 * cannot be installed from npm. The supported shape is to build inside the
 * upstream workspace at a pinned tag — exactly what this script prepares:
 *
 *   vendor/upstream/     the extracted tag (never committed)
 *
 * The adapter is not linked into that tree: pnpm does not treat a symlinked
 * directory as a workspace package, so `scripts/build.mjs` copies the adapter
 * into `vendor/upstream/packages/kimi-acp` for the duration of a build.
 *
 * Idempotent: a prepared tree is only re-checked unless `--force` is given.
 *
 *   node scripts/upstream.mjs [--tag @moonshot-ai/kimi-code@2.7.3] [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureToolchain, pnpmStoreArgs, runPnpm } from './toolchain.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(repoRoot, 'vendor');
const upstreamDir = join(vendorDir, 'upstream');
const markerPath = join(vendorDir, 'upstream-tag.txt');
const tarballPath = join(vendorDir, 'upstream.tar.gz');

const UPSTREAM_REPO = process.env['UPSTREAM_REPO'] ?? 'MoonshotAI/kimi-code';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const forced = process.argv.includes('--force');
const pinned = JSON.parse(readFileSync(join(repoRoot, 'upstream.json'), 'utf8')).tag;
const tag = arg('tag', process.env['UPSTREAM_TAG'] ?? pinned);

function log(message) {
  process.stderr.write(`[upstream] ${message}\n`);
}

/** The tarball URL for a tag, encoded the way the GitHub API expects. */
function tarballUrl() {
  return `https://api.github.com/repos/${UPSTREAM_REPO}/tarball/${encodeURIComponent(tag)}`;
}

function markerMatches() {
  if (!existsSync(markerPath) || !existsSync(join(upstreamDir, 'package.json'))) return false;
  return readFileSync(markerPath, 'utf8').trim() === tag;
}

function installed() {
  return existsSync(join(upstreamDir, 'node_modules', '.modules.yaml'));
}

function fetchTag() {
  log(`fetching ${tarballUrl()}`);
  execFileSync('curl', ['-fsSL', '--retry', '5', '--retry-delay', '2', tarballUrl(), '-o', tarballPath], {
    stdio: 'inherit',
  });
  rmSync(upstreamDir, { recursive: true, force: true });
  mkdirSync(upstreamDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', upstreamDir, '--strip-components=1'], { stdio: 'inherit' });
  rmSync(tarballPath, { force: true });
  writeFileSync(markerPath, `${tag}\n`);
}

function main() {
  mkdirSync(vendorDir, { recursive: true });

  // Fetch first: the node floor and the pnpm pin live in the upstream
  // package.json, which only exists once the tag is extracted.
  if (forced || !markerMatches()) {
    log(`preparing upstream ${tag}`);
    fetchTag();
  } else {
    log(`${tag} already present in vendor/upstream`);
  }

  const toolchain = configureToolchain(upstreamDir);
  log(`pnpm ${toolchain.pnpm.version ?? 'unknown'} (${toolchain.pnpm.source}), node ${toolchain.nodeVersion}`);

  if (forced || !installed()) {
    // The pristine tag must install as shipped.
    runPnpm(toolchain, ['install', '--frozen-lockfile', ...pnpmStoreArgs()], { cwd: upstreamDir });
  } else {
    log('dependencies already installed');
  }
  log(`ready: vendor/upstream @ ${tag}`);
}

main();
