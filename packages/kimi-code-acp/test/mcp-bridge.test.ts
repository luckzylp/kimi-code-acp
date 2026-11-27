import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';

import { McpBridge } from '../src/mcp-bridge';

/** Read newline-delimited JSON from a socket until one parses. */
function linesOf(socket: ReturnType<typeof connect>): { messages: unknown[]; onMessage: (cb: (m: unknown) => void) => void } {
  let buffer = '';
  const listeners: Array<(m: unknown) => void> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const parsed = JSON.parse(line);
        for (const listener of listeners) listener(parsed);
      } catch {
        // ignore partial noise
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    messages: [],
    onMessage(cb) {
      listeners.push(cb);
    },
  };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('McpBridge', () => {
  it('forwards proxy requests to the client and writes the result back', async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const bridge = new McpBridge({
      connectionId: 'conn-1',
      request: async (method, params) => {
        requests.push({ method, params });
        return { tools: [{ name: 'echo' }] };
      },
      notify: () => undefined,
    });
    const path = await bridge.listen();
    const socket = connect(path);
    const incoming: unknown[] = [];
    linesOf(socket).onMessage((message) => incoming.push(message));
    await new Promise((resolve) => socket.once('connect', resolve));

    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })}\n`);
    await waitFor(() => incoming.length > 0, 'the bridged response');
    expect(requests).toEqual([{ method: 'tools/list', params: {} }]);
    expect(incoming[0]).toMatchObject({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'echo' }] } });
    socket.destroy();
    await bridge.dispose();
  });

  it('turns notifications into client notifications and errors into JSON-RPC errors', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const bridge = new McpBridge({
      connectionId: 'conn-2',
      request: async () => {
        throw new Error('boom');
      },
      notify: (method, params) => notifications.push({ method, params }),
    });
    const path = await bridge.listen();
    const socket = connect(path);
    const incoming: unknown[] = [];
    linesOf(socket).onMessage((message) => incoming.push(message));
    await new Promise((resolve) => socket.once('connect', resolve));

    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo' } })}\n`);
    await waitFor(() => incoming.length > 0, 'the error response');
    expect(notifications).toEqual([{ method: 'notifications/initialized', params: {} }]);
    expect(incoming[0]).toMatchObject({ id: 9, error: { message: 'boom' } });
    socket.destroy();
    await bridge.dispose();
  });

  it('delivers server-initiated messages to the proxy', async () => {
    const bridge = new McpBridge({
      connectionId: 'conn-3',
      request: async () => null,
      notify: () => undefined,
    });
    const path = await bridge.listen();
    const socket = connect(path);
    const incoming: unknown[] = [];
    linesOf(socket).onMessage((message) => incoming.push(message));
    await new Promise((resolve) => socket.once('connect', resolve));
    bridge.deliver({ method: 'notifications/tools/list_changed' });
    await waitFor(() => incoming.length > 0, 'the forwarded message');
    expect(incoming[0]).toMatchObject({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    socket.destroy();
    await bridge.dispose();
  });
});
