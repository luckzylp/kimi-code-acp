#!/usr/bin/env node
/**
 * Build the adapter and copy the bundle back into this repository.
 *
 *   node scripts/upstream.mjs   # once per tag
 *   node scripts/build.mjs      # every time the adapter changes
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureToolchain, runPnpm } from './toolchain.mjs';
import { collectBundle, prepareWorkspaceAdapter } from './workspace.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamDir = join(repoRoot, 'vendor', 'upstream');

if (!existsSync(join(upstreamDir, 'package.json'))) {
  process.stderr.write('[build] vendor/upstream is not prepared — run `node scripts/upstream.mjs`\n');
  process.exit(1);
}

const toolchain = configureToolchain(upstreamDir);
process.stderr.write(`[build] node ${toolchain.nodeVersion}, pnpm ${toolchain.pnpm.version ?? 'unknown'} (${toolchain.pnpm.source})\n`);

prepareWorkspaceAdapter({ repoRoot, upstreamDir, toolchain });
runPnpm(toolchain, ['--filter', 'kimi-acp', 'run', 'build'], { cwd: upstreamDir });

const bundle = collectBundle({ repoRoot });
process.stderr.write(`[build] bundle: ${bundle.main} (${bundle.files} file(s), ${(bundle.bytes / 1024 / 1024).toFixed(1)} MiB)\n`);
