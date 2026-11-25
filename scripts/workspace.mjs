/**
 * The adapter is compiled inside the upstream workspace, because that is where
 * its dependency (`@moonshot-ai/kimi-code-sdk`) exists. pnpm does not accept a
 * symlinked directory as a workspace package, so the source is copied in:
 *
 *   packages/kimi-acp  →  vendor/upstream/packages/kimi-acp   (disposable)
 *
 * The copy is refreshed on every build, and its `dist/` is copied back, so the
 * repository never holds a second copy of the source.
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { pnpmStoreArgs, runPnpm } from './toolchain.mjs';

/** Files that belong to the adapter package, relative to its root. */
const PACKAGE_ENTRIES = ['package.json', 'tsconfig.json', 'tsdown.config.ts', 'src'];

export function workspaceAdapterDir(repoRoot) {
  return join(repoRoot, 'vendor', 'upstream', 'packages', 'kimi-acp');
}

/**
 * Copy the adapter into the upstream workspace and install, so the workspace
 * resolves its dependencies. Returns the copy's directory.
 */
export function prepareWorkspaceAdapter({ repoRoot, upstreamDir, toolchain }) {
  const source = join(repoRoot, 'packages', 'kimi-acp');
  const target = workspaceAdapterDir(repoRoot);
  rmSync(target, { recursive: true, force: true });
  for (const entry of PACKAGE_ENTRIES) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, entry), { recursive: true });
  }
  // The workspace gained a package: its importer must enter the lockfile, and
  // the SDK has to be linked into the copy.
  runPnpm(toolchain, ['install', ...pnpmStoreArgs()], { cwd: upstreamDir });
  return target;
}

/** Copy the built bundle back into the repository. */
export function collectBundle({ repoRoot }) {
  const from = join(workspaceAdapterDir(repoRoot), 'dist');
  const to = join(repoRoot, 'packages', 'kimi-acp', 'dist');
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  const main = join(to, 'main.mjs');
  const bytes = statSync(main).size;
  return { dir: to, main, bytes, files: readdirSync(to).length };
}
