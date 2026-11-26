# Zed's ACP client behaviour (1.29.3)

What the client in this workspace actually does, derived from the Zed sources in
`/tmp/zedsrc` (`crates/agent_servers`, `crates/acp_thread`). The protocol suite
(`scripts/protocol-suite.mjs`) encodes these behaviours; this note explains why
each case exists.

## Handshake

- `initialize` sends `protocolVersion: 1` and `clientInfo {name: "zed", version, title?}`
  (`agent_servers/v1.rs`, `InitializeRequest::new(ProtocolVersion::V1)`).
- Client capabilities (`client_capabilities_for_agent`):
  - `fs.readTextFile = true`, `fs.writeTextFile = true`
  - `terminal = true`
  - `auth.terminal = true`
  - `session { configOptions.boolean, compaction, notices }` (1.29.3 does **not**
    advertise `promptSuggestions`)
  - `elicitation { form, url }`
  - `subagents` / `plan` only behind `acp-beta`
  - `_meta { terminal_output: true, terminal-auth: true }`
- A response whose `protocolVersion` is below its minimum is rejected; the agent
  must answer the version it will speak.

## Requests the client sends

- `session/new` with `{cwd, additionalDirectories, mcpServers}`
  (`SessionDirectories::into_new_session_request`). The same fields ride
  `session/load` and `session/resume`.
- `session/set_config_option` when the user changes a model/thinking/mode option.
- `session/prompt` with content blocks; text and images are what the UI builds
  (no `resource_link` from this version).
- `session/cancel` (notification) and `$/cancel_request` with the in-flight
  prompt's request id.
- `session/close` when the thread is closed.
- Client-side requests the agent may call: `session/request_permission`,
  `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, and
  `elicitation/create` (form and URL modes). This adapter only uses permissions
  and elicitation by design (ADR Decision 3).

## Permissions

Zed renders every option and accepts the outcome `selected {optionId}` or
`cancelled`. It understands the four kinds `allow_once`, `allow_always`,
`reject_once`, `reject_always` (`agent_servers/v1.rs` permission conversions),
and on `session/cancel` it answers any open request with `cancelled`.

## Shadow terminals (v1)

`agent_servers/v1.rs` (~line 10436):

- a **`tool_call`** carrying `_meta.terminal_info {terminal_id, cwd?}` makes Zed
  create a display-only terminal whose **label is the tool call's title**;
- a **`tool_call_update`** carrying `_meta.terminal_output {terminal_id, data}`
  appends `data` **as UTF-8 text** (not base64);
- a `tool_call_update` carrying `_meta.terminal_exit {terminal_id, exit_code?, signal?}`
  finishes the terminal;
- other updates fall through to the thread.

Nothing in the terminal path requires `terminal/*` reverse RPCs, which is why
the adapter never calls them.

## Shadow terminals (v2 draft)

Zed's `terminal_updates.rs` decodes `terminal_update` and
`terminal_output_chunk` payloads with **base64** (`STANDARD.decode`). The adapter
therefore base64-encodes v2 terminal data; v1's `_meta.terminal_output` stays raw
text. A v2 client also removes a plan with `plan_removed` and learns turn
boundaries from `state_update` (`running` / `idle`).

## Session updates

`agent_servers/session_updates.rs` handles, in the v2 vocabulary it converts
v1 updates into: user/agent/thought messages and chunks, tool-call updates and
content chunks, plans (items / markdown / file / removed), terminals, session
info, available commands, config options, usage, state, notices, compaction,
and subagents. Unknown or malformed updates must not break the thread; the
client logs and continues.

Two practical consequences the suite checks:

- a chunk without its expected fields is tolerated but renders as nothing, so
  the adapter always includes `messageId` and text content;
- an update kind the client does not model must not disturb later updates.

## What this means for the adapter

1. Keep the v1 terminal contract exactly (`terminal_info` on the card,
   plain-text output, exit code on the finish update).
2. Base64 v2 terminal payloads.
3. Keep announcing `agent_message_chunk` with `messageId`.
4. `$/cancel_request` must cancel the request it names; unknown ids must be
   ignored.
5. Errors for unknown sessions/options must be JSON-RPC errors, not crashes.
