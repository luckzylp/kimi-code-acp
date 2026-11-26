/**
 * The ACP agent surface (ADR 0001).
 *
 * - `initialize`, `session/new`, `session/load`, `session/resume`,
 *   `session/fork`, `session/list`, `session/delete`, `session/close`
 * - `session/prompt` / `session/cancel` on top of the run model
 * - config options (model, thinking, mode) and `session/set_mode`
 * - skills advertised as slash commands
 *
 * Tool execution belongs to the agent (the engine), never to the client: the
 * client renders a card and, for commands, a terminal fed through `_meta`.
 * That removes the whole `terminal/*` reverse-RPC failure class.
 */
import {
  agent,
  type AgentApp,
  type AgentContext,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type LogoutRequest,
  type LogoutResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type AvailableCommand,
  type ListProvidersResponse,
  type McpServer as AcpMcpServer,
  type SessionConfigOption,
  type SessionModeState,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  methods,
  RequestError,
} from '@agentclientprotocol/sdk';
import {
  createKimiHarness,
  type KimiHarness,
  type PromptPart,
  type Session as KimiSession,
} from '@moonshot-ai/kimi-code-sdk';

import { LOGIN_METHOD_ID, terminalAuthMethod } from './auth';
import { readClientCapabilities, type ClientCapabilities } from './capabilities';
import {
  availableBuiltinCommands,
  expandPluginBody,
  parseSlashCommand,
  pluginSlashCommands,
  runBuiltinCommand,
  type CommandRuntime,
} from './commands';
import {
  ACP_MODES,
  acpModeToToggles,
  buildConfigOptions,
  isAcpModeId,
  modeOf,
  modelEntries,
} from './config-options';
import { log } from './log';
import { listProviders } from './providers';
import { McpBridge } from './mcp-bridge';
import { buildPrompt } from './prompt';
import { projectReplay, type ReplayRecord } from './replay';
import { toV2Updates } from './v2-updates';
import {
  parseSteerRequest,
  STEER_METHOD,
  STEERING_CAPABILITY,
  type SteerRequest,
  type SteerResponse,
} from './steering';
import { SessionBridge } from './session';
import { toolKind } from './tool-calls';
import { AGENT_NAME, VERSION } from './version';

/** ACP protocol version this adapter speaks. Zed negotiates down from v2 on its own. */
const PROTOCOL_VERSION = 1;

/** How many completed turns may end without a title before this session stops asking. */
const MAX_TITLE_ATTEMPTS = 3;

interface SessionEntry {
  readonly session: KimiSession;
  readonly bridge: SessionBridge;
  titleAttempts: number;
  titled: boolean;
}

/** The v2 client connection, shared with `v2.ts` (notify/request only). */
export interface V2ClientLike {
  notify(method: string, params: unknown): Promise<void>;
  request<Response = unknown>(method: string, params: unknown): Promise<Response>;
}

export interface AgentState {
  capabilities: ClientCapabilities;
  harness: KimiHarness | undefined;
  readonly sessions: Map<string, SessionEntry>;
  client: AgentContext | undefined;
  v2Client: V2ClientLike | undefined;
  /** Bootstrap sessions holding client-declared MCP servers alive, by ACP session. */
  readonly mcpBootstrap: Map<string, KimiSession>;
  /** MCP-over-ACP bridges by their connection id (client-initiated messages). */
  readonly mcpBridges: Map<string, McpBridge>;
  /** MCP-over-ACP bridges owned by an ACP session. */
  readonly mcpSessionBridges: Map<string, McpBridge[]>;
}

export function createAgentState(): AgentState {
  return {
    capabilities: readClientCapabilities(undefined),
    harness: undefined,
    sessions: new Map(),
    client: undefined,
    v2Client: undefined,
    mcpBootstrap: new Map(),
    mcpBridges: new Map(),
    mcpSessionBridges: new Map(),
  };
}

export function createAgentApp(
  state: AgentState = createAgentState(),
): { app: AgentApp; close: () => Promise<void> } {

  const app = agent({ name: AGENT_NAME })
    .onConnect((connection) => {
      state.client = connection.client;
    })
    .onRequest('initialize', (context) => initialize(state, context.params))
    .onRequest('session/new', (context) => newSession(state, context.params))
    .onRequest('session/load', (context) => loadSession(state, context.params))
    .onRequest('session/resume', (context) => resumeSession(state, context.params))
    .onRequest('session/list', (context) => listSessions(state, context.params))
    .onRequest('session/delete', (context) => deleteSession(state, context.params))
    .onRequest('session/close', (context) => closeSession(state, context.params))
    .onRequest('session/fork', (context) => forkSession(state, context.params))
    .onRequest('authenticate', (context) => authenticate(state, context.params))
    .onRequest('providers/list', async () => {
      return (await listProviders(await harnessOf(state))) as unknown as ListProvidersResponse;
    })
    .onRequest('providers/set', () => {
      throw RequestError.invalidParams(undefined, 'provider management is not supported by the kimi engine');
    })
    .onRequest('providers/disable', () => {
      throw RequestError.invalidParams(undefined, 'provider management is not supported by the kimi engine');
    })
    .onRequest('logout', (context) => logout(state, context.params))
    .onRequest('session/set_mode', (context) => setMode(state, context.params))
    .onRequest(STEER_METHOD, parseSteerRequest, (context) => steerRequest(state, context.params))
    .onRequest('session/set_config_option', (context) => setConfigOption(state, context.params))
    .onRequest('session/prompt', (context) => prompt(state, context.params, context.signal))
    .onNotification('session/cancel', (context) => {
      cancel(state, context.params);
    });

  return { app, close: () => close(state) };
}

function initialize(state: AgentState, params: InitializeRequest): InitializeResponse {
  state.capabilities = readClientCapabilities(params.clientCapabilities);
  log.info('acp: initialize', {
    protocolVersion: params.protocolVersion,
    clientCapabilities: state.capabilities,
  });
  return initializeResponse();
}

/** The v1 handshake payload, exported so contract tests can validate it. */
export function initializeResponse(): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      // stdio is always available; these are the remote transports we can run.
      mcpCapabilities: { http: true, sse: true },
      // providers/list is served read-only; see providers.ts.
      providers: {},
    },
    authMethods: [terminalAuthMethod()],
    // The ACP steering extension: a client may inject into the running turn.
    _meta: { ...STEERING_CAPABILITY },
  };
}

export async function harnessOf(state: AgentState): Promise<KimiHarness> {
  state.harness ??= createKimiHarness({
    identity: { productName: AGENT_NAME, version: VERSION, platform: 'kimi_acp' },
  });
  return state.harness;
}

/** The pickers every session response carries: config options and modes. */
async function surface(
  state: AgentState,
  session: KimiSession,
): Promise<{ configOptions: SessionConfigOption[]; modes: SessionModeState }> {
  const status = await session.getStatus();
  const config = await (await harnessOf(state)).getConfig();
  return {
    configOptions: buildConfigOptions(modelEntries(config), status),
    modes: {
      currentModeId: modeOf(status) as SessionModeState['currentModeId'],
      availableModes: ACP_MODES.map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
      })) as SessionModeState['availableModes'],
    },
  };
}

export async function newSession(state: AgentState, params: NewSessionRequest): Promise<NewSessionResponse> {
  const harness = await harnessOf(state);
  const config = await harness.getConfig();
  const model = config.defaultModel;
  if (model === undefined) {
    throw RequestError.authRequired(
      undefined,
      'No model configured. Run `kimi` once to log in, or set default_model in config.toml.',
    );
  }
  // The engine snapshots the model's tool list when a session starts, so a
  // server added afterwards is connected but invisible to the model. Client
  // servers are therefore registered through a bootstrap session first (the
  // workspace MCP registry is shared), then the real session starts with their
  // tools already in place.
  const bootstrap = await warmClientMcpServers(harness, params.cwd, params.mcpServers ?? []);
  const session = await harness.createSession({
    workDir: params.cwd,
    model,
    ...(params.additionalDirectories === undefined || params.additionalDirectories.length === 0
      ? {}
      : { additionalDirs: params.additionalDirectories }),
  });
  const entry = await registerSession(state, session);
  const { configOptions, modes } = await surface(state, session);
  log.info('acp: session created', { sessionId: session.id, cwd: params.cwd, model });
  scheduleSurfaceUpdates(entry);
  return { sessionId: session.id, configOptions, modes };
}

/** Map an ACP MCP server declaration onto the engine's config, or undefined. */
function toEngineMcpServer(server: AcpMcpServer, index: number): EngineMcpServer | undefined {
  const record = server as unknown as Record<string, unknown>;
  const name =
    typeof record['name'] === 'string' && record['name'].length > 0 ? record['name'] : `client-mcp-${String(index)}`;
  const type = typeof record['type'] === 'string' ? record['type'] : undefined;
  if (type === 'http' || type === 'sse') {
    if (typeof record['url'] !== 'string') return undefined;
    const headers = nameValueRecord(record['headers']);
    return {
      name,
      transport: type,
      url: record['url'],
      deferred: false,
      ...(headers === undefined ? {} : { headers }),
    };
  }
  if (typeof record['command'] !== 'string') return undefined;
  const args = Array.isArray(record['args'])
    ? record['args'].filter((arg): arg is string => typeof arg === 'string')
    : [];
  const env = nameValueRecord(record['env']);
  return {
    name,
    transport: 'stdio',
    command: record['command'],
    // Client-declared servers are for this prompt: expose their tools inline
    // rather than behind the deferred-tool discovery flow.
    deferred: false,
    ...(args.length === 0 ? {} : { args }),
    ...(env === undefined ? {} : { env }),
  };
}

type EngineMcpServer = Parameters<KimiSession['addMcpServer']>[0];

/**
 * ACP spells environment variables and headers as `[{name, value}]` (v1) or a
 * plain record (v2); the engine wants a record either way.
 */
function nameValueRecord(value: unknown): Record<string, string> | undefined {
  if (Array.isArray(value)) {
    const entries = value.flatMap((item): Array<[string, string]> => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as Record<string, unknown>;
      return typeof record['name'] === 'string' && typeof record['value'] === 'string'
        ? [[record['name'], record['value']]]
        : [];
    });
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, string>;
  }
  return undefined;
}

/**
 * Register the client's MCP servers through a throwaway session so the next
 * session starts with their tools. A server that fails to start does not fail
 * the session — the model simply does not see its tools.
 */
async function warmClientMcpServers(
  harness: KimiHarness,
  cwd: string,
  servers: readonly AcpMcpServer[],
): Promise<KimiSession | undefined> {
  const configs = servers
    .map((server, index) => toEngineMcpServer(server, index))
    .filter((config): config is EngineMcpServer => config !== undefined);
  if (configs.length === 0) {
    if (servers.length > 0) log.warn('acp: no usable MCP server declarations', { count: servers.length });
    return undefined;
  }
  try {
    // The workspace MCP registry lives as long as the session that seeded it,
    // so this bootstrap session is kept open beside the real one and closed
    // with it.
    const bootstrap = await harness.createSession({ workDir: cwd });
    for (const config of configs) {
      const info = await bootstrap.addMcpServer(config, { persist: false });
      log.info('acp: client MCP server added', { name: config.name, status: info.status, tools: info.toolCount });
    }
    return bootstrap;
  } catch (error) {
    log.warn('acp: client MCP server failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Bind one engine session to the ACP session id and its handlers. */
async function registerSession(state: AgentState, session: KimiSession): Promise<SessionEntry> {
  const client = state.client;
  const v2 = state.v2Client;
  if (client === undefined && v2 === undefined) {
    throw RequestError.internalError(undefined, 'ACP connection is not bound');
  }
  const existing = state.sessions.get(session.id);
  if (existing !== undefined) return existing;
  const bridge = new SessionBridge({
    sessionId: session.id,
    session,
    // v2 renders terminals natively, so a v2 session always mirrors command
    // output even though the client never sent v1's terminal capability.
    shadowTerminals: state.capabilities.terminalOutput || v2 !== undefined,
    terminalOutputDelta: state.capabilities.terminalOutputDelta,
    send: async (notification) => {
      if (client !== undefined) {
        await client.notify(methods.client.session.update, notification);
        return;
      }
      // ACP v2: translate the v1 update vocabulary into v2 updates.
      for (const update of toV2Updates(notification)) {
        await v2?.notify('session/update', { sessionId: notification.sessionId, update });
      }
    },
  });
  wireApprovals(state, bridge, session);
  wireQuestions(state, bridge, session);
  const entry: SessionEntry = { session, bridge, titleAttempts: 0, titled: false };
  state.sessions.set(session.id, entry);
  return entry;
}

/**
 * Commands and usage are sent after the response: a client that has not
 * registered the session id yet would drop them.
 */
function scheduleSurfaceUpdates(entry: SessionEntry): void {
  setTimeout(() => {
    void (async () => {
      await entry.bridge.emitCommands(await availableCommands(entry.session));
      await entry.bridge.emitUsage();
    })();
  }, 0);
}

/** Built-in commands + plugin commands + skills, as ACP advertises them. */
async function availableCommands(session: KimiSession): Promise<AvailableCommand[]> {
  const plugins = await pluginSlashCommands(session);
  let skills: AvailableCommand[] = [];
  try {
    skills = (await session.listSkills()).map((skill) => ({
      name: skill.name,
      description: skill.description,
      input: { hint: 'arguments' },
    }));
  } catch {
    skills = [];
  }
  return [...availableBuiltinCommands(), ...plugins.advertised, ...skills];
}

/**
 * `session/load`: resume the engine session and replay its persisted history
 * as the same updates a live turn produces, before the response.
 */
async function loadSession(state: AgentState, params: LoadSessionRequest): Promise<LoadSessionResponse> {
  const harness = await harnessOf(state);
  const bootstrap = await warmClientMcpServers(harness, params.cwd, params.mcpServers ?? []);
  const session = await harness.resumeSession({
    id: params.sessionId,
    replayTurnLimit: 200,
    ...(params.additionalDirectories === undefined || params.additionalDirectories.length === 0
      ? {}
      : { additionalDirs: params.additionalDirectories }),
  });
  if (bootstrap !== undefined) state.mcpBootstrap.set(session.id, bootstrap);
  const entry = await registerSession(state, session);
  const records = (session.getResumeState()?.agents?.['main']?.replay ?? []) as unknown as ReplayRecord[];
  for (const notification of projectReplay(params.sessionId, records)) {
    await entry.bridge.post(notification);
  }
  await entry.bridge.flush();
  const { configOptions, modes } = await surface(state, session);
  scheduleSurfaceUpdates(entry);
  log.info('acp: session loaded', { sessionId: params.sessionId, records: records.length });
  return { configOptions, modes };
}

/** `session/resume`: bind the engine session without replaying history. */
export async function resumeSession(
  state: AgentState,
  params: ResumeSessionRequest,
): Promise<ResumeSessionResponse> {
  const harness = await harnessOf(state);
  const bootstrap = await warmClientMcpServers(harness, params.cwd, params.mcpServers ?? []);
  const session = await harness.resumeSession({
    id: params.sessionId,
    ...(params.additionalDirectories === undefined || params.additionalDirectories.length === 0
      ? {}
      : { additionalDirs: params.additionalDirectories }),
  });
  if (bootstrap !== undefined) state.mcpBootstrap.set(session.id, bootstrap);
  const entry = await registerSession(state, session);
  const { configOptions, modes } = await surface(state, session);
  scheduleSurfaceUpdates(entry);
  log.info('acp: session resumed', { sessionId: params.sessionId });
  return { configOptions, modes };
}

/** `session/list`: the engine's session summaries for the client's picker. */
export async function listSessions(state: AgentState, params: ListSessionsRequest): Promise<ListSessionsResponse> {
  const harness = await harnessOf(state);
  const sessions = await harness.listSessions({
    ...(params.cwd === undefined || params.cwd === null ? {} : { workDir: params.cwd }),
  });
  return {
    sessions: sessions.map((summary) => ({
      sessionId: summary.id,
      cwd: summary.workDir,
      ...(summary.title === undefined ? {} : { title: summary.title }),
      updatedAt: new Date(summary.updatedAt).toISOString(),
    })),
  };
}

export async function deleteSession(
  state: AgentState,
  params: DeleteSessionRequest,
): Promise<DeleteSessionResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry !== undefined) {
    await entry.bridge.dispose();
    state.sessions.delete(params.sessionId);
  }
  await closeMcpBootstrap(state, params.sessionId);
  await closeMcpBridges(state, params.sessionId);
  const harness = await harnessOf(state);
  await harness.deleteSession(params.sessionId);
  log.info('acp: session deleted', { sessionId: params.sessionId });
  return {};
}

export async function closeSession(state: AgentState, params: CloseSessionRequest): Promise<CloseSessionResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry !== undefined) {
    await entry.bridge.dispose();
    state.sessions.delete(params.sessionId);
  }
  await closeMcpBootstrap(state, params.sessionId);
  await closeMcpBridges(state, params.sessionId);
  return {};
}

/** `session/fork`: a new engine session seeded from this one's history. */
export async function forkSession(state: AgentState, params: ForkSessionRequest): Promise<ForkSessionResponse> {
  const harness = await harnessOf(state);
  const bootstrap = await warmClientMcpServers(harness, params.cwd, params.mcpServers ?? []);
  const forked = await harness.forkSession({ id: params.sessionId });
  if (bootstrap !== undefined) state.mcpBootstrap.set(forked.id, bootstrap);
  const entry = await registerSession(state, forked);
  scheduleSurfaceUpdates(entry);
  log.info('acp: session forked', { from: params.sessionId, to: forked.id });
  return { sessionId: forked.id };
}

/** `session/set_mode`: permission mode + plan mode as one choice. */
async function setMode(state: AgentState, params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry === undefined) throw RequestError.invalidParams(undefined, 'unknown session');
  const modeId = String(params.modeId);
  if (!isAcpModeId(modeId)) throw RequestError.invalidParams(undefined, `unknown mode: ${modeId}`);
  await applyMode(entry.session, modeId);
  await entry.bridge.post({
    sessionId: params.sessionId,
    update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
  });
  const { configOptions } = await surface(state, entry.session);
  await entry.bridge.post({
    sessionId: params.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions },
  });
  return {};
}

async function applyMode(session: KimiSession, modeId: 'default' | 'plan' | 'auto' | 'yolo'): Promise<void> {
  const toggles = acpModeToToggles(modeId);
  await session.setPlanMode(toggles.plan);
  await session.setPermission(toggles.permission);
}

/** `session/set_config_option`: model, thinking level, or mode. */
export async function setConfigOption(
  state: AgentState,
  params: SetSessionConfigOptionRequest,
): Promise<SetSessionConfigOptionResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry === undefined) throw RequestError.invalidParams(undefined, 'unknown session');
  const configId = params.configId;
  const value = typeof params.value === 'string' ? params.value : String(params.value);
  if (configId === 'model') {
    await entry.session.setModel(value);
  } else if (configId === 'thinking') {
    await entry.session.setThinking(value as never);
  } else if (configId === 'mode') {
    if (!isAcpModeId(value)) throw RequestError.invalidParams(undefined, `unknown mode: ${value}`);
    await applyMode(entry.session, value);
    await entry.bridge.post({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: value },
    });
  } else {
    throw RequestError.invalidParams(undefined, `unknown config option: ${configId}`);
  }
  const { configOptions } = await surface(state, entry.session);
  await entry.bridge.post({
    sessionId: params.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions },
  });
  void entry.bridge.emitUsage();
  return { configOptions };
}

/**
 * `_session/steering`: inject a follow-up into the running turn. When the
 * session is idle, the compatibility default starts a detached turn; a client
 * that opts into `idleBehavior: 'promptRequired'` starts it itself.
 */
export async function steerRequest(state: AgentState, params: SteerRequest): Promise<SteerResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry === undefined) throw RequestError.invalidParams(undefined, 'unknown session');
  const built = await buildPrompt(entry.session, params.prompt);
  if (built.parts.length === 0) throw RequestError.invalidParams(undefined, 'the steer has no content');
  if (!entry.bridge.isBusy()) {
    if (params._meta?.steering?.idleBehavior === 'promptRequired') {
      return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    }
    // Detached, for compatibility with clients that steer into an idle session.
    void entry.bridge.prompt(built.parts).catch((error: unknown) => {
      log.warn('acp: detached steer turn failed', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { outcome: 'startedNewTurn' };
  }
  await entry.bridge.steer(built.parts);
  return { outcome: 'injected' };
}

/**
 * `authenticate`: the terminal auth method opens the device-code flow in the
 * client's terminal; a client that calls `authenticate` directly gets the same
 * flow, with the URL written to this agent's stderr.
 */
export async function authenticate(
  state: AgentState,
  params: AuthenticateRequest,
): Promise<AuthenticateResponse> {
  if (params.methodId !== LOGIN_METHOD_ID) {
    throw RequestError.invalidParams({ methodId: params.methodId }, 'Unknown auth method');
  }
  const harness = await harnessOf(state);
  await harness.auth.login(undefined, {
    onDeviceCode: (authorization) => {
      log.warn('acp: device login required', {
        url: authorization.verificationUriComplete,
        code: authorization.userCode,
      });
    },
  });
  return {};
}

export async function logout(state: AgentState, _params: LogoutRequest): Promise<LogoutResponse> {
  const harness = await harnessOf(state);
  await harness.auth.logout();
  return {};
}

/**
 * The engine asks before a tool runs; ACP asks the client. The answer decides
 * the tool call: approved, approved for the session, rejected, or cancelled
 * when the turn is cancelled while the dialog is open.
 */
function wireApprovals(state: AgentState, bridge: SessionBridge, session: KimiSession): void {
  session.setApprovalHandler(async (request) => {
    const client = state.client;
    const v2 = state.v2Client;
    if (client === undefined && v2 === undefined) return { decision: 'cancelled' };
    const toolCall = bridge.pendingCall(request.toolCallId) ?? {
      toolCallId: `${request.turnId ?? 0}:${request.toolCallId ?? 'unknown'}`,
      title: request.action,
      kind: toolKind(request.toolName),
      status: 'pending' as const,
    };
    const options = [
      { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' as const },
      { optionId: 'approve_session', name: 'Approve for this session', kind: 'allow_always' as const },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' as const },
    ];
    const response =
      client !== undefined
        ? await client.request<RequestPermissionResponse, RequestPermissionRequest>(
            methods.client.session.requestPermission,
            { sessionId: bridge.sessionId, toolCall, options },
          )
        : await v2!.request<{ outcome: { outcome: string; optionId?: string } }>(
            'session/request_permission',
            {
              sessionId: bridge.sessionId,
              title: toolCall.title,
              ...(toolCall.kind === 'execute'
                ? { subject: { command: toolCall.title, cwd: session.workDir } }
                : {}),
              options,
            },
          );
    const outcome = response.outcome as { outcome: string; optionId?: string } | undefined;
    if (outcome === undefined || outcome.outcome === 'cancelled') return { decision: 'cancelled' };
    if (outcome.optionId === 'approve_once') return { decision: 'approved' };
    if (outcome.optionId === 'approve_session') return { decision: 'approved', scope: 'session' };
    return { decision: 'rejected' };
  });
}

/** The engine asks the user a question; ACP elicits a form, or a permission-style choice. */
function wireQuestions(state: AgentState, bridge: SessionBridge, session: KimiSession): void {
  session.setQuestionHandler(async (request) => {
    const client = state.client;
    const question = request.questions[0];
    // v2 questions come from `elicitation/create`, whose form shape differs;
    // until that is wired the engine's question tool is told there is no answer.
    if (client === undefined || question === undefined) return null;
    if (state.capabilities.elicitationForm) {
      const labels = question.options.map((option) => option.label);
      const response = await client.request<CreateElicitationResponse, CreateElicitationRequest>(
        methods.client.elicitation.create,
        {
          sessionId: bridge.sessionId,
          ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
          mode: 'form',
          message: question.question,
          requestedSchema: {
            type: 'object',
            properties: {
              answer: {
                type: 'string',
                title: question.header ?? 'Answer',
                ...(question.body === undefined ? {} : { description: question.body }),
                ...(labels.length === 0 ? {} : { enum: labels }),
              },
            },
            required: ['answer'],
          },
        },
      );
      if (response.action !== 'accept') return null;
      const answer = (response.content as Record<string, unknown> | undefined)?.['answer'];
      return typeof answer === 'string' ? { [question.question]: answer } : null;
    }
    if (question.options.length === 0) return null;
    // No form support: ask as a choice, which every ACP client can render.
    const response = await client.request<RequestPermissionResponse, RequestPermissionRequest>(
      methods.client.session.requestPermission,
      {
        sessionId: bridge.sessionId,
        toolCall: {
          toolCallId: `question:${request.id ?? 'unknown'}`,
          title: question.question,
          kind: 'other',
          status: 'pending',
        },
        options: question.options.map((option, index) => ({
          optionId: `option_${index}`,
          name: option.label,
          kind: 'allow_once' as const,
        })),
      },
    );
    if (response.outcome.outcome !== 'selected') return null;
    const index = Number(response.outcome.optionId.replace('option_', ''));
    const selected = question.options[index];
    return selected === undefined ? null : { [question.question]: selected.label };
  });
}

export async function prompt(
  state: AgentState,
  params: PromptRequest,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry === undefined) throw RequestError.invalidParams(undefined, 'unknown session');
  if (signal.aborted) return { stopReason: 'cancelled' };
  const built = await buildPrompt(entry.session, params.prompt);
  if (built.parts.length === 0) throw RequestError.invalidParams(undefined, 'the prompt has no content');
  const runtime: CommandRuntime = {
    sessionId: entry.session.id,
    session: entry.session,
    harness: await harnessOf(state),
    setMode: (mode) => applyMode(entry.session, mode),
  };
  let parts: readonly PromptPart[] = built.parts;
  const slash = built.text.length === 0 ? null : parseSlashCommand(built.text);
  if (slash !== null) {
    const reply = await runBuiltinCommand(slash.name, slash.args, runtime);
    if (reply !== null) {
      if (reply.text !== undefined) await entry.bridge.note(reply.text);
      if (reply.prompt === undefined) return { stopReason: 'end_turn' };
      parts = [{ type: 'text', text: reply.prompt }];
    } else {
      const plugins = await pluginSlashCommands(entry.session);
      const body = plugins.bodies.get(slash.name);
      if (body !== undefined) {
        parts = [{ type: 'text', text: expandPluginBody(body, slash.args) }];
      }
    }
  }
  // A prompt that arrives while a run is live is steered into it instead of
  // being rejected; the running turn's own updates carry the answer.
  if (entry.bridge.isBusy()) {
    await entry.bridge.steer(parts);
    await entry.bridge.note('Message steered into the running turn.');
    return { stopReason: 'end_turn' };
  }
  const skill = built.text.length === 0 ? undefined : await matchSkill(entry.session, built.text);
  // A protocol-level `$/cancel_request` aborts this request's signal; the run
  // has to be cancelled with it, not left waiting for the model.
  const onAbort = (): void => {
    entry.bridge.cancel();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const stopReason = await entry.bridge.prompt(parts, skill);
    if (stopReason === 'end_turn') {
      void entry.bridge.emitUsage();
      void maybeGenerateTitle(state, entry);
    }
    return { stopReason };
  } catch (error) {
    throw RequestError.invalidRequest(undefined, error instanceof Error ? error.message : String(error));
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * A prompt that starts with `/skill` activates that skill, the way the TUI and
 * Claude Code treat custom slash commands. Unknown names are plain text.
 */
async function matchSkill(
  session: KimiSession,
  text: string,
): Promise<{ name: string; args?: string } | undefined> {
  const match = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  try {
    const skills = await session.listSkills();
    if (!skills.some((skill) => skill.name === name)) return undefined;
  } catch {
    return undefined;
  }
  const args = match[2]?.trim();
  return args === undefined || args.length === 0 ? { name } : { name, args };
}

/**
 * Title generation is best-effort and never delays the turn: the engine emits
 * `session.meta.updated` when it stores the title, and the bridge forwards it
 * as `session_info_update`.
 */
async function maybeGenerateTitle(state: AgentState, entry: SessionEntry): Promise<void> {
  if (entry.titled || entry.titleAttempts >= MAX_TITLE_ATTEMPTS) return;
  entry.titleAttempts += 1;
  try {
    const harness = await harnessOf(state);
    const title = await harness.generateSessionTitle({ id: entry.session.id, source: 'first_turn' });
    if (title !== undefined) entry.titled = true;
  } catch (error) {
    log.warn('acp: session title generation failed', {
      sessionId: entry.session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function cancel(state: AgentState, params: CancelNotification): void {
  state.sessions.get(params.sessionId)?.bridge.cancel();
}

/** Close the MCP-over-ACP bridges owned by a session. */
export async function closeMcpBridges(state: AgentState, sessionId: string): Promise<void> {
  const bridges = state.mcpSessionBridges.get(sessionId) ?? [];
  state.mcpSessionBridges.delete(sessionId);
  for (const bridge of bridges) {
    state.mcpBridges.delete(bridge.connectionId);
    // Tell the client the tunnel is gone before dropping the socket.
    await state.v2Client
      ?.request('mcp/disconnect', { connectionId: bridge.connectionId })
      .catch(() => undefined);
    await bridge.dispose();
  }
}

/** Route a client-initiated MCP message to the bridge that owns the connection. */
export function deliverMcpMessage(
  state: AgentState,
  connectionId: string,
  message: Record<string, unknown>,
): void {
  state.mcpBridges.get(connectionId)?.deliver(message);
}

/** Close the bootstrap session that keeps client MCP servers alive. */
async function closeMcpBootstrap(state: AgentState, sessionId: string): Promise<void> {
  const bootstrap = state.mcpBootstrap.get(sessionId);
  if (bootstrap === undefined) return;
  state.mcpBootstrap.delete(sessionId);
  await bootstrap.close().catch(() => undefined);
}

export async function close(state: AgentState): Promise<void> {
  for (const entry of state.sessions.values()) await entry.bridge.dispose();
  state.sessions.clear();
  await Promise.all([...state.mcpBootstrap.values()].map((bootstrap) => bootstrap.close().catch(() => undefined)));
  state.mcpBootstrap.clear();
  await Promise.all([...state.mcpSessionBridges.values()].flat().map((bridge) => bridge.dispose()));
  state.mcpSessionBridges.clear();
  state.mcpBridges.clear();
  await state.harness?.close();
  state.harness = undefined;
}