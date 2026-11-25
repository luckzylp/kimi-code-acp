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
  type SessionConfigOption,
  type SessionModeState,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  methods,
  RequestError,
} from '@agentclientprotocol/sdk';
import { createKimiHarness, type KimiHarness, type Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { LOGIN_METHOD_ID, terminalAuthMethod } from './auth';
import { readClientCapabilities, type ClientCapabilities } from './capabilities';
import {
  ACP_MODES,
  acpModeToToggles,
  buildConfigOptions,
  isAcpModeId,
  modeOf,
  modelEntries,
} from './config-options';
import { log } from './log';
import { buildPrompt } from './prompt';
import { projectReplay, type ReplayRecord } from './replay';
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

interface AgentState {
  capabilities: ClientCapabilities;
  harness: KimiHarness | undefined;
  readonly sessions: Map<string, SessionEntry>;
  client: AgentContext | undefined;
}

export function createAgentApp(): { app: AgentApp; close: () => Promise<void> } {
  const state: AgentState = {
    capabilities: readClientCapabilities(undefined),
    harness: undefined,
    sessions: new Map(),
    client: undefined,
  };

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
    .onRequest('logout', (context) => logout(state, context.params))
    .onRequest('session/set_mode', (context) => setMode(state, context.params))
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
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
    },
    authMethods: [terminalAuthMethod()],
  };
}

async function harnessOf(state: AgentState): Promise<KimiHarness> {
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

async function newSession(state: AgentState, params: NewSessionRequest): Promise<NewSessionResponse> {
  const harness = await harnessOf(state);
  const config = await harness.getConfig();
  const model = config.defaultModel;
  if (model === undefined) {
    throw RequestError.authRequired(
      undefined,
      'No model configured. Run `kimi` once to log in, or set default_model in config.toml.',
    );
  }
  if (params.mcpServers.length > 0) {
    // M2: the client's MCP servers arrive with the session; the engine's own
    // config still applies, so the session works without them.
    log.warn('acp: client MCP servers are not wired yet', { count: params.mcpServers.length });
  }
  const session = await harness.createSession({ workDir: params.cwd, model });
  const entry = await registerSession(state, session);
  const { configOptions, modes } = await surface(state, session);
  log.info('acp: session created', { sessionId: session.id, cwd: params.cwd, model });
  scheduleSurfaceUpdates(entry);
  return { sessionId: session.id, configOptions, modes };
}

/** Bind one engine session to the ACP session id and its handlers. */
async function registerSession(state: AgentState, session: KimiSession): Promise<SessionEntry> {
  const client = state.client;
  if (client === undefined) throw RequestError.internalError(undefined, 'ACP connection is not bound');
  const existing = state.sessions.get(session.id);
  if (existing !== undefined) return existing;
  const bridge = new SessionBridge({
    sessionId: session.id,
    session,
    shadowTerminals: state.capabilities.terminalOutput,
    send: (notification) => client.notify(methods.client.session.update, notification),
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
    void entry.bridge.emitCommands();
    void entry.bridge.emitUsage();
  }, 0);
}

/**
 * `session/load`: resume the engine session and replay its persisted history
 * as the same updates a live turn produces, before the response.
 */
async function loadSession(state: AgentState, params: LoadSessionRequest): Promise<LoadSessionResponse> {
  const harness = await harnessOf(state);
  const session = await harness.resumeSession({ id: params.sessionId, replayTurnLimit: 200 });
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
async function resumeSession(
  state: AgentState,
  params: ResumeSessionRequest,
): Promise<ResumeSessionResponse> {
  const harness = await harnessOf(state);
  const session = await harness.resumeSession({ id: params.sessionId });
  const entry = await registerSession(state, session);
  const { configOptions, modes } = await surface(state, session);
  scheduleSurfaceUpdates(entry);
  log.info('acp: session resumed', { sessionId: params.sessionId });
  return { configOptions, modes };
}

/** `session/list`: the engine's session summaries for the client's picker. */
async function listSessions(state: AgentState, params: ListSessionsRequest): Promise<ListSessionsResponse> {
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

async function deleteSession(
  state: AgentState,
  params: DeleteSessionRequest,
): Promise<DeleteSessionResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry !== undefined) {
    await entry.bridge.dispose();
    state.sessions.delete(params.sessionId);
  }
  const harness = await harnessOf(state);
  await harness.deleteSession(params.sessionId);
  log.info('acp: session deleted', { sessionId: params.sessionId });
  return {};
}

async function closeSession(state: AgentState, params: CloseSessionRequest): Promise<CloseSessionResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry !== undefined) {
    await entry.bridge.dispose();
    state.sessions.delete(params.sessionId);
  }
  return {};
}

/** `session/fork`: a new engine session seeded from this one's history. */
async function forkSession(state: AgentState, params: ForkSessionRequest): Promise<ForkSessionResponse> {
  const harness = await harnessOf(state);
  const forked = await harness.forkSession({ id: params.sessionId });
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
async function setConfigOption(
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
 * `authenticate`: the terminal auth method opens the device-code flow in the
 * client's terminal; a client that calls `authenticate` directly gets the same
 * flow, with the URL written to this agent's stderr.
 */
async function authenticate(
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

async function logout(state: AgentState, _params: LogoutRequest): Promise<LogoutResponse> {
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
    if (client === undefined) return { decision: 'cancelled' };
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
    const response = await client.request<RequestPermissionResponse, RequestPermissionRequest>(
      methods.client.session.requestPermission,
      { sessionId: bridge.sessionId, toolCall, options },
    );
    const outcome = response.outcome;
    if (outcome.outcome === 'cancelled') return { decision: 'cancelled' };
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

async function prompt(
  state: AgentState,
  params: PromptRequest,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const entry = state.sessions.get(params.sessionId);
  if (entry === undefined) throw RequestError.invalidParams(undefined, 'unknown session');
  if (signal.aborted) return { stopReason: 'cancelled' };
  const built = await buildPrompt(entry.session, params.prompt);
  if (built.parts.length === 0) throw RequestError.invalidParams(undefined, 'the prompt has no content');
  const skill = built.text.length === 0 ? undefined : await matchSkill(entry.session, built.text);
  try {
    const stopReason = await entry.bridge.prompt(built.parts, skill);
    if (stopReason === 'end_turn') {
      void entry.bridge.emitUsage();
      void maybeGenerateTitle(state, entry);
    }
    return { stopReason };
  } catch (error) {
    throw RequestError.invalidRequest(undefined, error instanceof Error ? error.message : String(error));
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

function cancel(state: AgentState, params: CancelNotification): void {
  state.sessions.get(params.sessionId)?.bridge.cancel();
}

async function close(state: AgentState): Promise<void> {
  for (const entry of state.sessions.values()) await entry.bridge.dispose();
  state.sessions.clear();
  await state.harness?.close();
  state.harness = undefined;
}