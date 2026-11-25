/**
 * The ACP agent surface (ADR 0001).
 *
 * M0: initialize, session/new, session/prompt, session/cancel, the run model.
 * M1: tool cards, shadow terminals for commands, permission requests, and
 * elicitation for the engine's questions.
 *
 * Tool execution belongs to the agent (the engine), never to the client: the
 * client renders a card and, for commands, a terminal fed through `_meta`.
 * That removes the whole `terminal/*` reverse-RPC failure class — a dropped
 * client terminal can no longer pin a turn.
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
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  methods,
  RequestError,
} from '@agentclientprotocol/sdk';
import { createKimiHarness, type KimiHarness, type Session as KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { readClientCapabilities, type ClientCapabilities } from './capabilities';
import { log } from './log';
import { SessionBridge } from './session';
import { toolKind } from './tool-calls';
import { AGENT_NAME, VERSION } from './version';

/** ACP protocol version this adapter speaks. Zed negotiates down from v2 on its own. */
const PROTOCOL_VERSION = 1;

interface AgentState {
  capabilities: ClientCapabilities;
  harness: KimiHarness | undefined;
  readonly bridges: Map<string, SessionBridge>;
  client: AgentContext | undefined;
}

export function createAgentApp(): { app: AgentApp; close: () => Promise<void> } {
  const state: AgentState = {
    capabilities: readClientCapabilities(undefined),
    harness: undefined,
    bridges: new Map(),
    client: undefined,
  };

  const app = agent({ name: AGENT_NAME })
    .onConnect((connection) => {
      state.client = connection.client;
    })
    .onRequest('initialize', (context) => initialize(state, context.params))
    .onRequest('session/new', (context) => newSession(state, context.params))
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
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
    },
  };
}

async function harnessOf(state: AgentState): Promise<KimiHarness> {
  state.harness ??= createKimiHarness({
    identity: { productName: AGENT_NAME, version: VERSION, platform: 'kimi_acp' },
  });
  return state.harness;
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
  const session = await harness.createSession({ workDir: params.cwd, model });
  const client = state.client;
  if (client === undefined) throw RequestError.internalError(undefined, 'ACP connection is not bound');
  const bridge = new SessionBridge({
    sessionId: session.id,
    session,
    shadowTerminals: state.capabilities.terminalOutput,
    send: (notification) => client.notify(methods.client.session.update, notification),
  });
  wireApprovals(state, bridge, session);
  wireQuestions(state, bridge, session);
  state.bridges.set(session.id, bridge);
  log.info('acp: session created', { sessionId: session.id, cwd: params.cwd, model });
  return { sessionId: session.id };
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
  const bridge = state.bridges.get(params.sessionId);
  if (bridge === undefined) throw RequestError.invalidParams(undefined, 'unknown session');
  const text = promptText(params);
  if (text.length === 0) throw RequestError.invalidParams(undefined, 'the prompt has no text');
  if (signal.aborted) return { stopReason: 'cancelled' };
  if (state.capabilities.fsRead || state.capabilities.fsWrite) {
    log.debug('acp: client fs capabilities are not used; the engine reads and writes in-process');
  }
  try {
    const stopReason = await bridge.prompt(text);
    return { stopReason };
  } catch (error) {
    throw RequestError.invalidRequest(undefined, error instanceof Error ? error.message : String(error));
  }
}

function cancel(state: AgentState, params: CancelNotification): void {
  state.bridges.get(params.sessionId)?.cancel();
}

function promptText(params: PromptRequest): string {
  const parts: string[] = [];
  for (const block of params.prompt) {
    if (block.type === 'text') parts.push(block.text);
    else log.debug('acp: ignoring non-text prompt block', { type: block.type });
  }
  return parts.join('');
}

async function close(state: AgentState): Promise<void> {
  for (const bridge of state.bridges.values()) await bridge.dispose();
  state.bridges.clear();
  await state.harness?.close();
  state.harness = undefined;
}