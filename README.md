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

**M0 — walking skeleton, verified end to end.** Present today:

- `initialize`, `session/new`, `session/prompt`, `session/cancel`
- the **run** model: a prompt settles at quiescence (session idle, or a 2 s
  grace after the turn), not at `turn.ended`, so continuation turns stay
  inside the client's prompt
- coalesced `agent_message_chunk` / `agent_thought_chunk` streaming with one
  `messageId` per message, through a single ordered outbox
- client capability negotiation (`terminal_output`, `terminal_output_delta`),
  read once and ready for the terminal mirror

M1 adds tool projection and display terminals, M2 sessions/load/replay and the
goal/swarm projections — see the ADR's projection table.

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
node scripts/e2e.mjs        # prompt -> engine turn -> stream -> end_turn, and cancel
```

`npm run verify` runs typecheck, build, smoke and e2e in order.

Point Zed at `packages/kimi-acp/dist/main.mjs` as a custom agent command
(`node <absolute path>`), or package it as an npx cache bundle the way the
patch repository does.

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
scripts/upstream.mjs     fetch + install the pinned upstream tag
scripts/workspace.mjs    copy the adapter into the upstream workspace, collect the bundle
scripts/toolchain.mjs    resolve the pinned node/pnpm
scripts/smoke.mjs        handshake smoke
scripts/e2e.mjs          turn + cancel end-to-end against a fake provider
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
