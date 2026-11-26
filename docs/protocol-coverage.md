# ACP protocol coverage

Audit of the adapter against the ACP schemas shipped with
`@agentclientprotocol/sdk@2.12.0` (v1 uses its `unstable` surface,
`schema/v1/schema.unstable.json`; v2 is pinned to the 1.3.0 draft through the
`@agentclientprotocol/sdk-v1` npm alias), as of
`@moonshot-ai/kimi-code-acp@0.14.0` on `@moonshot-ai/kimi-code@2.8.1`.

Legend: **implemented** — advertised and handled; **not used** — the client
capability exists, but this agent intentionally does not use it; **not
advertised** — the capability flag is never set, so a client does not call it;
**blocked** — the engine/SDK offers no seam.

## Agent methods

| Method | Status | Where |
| --- | --- | --- |
| `initialize` | implemented | `src/agent.ts` — protocol v1, `loadSession: true`, prompt capabilities (image, embedded context), terminal `login` auth method |
| `authenticate` | implemented | `src/auth.ts` — device-code flow; unknown method ids are rejected |
| `logout` | implemented | `src/agent.ts` |
| `providers/list`, `providers/set`, `providers/disable` | list implemented, mutation rejected | v1 **and** v2 serve `providers/list` from the engine's config; set/disable answer `invalidParams` because the engine exposes no safe live provider write |
| `session/new` | implemented | `src/agent.ts` — `additionalDirectories`; `mcpServers` become session-local engine servers whose tools reach the model |
| `session/load` | implemented | resume + replay in `src/replay.ts`; `mcpServers` are connected before the resumed session starts |
| `session/resume` | implemented | bind without replay; `mcpServers` honoured
| `session/fork` | implemented | `harness.forkSession`; `mcpServers` honoured
| `session/list` | implemented | `harness.listSessions` |
| `session/delete` | implemented | `harness.deleteSession` |
| `session/close` | implemented | disposes the bridge |
| `session/set_mode` | implemented | default / plan / auto / yolo → planMode + permission |
| `session/set_config_option` | implemented | model, thinking, mode |
| `session/prompt` | implemented | run model, text/image/resource blocks |
| `session/cancel` | implemented | cancels the run, including a pending permission dialog |
| `$/cancel_request` | implemented | the SDK aborts the request signal; the handler cancels the run |
| `_session/steering` (extension) | implemented | injects into the running turn; `startedNewTurn` when idle; `promptRequired` opt-in; advertised via `initialize._meta.steering` |
| `_session/goal` (AIR extension) | implemented | `set` creates/replaces the engine goal, `clear` cancels it and closes the goal card; served on v1 and v2 |
| `nes/start`, `nes/suggest`, `nes/close` | not advertised | next-edit suggestions are not a chat agent feature |

## ACP v2 (experimental draft)

One connection, both versions: `agentProtocolRouter` reads `initialize` and
opens the v1 or the v2 app. v2 requests delegate to the same session machinery;
`src/v2-updates.ts` translates the update vocabulary.

| v2 method / update | Status | Notes |
| --- | --- | --- |
| `initialize` | implemented | answers protocol 2 with `info`, session capabilities, terminal `authMethods` (`methodId`), `_meta.steering` |
| `session/new`, `resume`, `fork`, `list`, `delete`, `close` | implemented | delegated to the v1 session operations |
| `session/prompt`, `session/cancel` | implemented | same run model; `state_update` running → idle around the run |
| `session/set_config_option` | implemented | model / thinking / mode |
| `providers/list` | implemented | the engine's configured providers (read-only) |
| `providers/set`, `providers/disable` | rejected | the engine exposes no safe provider mutation to an agent |
| `auth/login`, `auth/logout` | implemented | device-code flow / logout |
| `mcp/message` (+ `mcp/connect`, `mcp/disconnect`) | implemented | client-hosted MCP servers are tunnelled through the stdio bridge (`kimi-acp mcp-bridge`); declared stdio/HTTP/SSE servers work directly |
| `nes/*`, `document/*` | not advertised / ignored | editor features a chat agent does not use |
| updates | translated | message chunks, `tool_call_update`, `terminal_update`, `terminal_output_chunk`, `plan_update`, commands/config/info/usage passthrough; unknown kinds dropped |

## Client methods the agent calls

| Method | Status | Notes |
| --- | --- | --- |
| `session/request_permission` | implemented | approve once / approve for session / reject |
| `elicitation/create` | implemented | form mode when advertised; a choice-style permission request otherwise |
| `fs/read_text_file`, `fs/write_text_file` | not used | the engine reads and writes in-process (ADR Decision 3) |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | not used | command execution belongs to the engine; the client gets a display terminal through `_meta` (`terminal_info`, `terminal_output` or `terminal_output_delta`, `terminal_exit`) |
| `mcp/connect`, `mcp/message`, `mcp/disconnect` | implemented | client-declared servers (`session/new.mcpServers`, stdio/HTTP/SSE) run as session-local engine servers; a client-hosted connection (`mcp/connect`) is bridged by `kimi-acp mcp-bridge`, a stdio proxy the engine spawns whose socket is tunnelled over `mcp/message` |

## Session updates

| Update | Status | Notes |
| --- | --- | --- |
| `user_message_chunk` | implemented | replayed user prompts, engine-start introductions, replayed engine turns |
| `agent_message_chunk` | implemented | coalesced (32 chars / 100 ms), one `messageId` per message; system notices for compaction and engine errors |
| `agent_thought_chunk` | implemented | same coalescing |
| `tool_call` | implemented | title, kind, status, `rawInput`, diff content, readable-file locations, `_meta.terminal_info` |
| `tool_call_update` | implemented | streamed arguments, status, result preview, `rawOutput`, `_meta.terminal_output` / `terminal_exit` |
| `plan` | implemented | from the engine's `TodoList` display; replayed from history |
| `available_commands_update` | implemented | built-in commands (goal, swarm, compact, status, …), plugin commands and session skills, all invokable as `/name` |
| `current_mode_update` | implemented | `session/set_mode` |
| `config_option_update` | implemented | model / thinking / mode changes |
| `session_info_update` | implemented | engine-generated titles (`session.meta.updated`) |
| `usage_update` | implemented | after setup, each turn end, and configuration changes |
| `prompt_suggestions_update` | implemented | after each turn when the client advertises `session.promptSuggestions` and the engine's `prompt_prediction` experiment is on; empty list clears |

## Beyond the wire

- **Run model** (ADR Decision 2): a prompt settles when its engine turn ends
  (2.8 runs a prompt as one turn); engine-started continuations are separate
  turns and are introduced by a one-line note.
- **Projections for activity ACP has no entity for** (`src/activity.ts`):
  goals (`goal:<id>`), subagents (`subagent:<id>`), compaction notices.
- **Replay rules** (`src/replay.ts`): injected reminders stripped, TodoList
  restored as a plan, goals restored from `goal_updated` records.

## Not verified here

- A real Zed session (sign-in, tool cards, terminal shadow, goal card) — needs
  a desktop session; every path above is covered by the fake-provider
  end-to-end suite and unit tests instead.
- Client-supplied MCP servers, for the reason in the client-method table.