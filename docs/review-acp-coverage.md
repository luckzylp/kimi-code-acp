# kimi-code-acp 实现完成度与正确性评审

评审对象：`/data/project/git/kimi-code-acp` @ `0543bed`（适配器 0.22.1，上游钉在 `@moonshot-ai/kimi-code@2.8.1`）。
评审基准：

- **协议**：`@agentclientprotocol/sdk@2.12.0` 的 v1 unstable schema、`@agentclientprotocol/sdk@1.3.0`（别名 `sdk-v1`）的 v2 draft schema。
- **同类实现**：claude-code-acp（本地参考检出 `/tmp/acp-ref/claude-code-acp`，约 58k 行 TS）。
- **上游自带 ACP**：`vendor/upstream/packages/acp-server`（本适配器要替代的内置 `acp` 模式）。
- **TUI**：`apps/kimi-code/src/tui/commands/registry.ts` 的 44 个内置斜杠命令。

评分口径：✅ 已实现并有用例；🟡 部分实现 / 仅能力门控下的退化路径；❌ 未实现；➖ 不适用（协议或客户端不需要）。

---

## 1. 总览

| 维度 | 完成度 | 说明 |
|---|---|---|
| ACP v1 agent 方法（schema 共 24 个） | 17 ✅ / 2 🟡 / 5 ❌ | 核心 lifecycle + prompt + config 全通；缺 `session/status`、`auth/status`、`session/archive|unarchive`、`session/options` |
| ACP v1 SessionUpdate（21 种） | 16 ✅ / 5 ❌ | 缺 `subagent_update`、`compaction_summary_chunk`、`plan_removed`、`session_message(_chunk)` |
| ACP v1 客户端方法（13 个） | 3 ✅ / 10 ❌ | 只调用 `session/update`、`session/request_permission`、`elicitation/create`；fs/terminal 客户端方法完全未用 |
| ACP v2 agent 方法（schema 共 25 个） | 15 ✅ / 5 🟡 / 5 ❌ | v2 是 v1 处理器经 `toV2Updates` 的投影；`document/*` 5 个为 no-op；`nes/*` 5 个未实现（v2 schema 本身没有 `session/set_mode`/`set_title`/`load`） |
| ACP v2 SessionUpdate（17 种） | 15 ✅ / 2 ❌ | 缺 `agent_message`/`agent_thought`/`user_message` 的整段形式（只有 chunk 形式）、`tool_call_content_chunk`、`plan_removed` |
| AIR 扩展（claude-code-acp 共 11 个 `_session/*`） | 4 ✅ / 7 ❌ | 有 steering、goal、rename、rewind；缺 archive/unarchive、batch_get、list/subscribe|unsubscribe|changes、async_task/stop |
| TUI 命令（44 个） | 18 ✅（1 隐藏）/ 26 ❌ | 其中 15 个是 TUI 本地 UI（theme/editor/exit…）不可映射；真正可映射却缺的是 `new`、`sessions`、`fork`、`login`、`provider`、`secondary-model`、`plan`、`yolo`、`auto`、`export-md` |
| 测试 | 94 协议用例 + 48 单测 + 59 e2e 断言 | 覆盖面广，但见 §6 的盲区 |

规模对比：适配器 5.0k 行 TS vs claude-code-acp 58k 行；差距主要是 subagent/async task/session index/fs/terminal 四块。

---

## 2. ACP v1 方法面（逐项）

### 2.1 生命周期

| 方法 | 状态 | 核对要点 |
|---|---|---|
| `initialize` | ✅ | 广播 `loadSession`、`promptCapabilities{image,embeddedContext}`、`mcpCapabilities{http,sse}`、`providers{}`、`sessionCapabilities{list,delete,fork,resume,close,title}`、`authMethods[terminal login]`、`_meta.steering`、AIR `_meta.jetbrains.air`。**与 Zed 1.29.3 实际发送的 clientCapabilities 匹配**（fs/terminal/auth.terminal/session.{configOptions,compaction,notices}/elicitation） |
| `session/new` | ✅ | 支持 cwd、mcpServers（声明式 stdio）、additionalDirectories；返回 configOptions + modes |
| `session/load` | ✅ | `resumeSession({replayTurnLimit:200})` → `projectReplay` 投影成与 live 一致的更新；剥离 `<system-reminder>`/`<task-notification>`；回放用户消息发游标；发布已存标题 |
| `session/resume` | ✅ | 不回放；用例验证零回放更新 |
| `session/fork` | ✅ | 新 id、list 可见、可继续 prompt |
| `session/list` | ✅ | 含 title；`sessionCapabilities.list` 已广播 |
| `session/delete` | ✅ | |
| `session/close` | ✅ | 关 MCP 桥、bootstrap 会话；close 后 prompt 报错（有用例） |
| `session/archive` / `session/unarchive` | ❌ | **公开 SDK 无 archive 变更接口**（klient facade 有 `setArchived`，node-sdk 未暴露）。已明确不广播 `sessionCapabilities.archive`，客户端不会误调。合理 |
| `session/options` | ❌ | 2.12 unstable 新增的选项查询；适配器把 configOptions 放在 new/load 响应和 `config_option_update` 里，Zed 1.29 不调 `session/options`。低优先 |
| `session/status` | ❌ | claude-code-acp 有实现；Zed 1.29 未调用。低优先 |

### 2.2 Prompt 与运行模型

| 方法 | 状态 | 核对要点 |
|---|---|---|
| `session/prompt` | ✅ | 一次 prompt = 一个引擎 turn；`turn.ended` 结算；`completed→end_turn`、`cancelled→cancelled`、`failed→end_turn`、`provider.filtered/blocked→refusal`。支持 text / image(data URL) / resource_link / embeddedContext。命令、skill、plugin command 在此分流 |
| `session/cancel`（通知） | ✅ | 审批对话框打开时取消 → `cancelled`（有用例） |
| `$/cancel_request` | ✅ | 按 prompt 请求 id 取消 |

**合理性判断（run model）**：2.8 把 model step 和 tool call 收进 turn 内部，所以"一 prompt 一 turn、turn.ended 结算"是正确的；上游 `acp-server` 也是这么做的。但 **steering/queue 语义与 ACP 规范有分歧**：ACP 规范要求并发 prompt 返回错误或排队，本实现在忙时把新 prompt **steer 进运行中的 turn 并立即返回 `{stopReason:'end_turn'}`**。对 Zed（用户在运行中继续输入）这是想要的效果，但严格说第二个请求的响应并不代表它自己的结果。claude-code-acp 的做法是排队并在后续 turn 结算。当前做法有 `_meta.steering` 能力声明作掩护，可接受；建议在 ADR 明确记录这一分歧（已部分记录）。

### 2.3 配置与模式

| 方法 | 状态 | 核对要点 |
|---|---|---|
| `session/set_config_option` | ✅ | model / thinking；返回最新 configOptions 并发 `config_option_update`；非法值报 `-32602` |
| `session/set_mode` | ✅ | plan / default / auto / yolo 四模式，与 TUI 的 `plan`、`auto`、`yolo` 命令对应；非法 mode 报错 |
| `session/set_title` | ✅ | 与 AIR `_session/rename` 共用路径；返回 trim 后的 title |

### 2.4 认证与 Provider

| 方法 | 状态 | 核对要点 |
|---|---|---|
| `authenticate` | 🟡 | 终端 login 设备流（`kimi-acp login` 子命令）；需要网络与真实账号，仅测了未知方法路径 |
| `logout` | ✅ | 失败时返回可读原因（`-32600 logout failed: …`），不再 `-32603` |
| `auth/status` | ❌ | claude-code-acp 有；Zed 1.29 未调用 |
| `providers/list` | ✅（只读） | 读 `providers[*].type`（修复了之前读不存在的 `protocol` 字段、恒返回 openai 的 bug） |
| `providers/set` / `providers/disable` | 🟡 明确拒绝 | 引擎无运行时 provider 写面；自定义 key 走 `KIMI_MODEL_*` env 或 config.toml（有用例验证 Bearer 头到达 provider）。**决策合理**，但 `providers/list` 的 `supported` 只回当前 type 一项、`required` 恒 false，语义上不够准确（P2） |

### 2.5 扩展方法

| 方法 | 状态 | 核对要点 |
|---|---|---|
| `_session/steering` | ✅ | 运行中 `injected`，空闲时按 `idleBehavior` 返回 `promptRequired` |
| `_session/goal` | ✅ | set / clear，goal 卡片 + AIR goal payload |
| `_session/rewind` | ✅ | 游标 → `undoHistory(n)`；忙时 `{rewound:false,reason:'busy'}`；rewind 后 reload 不复活被删轮次（有用例）。**见 §5 风险 R1** |
| `_session/rename` | ✅ | AIR session index 的最小子集 |

---

## 3. ACP v1 SessionUpdate（21 种）

| 更新 | 状态 | 说明 |
|---|---|---|
| `agent_message_chunk` / `agent_thought_chunk` | ✅ | TextCoalescer 合并；messageId 稳定 |
| `user_message_chunk` | ✅ | 回放时带 messageId |
| `tool_call` / `tool_call_update` | ✅ | id 为 `${turnId}:${toolCallId}`，开始/完成/失败一致；diff/content/locations/rawInput 投影 |
| `current_mode_update` / `config_option_update` | ✅ | |
| `available_commands_update` | ✅ | 内置（18 个，`add-dir` 隐藏）+ skills + plugin commands |
| `usage_update` | ✅ | setup 后与每轮结束 |
| `plan` / `plan_update` | ✅ | TodoList → plan |
| `plan_removed` | ❌ | TodoList 清空时未发；Zed 会残留旧 plan（P2） |
| `notice` | ✅ | 声明 `session.notices` 时结构化，否则退化为消息 |
| `compaction_update` | ✅ | 声明 `session.compaction` 时 in_progress/completed/cancelled/failed |
| `compaction_summary_chunk` | ❌ | 未发摘要块；Zed 1.29 用 `compaction_update`，影响小 |
| `session_info_update` | ✅ | title + updatedAt；AI 短标题（适配器侧调会话模型，引擎生成器仅服务托管 Kimi OAuth） |
| `cursor_update` | ✅ | 声明 `session.cursors` 时每 prompt 一个 |
| `prompt_suggestions_update` | ✅ | 需 `prompt_prediction` 实验开关 |
| `subagent_update` | ❌ | **claude-code-acp 最常用的更新之一（59 处）**。本实现把 subagent 事件折叠成 notice；Zed 的子 agent 面板/原生会话无法呈现（P1） |
| `session_message` / `session_message_chunk` | ❌ | unstable；claude-code-acp 用于 meta 消息；Zed 1.29 未渲染。低优先 |

终端：v1 走 `tool_call._meta.terminal_info` + `tool_call_update._meta.terminal_output`（UTF-8 文本）+ `terminal_exit`，与 Zed 1.29.3 `terminal_updates.rs` 的读取方式一致 ✅。

---

## 4. ACP v1 客户端方法（适配器作为调用方）

| 客户端方法 | 状态 | 说明 |
|---|---|---|
| `session/update` | ✅ | |
| `session/request_permission` | ✅ | 选项 `allow_once`/`allow_always`/`reject_once`；approve_session → 引擎 `scope:'session'`（按 approval rule 记忆）。**不提供 `reject_always`**（引擎无负向会话规则）——合理 |
| `elicitation/create` | ✅ form | AskUserQuestion → form；**url 模式未用** |
| `fs/read_text_file` / `fs/write_text_file` | ❌ | 能力已读取（`fsRead/fsWrite`）但**从未调用**：文件读写全部由引擎本地完成。对本地 agent 合理；但意味着"客户端工作区 ≠ agent 工作区"的远程场景不支持 |
| `terminal/create` / `output` / `wait_for_exit` / `kill` / `release` | ❌ | 只用 `_meta.terminal_*` 影子终端。ACP 规范的 terminal/* 方法（Claude Code ACP 对声明 `terminal` 能力的客户端会走）未实现（P2） |
| `mcp/message` | ❌ v1 | v1 schema 里是 agent 方法不是 client 方法；MCP-over-ACP 仅在 v2 实现 |
| `auth/status_update` / `elicitation/complete` | ➖ | agent 侧方法，无需调用 |

---

## 5. ACP v2（draft 1.3）

v2 不是独立实现：`agentProtocolRouter().withV1(app).withV2(v2App)` 在同一连接协商，v2 处理器委托 v1 实现，`toV2Updates` 翻译更新。

| 项 | 状态 | 核对要点 |
|---|---|---|
| 协商 / `initialize` | ✅ | v2 的 `capabilities`（非 `clientCapabilities`）现已读取：promptSuggestions、elicitation；`info` 回传 |
| `session/new|resume|fork|list|delete|close` | ✅ | 经 `guarded()` 映射错误（修复了 v2 把 2.12 `RequestError` 压成 `-32603` 的缺陷） |
| `session/prompt` | ✅ | 返回 `{}`（v2 规范），state_update running/idle |
| `session/set_config_option` | ✅ | `configId` + `{type:'id'}` 形状 |
| `session/set_mode` / `session/set_title` / `session/load` | ➖ | v2 schema 的 agent 方法列表里没有这三个方法（见 §1），模式经 `set_config_option` 承担 |
| `auth/login` / `auth/logout` | ✅ | |
| `providers/list` ✅，`set|disable` 拒绝 | ✅ | |
| `mcp/connect`（客户端→agent 请求）| ✅ | 客户端托管 MCP：`McpBridge` 合成 stdio 代理，`mcp/message` 双向 |
| `mcp/message`（agent→client 请求） | ❌ 明确拒绝 | v2 把它列为 agent 方法；当前仅处理 notification 形式 |
| `document/*`（5 个通知） | 🟡 no-op | 接收但忽略；对 Zed 线程无影响 |
| `nes/*`（5 个方法） | ❌ | 下一步编辑建议；与 Zed ACP 线程无关 |
| 更新翻译 | ✅ | tool_call → tool_call_update（+ terminal_update）；terminal_output → **base64** chunk（修复过）；notice/compaction/suggestions 直通 |
| `tool_call_content_chunk` / `agent_message`（整段） | ❌ | v2 允许整段消息，本实现只发 chunk；客户端兼容 |

**合理性判断**：把 v2 建成 v1 的投影是正确的工程选择（避免两套逻辑漂移），代价是 v2 独有的能力（nes、整段消息、mcp/message 请求）天然缺失。v2 pinned 在 1.3 draft 是因为 2.12 的 v2 重命名了方法并移除 `mcp/connect`——这意味着**当 Zed 升级到依赖 2.12 v2 形状时，v2 路径会断**，这是技术债，需要在 ADR 标注升级触发条件。

---

## 6. TUI 命令对齐（44 → 18 实现）

| 分类 | 命令 | 评价 |
|---|---|---|
| ✅ 已实现（18） | help status usage goal swarm tower compact init undo title tasks mcp plugins model effort permission logout add-dir(隐藏) | 对应 TUI 语义；`/plan` 却**不在列表**——plan 由 `session/set_mode` 承担，但 TUI 有 `/plan` 命令，用户手输 `/plan` 会落到"未知命令 → 当 prompt 发给模型"（P1） |
| ❌ 可映射但缺（10） | **plan**、**yolo**、**auto**、**new**、**sessions**、**fork**、**login**、**provider**、**secondary-model**、**export-md** | 前 3 个只是 `setMode` 的别名，缺失最不合理；`new/fork/sessions` 在 ACP 里是客户端操作（session/new|fork|list），作为命令意义不大；`login` 可复用 `authenticate`；`export-md` 引擎有 `exportSession` |
| ❌ 引擎有原语（3） | `reload`、`remote-control`、`experiments` | 可做，低价值 |
| ➖ TUI 本地 UI（13） | settings editor theme exit copy web desktop btw feedback version reload-tui export-debug-zip import-sessions | 不可映射，正确地不实现 |

---

## 7. 与 claude-code-acp 的差距（按价值排序）

1. **subagent_update + 原生子 agent 会话**（P1）：claude-code-acp 59 处 subagent_update、AIR `nativeSubagentSessions`；本实现只有 notice。swarm/goal 多 agent 场景在 Zed 里看不到子 agent。
2. **async task（AIR）**：`async_task_spawned|state_update|progress`、`_session/async_task/stop`；本实现 `/tasks` 只列文本。
3. **session index（AIR 6 个方法）**：`batch_get`、`list/subscribe|unsubscribe|changes`；只有 rename/rewind。
4. **archive/unarchive**：SDK 阻塞（已确认）。
5. **fs/terminal 客户端方法**：远程/沙箱工作区场景；本实现假定本地。
6. **diff patch（精确 git patch）**：AIR diffPatch；引擎只给 old/new 文本。
7. **`session/status`、`auth/status`、`elicitation` url 模式**：小项。
8. **`replay_complete`**：claude-code-acp 在 load 回放结束时发（unstable），本实现用 `flush()` 保证顺序但无显式结束标记。

---

## 8. 正确性与合理性：发现的问题

| 级别 | 编号 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| **P1** | R1 | **rewind 的 undo 计数单位错位风险**：`_session/rewind` 用 `count = 适配器记录的用户消息数 - 游标索引` 调 `undoHistory(count)`，但引擎 undo 以 **turn** 为单位；goal 续跑、steer、后台通知触发的 turn 会插在两条用户消息之间，导致少删 | 现有用例只覆盖"两条纯用户 prompt"场景；`forkTurnSlice.ts` 用 `turn.prompt` 记录作 turn 边界 | 补一个"goal 续跑后 rewind"的用例验证；若错位，改为按引擎 `undoService.availability()`/wire 记录计算 |
| P1 | R2 | `/plan`、`/yolo`、`/auto` 未注册，手输会当 prompt 发给模型 | TUI 有这三个命令；`set_mode` 已支持四模式 | 注册为 `setMode` 别名，各 1 行 |
| P1 | R3 | 忙时 `session/prompt` 返回 `end_turn` 而非排队 | ACP 规范；claude-code-acp 排队 | ADR 已记录分歧；可考虑返回 `{stopReason:'cancelled'}`？不——保持现状但对 AIR 返回 `steered` 提示 |
| P1 | R4 | AI 标题只支持 `openai`/`kimi`/`openai_responses` 端点；`anthropic`/`google-genai`/`bedrock`/`vertexai` provider 一律退回首行 | `title.ts` 显式分支 | 可接受（用户 provider 均为 openai 系）；文档已注明 |
| P2 | R5 | `plan_removed` 未发 | 清空 TodoList 后 Zed 残留 | tool.call 的 todo_list 为空时发 `plan_removed` |
| P2 | R6 | `fsRead/fsWrite` 读取但未用；声明了 `terminal` 能力的客户端（非 Zed）不会收到 terminal/* | 本地 agent 场景无害 | 文档注明"仅本地工作区" |
| P2 | R7 | `providers/list` 的 `supported` 只含当前 type、`required` 恒 false | schema 语义是"agent 支持的协议列表" | 改为引擎支持的 7 种 type |
| P2 | R8 | v2 pinned 1.3 draft，Zed 若升级到 2.12 v2 形状会断 | 2.12 v2 重命名方法、移除 `mcp/connect` | ADR 标注触发条件与迁移路径 |
| P2 | R9 | `generateSessionTitle` 每轮最多 3 次尝试，但适配器侧 HTTP 失败后直接 fallback 并标记 `titled`，不会再试 | `maybeGenerateTitle` | 可接受（避免每轮打模型） |
| ✅ | — | tool_call id 跨开始/完成一致；v2 terminal base64；v2 错误映射；approve_session 按规则；rewind 持久化 | 均有用例 | — |

**未发现 P0。** 边界约束成立：`vendor/` 未跟踪、非 git 检出、适配器源码无 vendor 相对导入、仅通过 SDK 公开入口调用（`check:boundary` 通过）。

---

## 9. 测试充分性

**强项**：94 个协议用例覆盖每个已实现方法的正常 + 异常路径；wire 形状用 SDK 的 zod schema 校验；Zed 1.29.3 能力集作为默认客户端；AIR 能力集单独用例。

**盲区**：
- `authenticate` 真实设备流（需网络）
- plugin command 端到端发现（仅单测边界）
- goal 续跑 + rewind（R1）
- 多客户端同连一个会话（上游 AGENTS.md 列为高风险场景）
- Windows 路径 / CRLF
- 真实 Zed 手测（用户侧未执行）

---

## 10. 结论

- **对 Zed 1.29.3 的 ACP v1 面是可用的**：lifecycle、prompt、权限、终端、配置、通知、压缩、游标、标题全部打通，并有 94 个可重复用例。
- **与 claude-code-acp 的主要差距集中在"多 agent 可见性"（subagent/async task）和"会话索引"**，不是基础协议；这两块需要引擎侧事件路由而非协议补丁。
- **v2 是投影而非对等实现**，对当前 Zed 足够，但有 draft 版本锁定风险。
- **需要立即处理的**：R1（验证 rewind 计数）、R2（补 `/plan` `/yolo` `/auto`）。

### 建议路线图

1. R2 命令别名（半天）+ R5 `plan_removed`（半天）
2. R1 rewind 计数验证与修正（1 天）
3. subagent_update 投影（P1，2–3 天）：先探明 `session.onEvent` 是否收到子 agent 事件
4. AIR session index（batch_get / list subscribe）（2 天）
5. v2 升级评估（当 Zed 要求时）
