# ADR 0001 — Own ACP adapter, run model, and projection rules

- **Status**: accepted; M0, M1, M2 and prompt content landed
- **Verified**: M0 chain (tag → workspace → single-file bundle → engine session
  → turn → coalesced stream → cancel) — see [Verification](#verification)
- **Date**: 2026-11-25
- **Supersedes**: nothing. The patch set in `kimi-code-acp-patched` stays as the
  interim shipping path until this adapter reaches parity.

## Context

`@moonshot-ai/kimi-code` ships an `acp` mode. It works for a single prompt
turn, and it took nine patches to make it survivable in Zed: coalescing,
terminal release ordering, terminal teardown, titles, usage, tool locations,
update-chain timeouts, engine-started turns. Eight of those nine patches touch
one upstream file, `packages/acp-server/src/session.ts`.

The next features we need are structurally hostile to that design:

- **Goal** is a self-driving chain of turns. `features/goal/goalService.ts`
  submits a fresh `system_trigger` prompt (`goal_continuation`) every time the
  loop goes idle, for hours, until the goal completes, is paused, or hits a
  budget.
- **Swarm** launches N child agents from one `AgentSwarm` tool call, each with
  its own agent scope.
- **Long-running commands** already exist as background tasks with
  completion notifications.

All three need *one client request that spans many engine turns*, which the
upstream session cannot express: it maps one `session/prompt` to one turn and
drops events of turns no prompt owns.

ACP v1 gives clients only thirteen update kinds (`user_message_chunk`,
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
`plan`, `plan_update`\*, `plan_removed`\*, `available_commands_update`,
`current_mode_update`, `config_option_update`, `session_info_update`,
`usage_update`) — no notice, no status, no background list. `_meta` is only
renderable through keys the client knows (`terminal_info`, `terminal_output`,
`terminal_exit`, which Zed advertises and consumes since 1.29). Anything about
goals, swarms or background work therefore has to be projected onto an entity
the client already renders.

The adapter is Apache/MIT-adjacent work we can own: `kimi-code` is MIT, its
`packages/acp-server` is proven mapping code we may copy. The SDK is
`private: true` and its published-ready bundle leaves `ajv`, `@google/genai`,
`@modelcontextprotocol/sdk`, `@noble/hashes` undeclared, so the only workable
dependency is the monorepo source at a pinned tag.

## Decision 1 — Own the adapter, built against a pinned upstream tag

`kimi-acp` is a new repository. Its source is our own; it is compiled *inside*
the upstream workspace:

```
node scripts/upstream.mjs            # pinned tag → vendor/upstream (gitignored), installed
node scripts/build.mjs
  ├─ copy packages/kimi-acp → vendor/upstream/packages/kimi-acp
  ├─ pnpm install (the workspace links @moonshot-ai/kimi-code-sdk)
  └─ tsdown → dist/main.mjs, copied back to packages/kimi-acp/dist/
```

No patches, no vendored copy of their code in git: the adapter is source, the
upstream tree is a build input, and the tag is the only pin. The copy is
disposable because pnpm does not treat a symlinked directory as a workspace
package; a build therefore refreshes it instead of linking it.

## Decision 2 — A client prompt is a *run*, not a turn

A **run** is one `session/prompt` request. It ends when the engine has no work
left for it, not when a turn ends. Quiescence is `loop.idle` (no pending
requests, no foreground work); a run only settles after it, or after a short
grace window with no further turn, so a goal continuation or a task
notification that arrives immediately after a turn folds into the same run.

```
                     session/prompt
        ┌──────────┐  ──────────────►  ┌────────────┐  engine accepts
        │   Idle   │                   │ Launching  │ ───────────────┐
        └──────────┘                   └────────────┘                │
             ▲                                                       ▼
             │                                          ┌────────────────────┐
             │                                          │  Running(turn N)   │
             │                                          └────────────────────┘
             │                                             │            ▲
             │                          turn.ended(*)      │            │ turn.started(origin ∈ run)
             │                          ───────────────►  ┌────────────┴───┐ │
             │                                          │   Quiescing    │─┘
             │   resolve({stopReason})                  └────────────────┘
             └───────────────  Settled  ◄───────────────┬─────────────────┘
                                                          │ loop.idle, or grace expired
                                                          │ turn.ended(failed|cancelled)
                                                          ▼
                                                   Settled immediately
```

Rules:

1. `turn.ended(completed)` starts **Quiescing**, it does not resolve. A
   `turn.started` inside the grace window returns to **Running** with the same
   run (`goal_continuation`, `task`, `cron_job`, `system_trigger` origins).
2. `turn.ended(failed)` → resolve `end_turn` (auth errors → JSON-RPC error);
   `turn.ended(cancelled)` → resolve `cancelled`. Never wait for quiescence.
3. Quiescence = `loop.idle` for the agent, or `QUIESCE_GRACE_MS` (2 s) with no
   new turn — whichever comes first. A stuck loop cannot pin a prompt.
4. A turn with **no live run** (a notification arriving minutes after the last
   run settled) streams normally and is introduced by one
   `user_message_chunk` note derived from its origin. This is the only case
   that gets a note; continuation turns inside a run get none, or a goal that
   runs 200 continuation turns would post 200 "the agent continued" lines.
5. `session/cancel` cancels the run: for a goal run it pauses the goal first
   (otherwise the engine relaunches a continuation on the next idle), then
   `session.cancel()`. One `session/prompt`, exactly one response.

## Decision 3 — Executions belong to the agent; the client renders a mirror

All commands run in-process through the engine. Zed gets a **display terminal**
through the v1 `_meta` channel that codex-acp uses and Zed consumes:

| Where | Key | Payload |
| --- | --- | --- |
| `tool_call._meta` | `terminal_info` | `{ terminal_id, cwd }` |
| `tool_call_update._meta` | `terminal_output` | `{ terminal_id, data }` (append chunks) |
| `tool_call_update._meta` | `terminal_exit` | `{ terminal_id, exit_code, signal }` |

Gated on `initialize.clientCapabilities._meta.terminal_output === true`
(`terminal_output_delta` when the client appends). Degradation: accumulate
locally and send one `tool_call_update` at the end — never re-send the whole
buffer per chunk (O(N²); codex-acp broke on it, issue #225).

Consequences: `terminal/create|output|wait_for_exit|kill|release` never appear
on the wire, so the whole failure class we patched cannot occur. Cost, in v1
only: an agent-owned terminal has no card-level Stop (that is `terminal/cancel`
in ACP v2); stopping is `session/cancel` or the model's `TaskStop`.

## Decision 4 — Projection table

One row per engine signal. "Entity" is what the client renders.

| Engine signal | ACP update | Entity in Zed | Notes |
| --- | --- | --- | --- |
| `assistant.delta` | `agent_message_chunk` | assistant text | stable `messageId` per message, 32-char/100 ms coalescing |
| `thinking.delta` | `agent_thought_chunk` | thought block | same coalescing; whitespace-only deltas dropped |
| `tool.call.started` | `tool_call` | tool card | title from the tool, `kind`, `rawInput`, `locations` (readable files only) |
| `tool.call.delta` | `tool_call_update` | tool card | argument growth ≥ 32 chars or ≥ 120 ms; short deltas fold into the upgrade |
| `tool.updated` | `tool_call_update` | tool card | status only |
| command stdout (Bash/`AgentSwarm` member) | `tool_call_update._meta.terminal_output` | terminal pane in the card | display mirror, see Decision 3 |
| `tool.result` | `tool_call_update` | tool card | `completed`/`failed`, preview content, restores any liveness title |
| background task lifecycle | synthetic `task_<id>` card | tool card | kept `in_progress` until the task ends, display terminal when it produces output |
| `TodoList` display block | `plan` | todo list | objective steps for a goal ride here |
| goal state (`goal.updated`, `getGoal()`) | synthetic `goal_<id>` card + `plan` | tool card + todo list | card content: objective, status, turns, tokens, budget remaining, terminal reason |
| `swarm_mode.enter/exit` | `current_mode_update` | mode picker | swarm is a mode from the client's point of view |
| swarm member turn | synthetic `swarm_<member>` card | tool card | `parentToolCallId` links it to the `AgentSwarm` call; v2 subagents when the client advertises them |
| `usage.*` | `usage_update` | context indicator | on setup, model switch, after compaction, and at run end |
| `metadata.changed` / generated title | `session_info_update` | thread title | deduplicated |
| compaction events | `agent_message_chunk` | system line | as upstream does |
| run settled without a client prompt | `user_message_chunk` note | user bubble | only for turns outside any run (Decision 2.4) |
| any of the above with rich state | `_meta` on the same update | *invisible* | namespace `kimi.*`; never the only carrier of information a user needs |

## Decision 5 — One ordered outbox, no per-update timeouts

All updates for a session go through a single FIFO chain. There is no
per-message deadline: an update is cheap once the volume is bounded by the
coalescing rules in Decision 4, and dropping updates is what made the patched
adapter lie about its own state. A write failure is logged and loses that one
update, never the chain.

## Consequences

Positive:

- Goal, swarm and long-running work are expressible, because a run outlives a
  turn and continuation turns are invisible bookkeeping.
- No reverse-RPC terminals, no release ordering, no exit-status polling, no
  timer kills: ~600 lines of patch complexity do not exist here.
- Upstream bumps move a tag, not a patch stack; nothing of theirs is ours to
  merge.

Negative:

- We own parity work the upstream adapter already has: auth, MCP-over-ACP,
  skills and slash commands, session list/load/fork/delete, replay,
  permissions, elicitation, config options.
- ACP v1 has no per-card Stop for agent-owned terminals, and no way to say
  "the agent is busy" other than a live `session/prompt` (we keep one live for
  the whole run, which is exactly the intent).
- Goal/swarm state has no first-class ACP entity; it is projected onto tool
  cards and the plan list. If the client ever grows a real surface, the
  projection module changes, nothing else.

Risks:

- The SDK is 0.x; pin the tag and run the contract check in CI.
- Native assets (tree-sitter, minidb, ripgrep) must ship beside the bundle.
- Headless auth: device-code OAuth through `authenticate`, or API-key config.

## Known limitations

- **Client MCP servers** (`session/new.mcpServers`): the SDK's
  `CreateSessionOptions` exposes no session-scoped MCP list, and
  `harness.addMcpServer` writes the user's global config. The adapter logs and
  ignores them rather than mutating configuration; the engine's own MCP config
  still applies.
- **`authenticate`**: no auth methods are advertised yet, so a user signs in
  with the `kimi` CLI first (API key or OAuth) and the adapter picks the
  configured model up.
- **Goal / swarm projections** are designed (Decision 4) but not implemented.

## Alternatives rejected

- **Keep patching `packages/acp-server`.** Every new feature lands in the same
  file that already carries eight patches; a run model would require rewriting
  `driveLaunch`/`onTurnEnded`/`settleDriver`/`cancel` underneath them.
- **Depend on the published SDK.** It is `private: true`, and its dist leaves
  four runtime packages undeclared; an installed tarball cannot resolve them.
- **Speak to the engine over its socket/RPC surface.** Same coupling as the
  SDK with more moving parts; the SDK is the supported entry point.
- **ACP v2.** Zed gates it behind `acp-beta` and it is not stable; v1 plus
  `_meta` covers everything above. Revisit when v2 leaves the flag.

## Verification

M0 was validated on 2026-11-25 against `@moonshot-ai/kimi-code@2.7.3`:

| Step | Command | Result |
| --- | --- | --- |
| fetch + install the tag | `node scripts/upstream.mjs` | pristine `--frozen-lockfile` install, 34 workspace projects |
| type-check | `node scripts/typecheck.mjs` | clean (extends the upstream tsconfig, so decorators and `?raw` types resolve) |
| bundle | `node scripts/build.mjs` | one `dist/main.mjs`, 12.2 MB, raw-text plugin applied |
| handshake | `node scripts/smoke.mjs` | `--version`, `initialize` → 1, real `session/new`, clean shutdown |
| turn | `node scripts/e2e.mjs` | coalesced stream (one chunk, one `messageId`), `end_turn`, one model request |
| cancel | `node scripts/e2e.mjs` | mid-turn `session/cancel` → `cancelled` |
| tool card | `node scripts/e2e.mjs` | `tool_call` with `_meta.terminal_info`, permission request answered |
| shadow terminal | `node scripts/e2e.mjs` | `_meta.terminal_output` carries the command's output, `terminal_exit` = 0 |
| session lifecycle | `node scripts/e2e.mjs` | `session/fork` returns a working session, `session/delete` removes it from `session/list` |
| session surface | `node scripts/e2e.mjs` | model/thinking/mode options, `set_mode` (plan on/off), `set_config_option`, commands, usage |
| load + replay | `node scripts/e2e.mjs` | second process loads the session, replays prompt/reply/tool card without injected context, accepts a new prompt |
| prompt content | `node scripts/e2e.mjs` | an image reaches the model request as a data URL, a linked markdown file is inlined |
| cancel in a dialog | `node scripts/e2e.mjs` | cancelling with an open permission request settles the run as `cancelled` |
| install tree | `node scripts/pack.mjs` | 2.6 MB tarball, installed `node_modules` + lockfile, handshake from the installed copy |

Implementation notes worth keeping:

- The adapter's tsconfig **extends the upstream root tsconfig** and includes
  `packages/agent-core-v2/src/env.d.ts`; without them the engine sources fail to
  type-check (`experimentalDecorators`, `*?raw` modules).
- The bundle needs the upstream `build/raw-text-plugin.mjs`: the engine loads
  many `.md` prompts through `?raw` imports.
- `@moonshot-ai/kimi-code-sdk` is `private: true` and its published bundle
  leaves runtime packages undeclared, so the pinned-tag workspace build is the
  only supported dependency.