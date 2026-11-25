/**
 * The ACP agent surface (ADR 0001). M0: initialize, session/new, session/prompt,
 * session/cancel. Tool projection, display terminals, permissions, load/replay
 * and the goal/swarm projections are added on top of these seams.
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
  RequestError,
} from '@agentclientprotocol/sdk';
import { createKimiHarness, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { readClientCapabilities, type ClientCapabilities } from './capabilities';
import { log } from './log';
import { SessionBridge } from './session';
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
    throw RequestError.authRequired(undefined, 'No model configured. Run `kimi` once to log in, or set default_model in config.toml.');
  }
  const session = await harness.createSession({ workDir: params.cwd, model });
  const client = state.client;
  if (client === undefined) throw RequestError.internalError(undefined, 'ACP connection is not bound');
  const bridge = new SessionBridge({
    sessionId: session.id,
    session,
    send: (notification) => client.notify('session/update', notification),
  });
  state.bridges.set(session.id, bridge);
  log.info('acp: session created', { sessionId: session.id, cwd: params.cwd, model });
  return { sessionId: session.id };
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
