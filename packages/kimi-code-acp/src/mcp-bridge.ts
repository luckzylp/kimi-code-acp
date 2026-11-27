/**
 * MCP-over-ACP bridge (experimental draft v2).
 *
 * A v2 client can host an MCP server itself: the agent asks `mcp/connect`,
 * then tunnels MCP JSON-RPC through `mcp/message`. The engine only speaks
 * stdio/SSE/HTTP, so the adapter runs a small proxy: the engine spawns
 * `kimi-acp mcp-bridge <socket>`, whose stdin/stdout are piped to this Unix
 * socket; here each line is turned into an ACP `mcp/message` request (or a
 * notification for server-initiated traffic) and the answer is written back.
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface McpBridgeOptions {
  readonly connectionId: string;
  /** Agent → client `mcp/message` request; resolves with the MCP result. */
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  /** Agent → client `mcp/message` notification (server-initiated message). */
  readonly notify: (method: string, params: unknown) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpBridge {
  private server: Server | undefined;
  private socket: Socket | undefined;
  private buffer = '';
  private disposed = false;
  private readonly socketPath: string;

  constructor(private readonly options: McpBridgeOptions) {
    this.socketPath = join(tmpdir(), `kimi-acp-mcp-${randomBytes(6).toString('hex')}.sock`);
  }

  get connectionId(): string {
    return this.options.connectionId;
  }

  /** Start listening; resolves with the socket path handed to the proxy. */
  async listen(): Promise<string> {
    this.server = createServer((socket) => {
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => this.consume(chunk));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === undefined) {
        reject(new Error('bridge has no server'));
        return;
      }
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return this.socketPath;
  }

  /** A server-initiated MCP message from the client, written to the proxy. */
  deliver(message: Record<string, unknown>): void {
    if (this.disposed) return;
    this.write({ jsonrpc: '2.0', ...message } as JsonRpcMessage);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.socket?.destroy();
    this.socket = undefined;
    await new Promise<void>((resolve) => {
      const server = this.server;
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    await rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handle(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handle(line: string): void {
    if (process.env['KIMI_ACP_MCP_TRACE'] === '1') process.stderr.write(`mcp-bridge << ${line}\n`);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id === undefined) {
      this.options.notify(message.method, message.params ?? null);
      return;
    }
    const id = message.id;
    void (async () => {
      try {
        const result = await this.options.request(message.method as string, message.params ?? null);
        this.write({ jsonrpc: '2.0', id, result: result ?? null });
      } catch (error) {
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  }

  private write(message: JsonRpcMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    if (process.env['KIMI_ACP_MCP_TRACE'] === '1') process.stderr.write(`mcp-bridge >> ${line}`);
    this.socket?.write(line);
  }
}