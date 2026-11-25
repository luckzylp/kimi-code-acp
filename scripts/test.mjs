#!/usr/bin/env node
/** Run the adapter's unit tests inside the upstream workspace (it owns vitest). */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureToolchain, runPnpm } from './toolchain.mjs';
import { prepareWorkspaceAdapter } from './workspace.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamDir = join(repoRoot, 'vendor', 'upstream');

if (!existsSync(join(upstreamDir, 'package.json'))) {
  process.stderr.write('[test] vendor/upstream is not prepared — run `node scripts/upstream.mjs`\n');
  process.exit(1);
}

const toolchain = configureToolchain(upstreamDir);
prepareWorkspaceAdapter({ repoRoot, upstreamDir, toolchain });
runPnpm(toolchain, ['--filter', 'kimi-acp', 'run', 'test'], { cwd: upstreamDir });
