import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

/**
 * One self-contained bundle: everything the agent needs at runtime is either
 * bundled or a Node built-in. The engine reads a number of `.md` prompts with
 * `?raw` imports, so the upstream raw-text plugin is part of the build — the
 * same plugin the upstream apps and SDKs use.
 *
 * The adapter is compiled inside the upstream workspace (see
 * `scripts/workspace.mjs`), which is where `build/raw-text-plugin.mjs` lives.
 */
export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  hash: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^@moonshot-ai\//, /^@agentclientprotocol\//],
    neverBundle: [],
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.mjs',
  },
});
