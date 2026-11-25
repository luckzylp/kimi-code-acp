# kimi-acp

An independent [ACP](https://agentclientprotocol.com) agent for `@moonshot-ai/kimi-code`,
built on the upstream SDK at a **pinned tag** — no patches and no fork of their `acp` mode.

Design: [`docs/adr/0001-run-model-and-projection.md`](docs/adr/0001-run-model-and-projection.md).

## Why not the built-in `acp` mode

Its session maps one `session/prompt` to one engine turn and drops the events of
turns no prompt owns, so goal continuations, swarm members and late background
notifications run dark. Fixing that inside their file lands in the same
functions that already carry eight local patches. See the ADR's alternatives.

## Status

**M2 — usable ACP agent with sessions and the client's session surface,
verified end to end.** Present today:

- `initialize`, `session/new`, `session/load`, `session/resume`,
  `session/fork`, `session/list`, `session/delete`, `session/close`,
  `session/prompt`, `session/cancel`
- **history replay** on load: the persisted context becomes the same updates a
  live turn produces, with injected reminders (`<system-reminder>`,
  `<task-notification>`) stripped and engine-started turns introduced by the
  same one-line note they get live
- **session surface**: model / thinking / mode config options,
  `session/set_config_option`, `session/set_mode`, skills advertised as slash
  commands, `usage_update` after setup and each turn, and
  `session_info_update` from generated titles
- **prompt content**: text, images (attached to the engine's media store),
  `resource_link` files read on the host and inlined, and embedded resources
- **cancellation everywhere**: a run, and a permission dialog left open when the
  client cancels, both settle as `cancelled`
- **login**: `kimi-acp login` runs the device-code flow in a terminal and is
  advertised as ACP's `terminal` auth method, so a client can start it from its
  sign-in UI; `authenticate` / `logout` are handled too
- the **run** model: a prompt settles at quiescence (session idle, or a 2 s
  grace after the turn), not at `turn.ended`, so continuation turns stay
  inside the client's prompt
- coalesced `agent_message_chunk` / `agent_thought_chunk` streaming with one
  `messageId` per message, through a single ordered outbox
- **tool cards**: title/kind/status, `rawInput`/`rawOutput`, diff content,
  locations for readable files, streamed argument updates
- **shadow terminals**: the engine runs the command; the client creates a
  display terminal from `_meta.terminal_info` and receives
  `_meta.terminal_output` chunks and `_meta.terminal_exit`. No `terminal/*`
  reverse RPC exists, so a dropped client terminal cannot pin a turn
- **permissions**: `session/request_permission` with approve-once /
  approve-for-session / reject, mapped onto the engine's approval handler
- **elicitation**: questions become `elicitation/create` forms when the client
  supports them, and a choice-style permission request otherwise
- client capability negotiation (`terminal_output`, `terminal_output_delta`,
  `elicitation.form`, `fs.*`), read once at `initialize`

M4 adds client-supplied MCP servers (not exposed by the SDK today — see the
ADR) and the goal/swarm projections; both are recorded in the ADR's projection
table.

## Prerequisites

- **node >= 24.15.0** (the upstream `engines.node`). The scripts pick a suitable
  fnm node automatically when the shell's node is too old.
- **pnpm 10.33.0** (the upstream `packageManager`). Taken from the corepack
  cache when present, otherwise `pnpm` on PATH.
- Network on the first run (the tag tarball and the dependency store).

## Commands

```sh
node scripts/upstream.mjs   # fetch the pinned tag into vendor/upstream and install
node scripts/typecheck.mjs  # type-check the adapter inside the upstream workspace
node scripts/build.mjs      # build dist/main.mjs and copy it back
node scripts/smoke.mjs      # ACP handshake + session/new against the real engine
node scripts/e2e.mjs        # turn, stream, cancel, tool card, shadow terminal
node scripts/pack.mjs       # tarball + install tree, verified by handshake
```

Signing in, once the bundle is installed:

```sh
node packages/kimi-acp/dist/main.mjs login   # device-code flow in this terminal
```

`npm run verify` runs typecheck, build, smoke and e2e in order.

## Installable artifact

`node scripts/pack.mjs` produces what a client installs:

```
build/moonshot-ai-kimi-code-acp-0.1.0.tgz     the publishable tarball
build/npx-cache/npx/kimi-acp/
  package.json                                pins @moonshot-ai/kimi-code-acp
  package-lock.json
  node_modules/@moonshot-ai/kimi-code-acp/    dist/main.mjs
  node_modules/.bin/kimi-acp                  the shim Zed runs
```

That directory is the same shape as the npx cache Zed keeps for an agent, so it
can be dropped into a registry cache as-is. The bundle is **self-contained** —
the engine and the SDK are compiled into `dist/main.mjs` — so `node_modules`
holds only `@moonshot-ai/kimi-code-acp`: there is nothing to resolve at run
time, and no transitive tree to audit.

Point Zed at the installed bin (or at `packages/kimi-acp/dist/main.mjs`) as a
custom agent command: `node <absolute path>`.

A warm pnpm store cuts a cold install from tens of minutes to seconds:

```sh
KIMI_PNPM_STORE_DIR=/path/to/store node scripts/upstream.mjs
```

## Layout

```
packages/kimi-acp/       the adapter — the only source in this repository
  src/agent.ts           ACP surface: initialize, session/new, prompt, cancel
  src/session.ts         run model + streaming + outbox
  src/coalesce.ts        text coalescing
  src/outbox.ts          one ordered FIFO per session, no per-update timeouts
  src/capabilities.ts    what the client said it can render
  src/tool-calls.ts      tool cards, diff/locations, shadow terminals
scripts/upstream.mjs     fetch + install the pinned upstream tag
scripts/workspace.mjs    copy the adapter into the upstream workspace, collect the bundle
scripts/toolchain.mjs    resolve the pinned node/pnpm
scripts/pack.mjs         tarball + npx-cache install tree, verified by handshake
scripts/smoke.mjs        handshake smoke
scripts/e2e.mjs          turn, cancel, tool card, shadow terminal end-to-end
scripts/lib/             ACP stdio client, fake provider, throwaway home
upstream.json            the tag pin
```

## How the build works

`packages/kimi-acp` depends on `@moonshot-ai/kimi-code-sdk`, which is
`private: true` in the monorepo and cannot be installed from npm. So the
adapter is compiled **inside the upstream workspace**, against the tag in
`upstream.json`:

1. `scripts/upstream.mjs` extracts the tag into `vendor/upstream` (gitignored)
   and installs it with its own lockfile.
2. `scripts/build.mjs` copies the adapter into
   `vendor/upstream/packages/kimi-acp` — pnpm does not accept a **symlinked**
   directory as a workspace package — installs so the workspace links the SDK,
   runs `tsdown`, and copies `dist/` back.

Nothing of the upstream source is committed: the tag is the only pin, and the
adapter is the only source.