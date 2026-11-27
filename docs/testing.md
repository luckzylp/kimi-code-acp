# Testing the adapter

Three layers, all reproducible from a clean checkout after `node scripts/upstream.mjs`:

| Layer | Command | What it proves |
|---|---|---|
| unit (vitest) | `node scripts/test.mjs` | pure projections: run model, tool cards, replay, commands, v2 translation, wire-contract shapes |
| end-to-end | `node scripts/e2e.mjs` | one real agent process per scenario: handshake, terminals, permissions, MCP, steering, config, v2 |
| protocol suite | `node scripts/protocol-suite.mjs [filter]` | the full ACP surface against a real engine and a fake provider, as Zed and AIR send it |

`npm run verify` runs typecheck → unit → build → smoke → e2e → protocol suite → pack.

## The protocol suite

Each case starts a fresh agent (fake `KIMI_CODE_HOME` with one OpenAI-protocol
model pointed at a fake provider), drives it over stdio JSON-RPC, and asserts
the notifications and responses. A filter is a regular expression matched
against the case name:

```sh
node scripts/protocol-suite.mjs 'rewind'
node scripts/protocol-suite.mjs 'v2'
```

The cases are grouped in `scripts/protocol-suite.mjs` by area (handshake,
session lifecycle, prompt, permissions, terminals, MCP, goal, cursors/rewind,
notices/compaction, AIR extensions, config/modes, commands, v2, transport
robustness). Current count: **89 cases**.

Expected values are derived from the ACP v1/v2 schemas (the emitted payloads
are parsed with the SDK's zod schemas in the contract tests) and from Zed
1.29.3's client code, documented with source references in
`docs/zed-acp-behavior.md`.

## Triage

A failing case is one of two things:

1. **The adapter is wrong.** Fix the implementation, rebuild, rerun the case,
   then the whole suite.
2. **The assertion is wrong.** Only when the protocol or the client's contract
   says otherwise — Zed's source and the SDK schema are the reference. Record
   the reason in the commit message (for example: the engine answers
   approve-for-session per approval rule, so the case repeats the same
   command; a malformed MCP server is rejected by the schema, so the case
   expects a rejection and a *valid but failing* server for the tolerance
   path).

Never weaken an assertion to make a case pass.

## Known gaps

- `authenticate` with the login method opens a device flow in a terminal and
  needs the network; only the unknown-method path and `logout` are covered.
- Plugin commands are covered at the adapter boundary (unit test of
  `pluginSlashCommands`); end-to-end discovery through the engine's plugin
  registry is not, because installing a plugin exercises the engine's installer
  rather than the adapter.
- The AIR archive/unarchive, native subagent sessions and exact-git-patch diff
  forms are not implemented (see `docs/protocol-coverage.md`).