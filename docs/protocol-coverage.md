# ACP protocol coverage

Audit of the adapter against the ACP v1 schema shipped with
`@agentclientprotocol/sdk@1.3.0` (`schema/schema.json`), as of
`@moonshot-ai/kimi-code-acp@0.6.0`.

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
| `providers/list`, `providers/set`, `providers/disable` | not advertised | no `providers` capability; model choice is exposed as a config option instead |
| `session/new` | implemented | `src/agent.ts` — `additionalDirectories`, `mcpServers` logged (see MCP) |
| `session/load` | implemented | resume + replay in `src/replay.ts` |
| `session/resume` | implemented | bind without replay |
| `session/fork` | implemented | `harness.forkSession` |
| `session/list` | implemented | `harness.listSessions` |
| `session/delete` | implemented | `harness.deleteSession` |
| `session/close` | implemented | disposes the bridge |
| `session/set_mode` | implemented | default / plan / auto / yolo → planMode + permission |
| `session/set_config_option` | implemented | model, thinking, mode |
| `session/prompt` | implemented | run model, text/image/resource blocks |
| `session/cancel` | implemented | cancels the run, including a pending permission dialog |
| `$/cancel_request` | implemented | the SDK aborts the request signal; the handler cancels the run |
| `_session/steering` (extension) | implemented | injects into the running turn; `startedNewTurn` when idle; `promptRequired` opt-in; advertised via `initialize._meta.steering` |
| `nes/start`, `nes/suggest`, `nes/close` | not advertised | next-edit suggestions are not a chat agent feature |

## Client methods the agent calls

| Method | Status | Notes |
| --- | --- | --- |
| `session/request_permission` | implemented | approve once / approve for session / reject |
| `elicitation/create` | implemented | form mode when advertised; a choice-style permission request otherwise |
| `fs/read_text_file`, `fs/write_text_file` | not used | the engine reads and writes in-process (ADR Decision 3) |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | not used | command execution belongs to the engine; the client gets a display terminal through `_meta` (`terminal_info`, `terminal_output` or `terminal_output_delta`, `terminal_exit`) |
| `mcp/connect`, `mcp/message`, `mcp/disconnect` | **blocked** | MCP-over-ACP would need the engine's MCP client to accept an ACP-provided transport; its transports are stdio/SSE/HTTP only (`agent-core-v2/src/mcpCore/`). The engine's own MCP config still applies to every session |

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

## Beyond the wire

- **Run model** (ADR Decision 2): a prompt settles at quiescence, so goal
  continuations and late task notifications stay inside the client's prompt.
- **Projections for activity ACP has no entity for** (`src/activity.ts`):
  goals (`goal:<id>`), subagents (`subagent:<id>`), compaction notices.
- **Replay rules** (`src/replay.ts`): injected reminders stripped, TodoList
  restored as a plan, goals restored from `goal_updated` records.

## Not verified here

- A real Zed session (sign-in, tool cards, terminal shadow, goal card) — needs
  a desktop session; every path above is covered by the fake-provider
  end-to-end suite and unit tests instead.
- Client-supplied MCP servers, for the reason in the client-method table.