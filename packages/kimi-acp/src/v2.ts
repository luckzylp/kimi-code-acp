/**
 * ACP v2 (experimental draft) entry point.
 *
 * v2 keeps the same JSON-RPC envelope but renames several methods
 * (`auth/login`, `auth/logout`) and changes the update vocabulary
 * (`tool_call_update` only, `plan_update`, native terminal updates, explicit
 * `state_update` foreground states, and a `session/prompt` response without a
 * stop reason). This module serves v2 by delegating to the same engine session
 * machinery as v1; `v2-updates.ts` translates the updates.
 *
 * Advertised but not yet served: `mcp/*` (MCP-over-ACP), `nes/*` and
 * `document/*` (editor features a chat agent does not use). `providers/*` are
 * served read-only and mapped from the engine's configured providers.
 */
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';

import {
  authenticate,
  cancel,
  closeSession,
  deliverMcpMessage,
  deleteSession,
  forkSession,
  harnessOf,
  listSessions,
  logout,
  newSession,
  prompt,
  resumeSession,
  setConfigOption,
  steerRequest,
  type AgentState,
} from './agent';
import { LOGIN_METHOD_ID } from './auth';
import { log } from './log';
import { McpBridge } from './mcp-bridge';
import { parseSteerRequest, STEER_METHOD } from './steering';
import { stateUpdate, toV2ConfigOptions } from './v2-updates';
import { AGENT_NAME, VERSION } from './version';

const V2_PROTOCOL_VERSION = 2;

export function createV2App(state: AgentState): { app: v2.AgentApp } {
  const app = v2
    .agent({ name: AGENT_NAME })
    .onConnect((connection) => {
      state.v2Client = {
        notify: (method, params) => connection.client.notify(method as never, params as never),
        request: <Response>(method: string, params: unknown) =>
          connection.client.request<Response>(method as never, params as never),
      };
    })
    .onRequest('initialize', (context) => initialize(context.params))
    .onRequest('session/new', (context) => newSessionV2(state, context.params))
    .onRequest('session/resume', (context) => resumeSessionV2(state, context.params))
    .onRequest('session/fork', (context) => forkSessionV2(state, context.params))
    .onRequest('session/list', (context) => listSessionsV2(state, context.params))
    .onRequest('session/delete', (context) => deleteSessionV2(state, context.params))
    .onRequest('session/close', (context) => closeSessionV2(state, context.params))
    .onRequest('session/set_config_option', (context) => setConfigOptionV2(state, context.params))
    .onRequest('session/prompt', (context) => promptV2(state, context.params, context.signal))
    .onRequest('providers/list', () => listProviders(state))
    .onRequest('providers/set', () => {
      throw v2.RequestError.invalidParams(undefined, 'provider management is not supported by the kimi engine');
    })
    .onRequest('providers/disable', () => {
      throw v2.RequestError.invalidParams(undefined, 'provider management is not supported by the kimi engine');
    })
    .onRequest('auth/login', (context) => authenticate(state, context.params as never))
    .onRequest('auth/logout', (context) => logout(state, context.params as never))
    .onRequest(STEER_METHOD, parseSteerRequest, (context) => steerRequest(state, context.params))
    .onNotification('mcp/message', (context) => {
      // Server-initiated MCP traffic: hand it to the bridge that owns the
      // connection so the proxy can write it to the engine's MCP client.
      const params = context.params as { connectionId?: string };
      if (typeof params.connectionId === 'string') {
        deliverMcpMessage(state, params.connectionId, params as Record<string, unknown>);
      }
    })
    .onRequest('mcp/message', () => {
      throw v2.RequestError.invalidParams(undefined, 'MCP-over-ACP is not supported yet');
    })
    .onNotification('session/cancel', (context) => {
      cancel(state, context.params as never);
    })
    .onNotification('document/didOpen', () => undefined)
    .onNotification('document/didChange', () => undefined)
    .onNotification('document/didClose', () => undefined)
    .onNotification('document/didSave', () => undefined)
    .onNotification('document/didFocus', () => undefined);
  return { app };
}

function initialize(params: v2.InitializeRequest): v2.InitializeResponse {
  log.info('acp: initialize v2', {
    protocolVersion: params.protocolVersion,
    client: params.info?.name,
  });
  return {
    protocolVersion: V2_PROTOCOL_VERSION,
    info: { name: AGENT_NAME, title: 'kimi-code', version: VERSION },
    capabilities: {
      session: {
        prompt: { image: {}, embeddedContext: {} },
        delete: {},
        fork: {},
        additionalDirectories: {},
      },
    },
    authMethods: [
      {
        // v2 names the identifier `methodId` (v1 called it `id`).
        type: 'terminal',
        methodId: LOGIN_METHOD_ID,
        name: 'Login with Kimi account',
        description: 'Open the device-code login flow in a terminal.',
        args: ['login'],
        env: {},
      } as unknown as v2.AuthMethod,
    ],
    _meta: { steering: { supported: true } },
  };
}

async function newSessionV2(
  state: AgentState,
  params: v2.NewSessionRequest,
): Promise<v2.NewSessionResponse> {
  const requested = ((params as { mcpServers?: readonly unknown[] }).mcpServers ?? []) as readonly Record<
    string,
    unknown
  >[];
  const transportServers = requested.filter((server) => typeof server['serverId'] !== 'string');
  const acpServers = requested.filter((server) => typeof server['serverId'] === 'string');
  const bridges: McpBridge[] = [];
  const synthetic: Record<string, unknown>[] = [];
  if (acpServers.length > 0) {
    const client = state.v2Client;
    if (client === undefined) {
      throw v2.RequestError.invalidParams(undefined, 'no v2 client connection for mcp/connect');
    }
    try {
      for (const server of acpServers) {
        const name = typeof server['name'] === 'string' ? server['name'] : 'acp';
        const { connectionId } = await client.request<{ connectionId: string }>('mcp/connect', {
          serverId: server['serverId'],
        });
        log.info('acp: mcp/connect established', { serverId: server['serverId'], connectionId });
        const bridge = new McpBridge({
          connectionId,
          request: (method, paramsValue) => client.request('mcp/message', { connectionId, method, params: paramsValue }),
          notify: (method, paramsValue) => {
            void client.notify('mcp/message', { connectionId, method, params: paramsValue });
          },
        });
        const socketPath = await bridge.listen();
        bridges.push(bridge);
        state.mcpBridges.set(connectionId, bridge);
        // The engine spawns this proxy as a stdio MCP server; its stdio is
        // piped to the bridge socket.
        synthetic.push({
          name,
          command: process.execPath,
          args: [process.argv[1] ?? '', 'mcp-bridge', socketPath],
          env: [],
        });
      }
    } catch (error) {
      for (const bridge of bridges) {
        state.mcpBridges.delete(bridge.connectionId);
        await bridge.dispose();
      }
      throw error;
    }
  }
  const response = await newSession(state, {
    ...(params as unknown as Record<string, unknown>),
    mcpServers: [...transportServers, ...synthetic],
  } as never);
  if (bridges.length > 0) {
    const existing = state.mcpSessionBridges.get(response.sessionId) ?? [];
    state.mcpSessionBridges.set(response.sessionId, [...existing, ...bridges]);
  }
  return {
    sessionId: response.sessionId as never,
    ...(response.configOptions === undefined
      ? {}
      : {
          configOptions: toV2ConfigOptions(
            response.configOptions as unknown as Record<string, unknown>[],
          ) as never,
        }),
  };
}

async function resumeSessionV2(
  state: AgentState,
  params: v2.ResumeSessionRequest,
): Promise<v2.ResumeSessionResponse> {
  return (await resumeSession(state, params as never)) as never;
}

async function forkSessionV2(
  state: AgentState,
  params: v2.ForkSessionRequest,
): Promise<v2.ForkSessionResponse> {
  return (await forkSession(state, params as never)) as never;
}

async function listSessionsV2(
  state: AgentState,
  params: v2.ListSessionsRequest,
): Promise<v2.ListSessionsResponse> {
  const response = await listSessions(state, params as never);
  return {
    sessions: response.sessions.map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    })) as never,
  };
}

async function deleteSessionV2(
  state: AgentState,
  params: v2.DeleteSessionRequest,
): Promise<v2.DeleteSessionResponse> {
  return (await deleteSession(state, params as never)) as never;
}

async function closeSessionV2(
  state: AgentState,
  params: v2.CloseSessionRequest,
): Promise<v2.CloseSessionResponse> {
  return (await closeSession(state, params as never)) as never;
}

async function setConfigOptionV2(
  state: AgentState,
  params: v2.SetSessionConfigOptionRequest,
): Promise<v2.SetSessionConfigOptionResponse> {
  const response = await setConfigOption(state, params as never);
  return {
    configOptions: toV2ConfigOptions(
      response.configOptions as unknown as Record<string, unknown>[],
    ) as never,
  } as never;
}

async function promptV2(
  state: AgentState,
  params: v2.PromptRequest,
  signal: AbortSignal,
): Promise<v2.PromptResponse | void> {
  await sendState(state, params.sessionId, 'running');
  try {
    await prompt(state, params as never, signal);
    return {};
  } finally {
    await sendState(state, params.sessionId, 'idle');
  }
}

async function sendState(
  state: AgentState,
  sessionId: string,
  value: 'running' | 'idle' | 'requires_action',
): Promise<void> {
  try {
    await state.v2Client?.notify('session/update', {
      sessionId,
      update: stateUpdate(value),
    });
  } catch (error) {
    log.warn('acp: failed to send v2 state update', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `providers/list`: the engine's configured providers, read-only. */
async function listProviders(state: AgentState): Promise<v2.ListProvidersResponse> {
  const harness = await harnessOf(state);
  const config = (await harness.getConfig()) as unknown as {
    providers?: Record<string, { baseUrl?: string; protocol?: string }>;
  };
  const providers = Object.entries(config.providers ?? {}).map(([providerId, provider]) => {
    const apiType = provider.protocol ?? 'openai';
    return {
      providerId,
      supported: [apiType],
      required: false,
      current: { apiType, baseUrl: provider.baseUrl ?? '' },
    };
  });
  return { providers: providers as never };
}