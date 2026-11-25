/**
 * A minimal ACP client over a child process's stdio, shared by the smoke and
 * end-to-end scripts. It speaks just enough JSON-RPC for an agent handshake:
 * requests with ids, notifications, and a queue of everything the agent sends.
 */
import { spawn } from 'node:child_process';

export class AcpChild {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    /** Requests the agent sent to us (permission, elicitation, fs, terminal). */
    this.requests = [];
    this.handlers = new Map();
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim().length === 0) continue;
        process.stderr.write(`[agent] ${line}\n`);
      }
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line);
      if (message.method !== undefined && message.id === undefined) {
        this.notifications.push(message);
        continue;
      }
      if (message.method !== undefined && message.id !== undefined) {
        this.answer(message);
        continue;
      }
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (waiter === undefined) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  }

  /** Register the client half of a method the agent calls. */
  onRequest(method, handler) {
    this.handlers.set(method, handler);
  }

  /** Requests of one method the agent sent, in order. */
  requestsOf(method) {
    return this.requests.filter((request) => request.method === method).map((request) => request.params);
  }

  answer(message) {
    this.requests.push({ method: message.method, params: message.params });
    const handler = this.handlers.get(message.method);
    Promise.resolve(handler === undefined ? undefined : handler(message.params)).then(
      (result) => {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      },
      (error) => {
        this.child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } })}\n`,
        );
      },
    );
  }

  /** Send a request and keep its JSON-RPC id, so a test can cancel it. */
  beginRequest(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const promise = new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs).unref();
    });
    return { id, promise };
  }

  request(method, params, timeoutMs = 60_000) {
    return this.beginRequest(method, params, timeoutMs).promise;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Every `session/update` update object received so far, in order. */
  sessionUpdates() {
    return this.notifications
      .filter((message) => message.method === 'session/update')
      .map((message) => message.params.update);
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolvePromise();
      }, 15_000);
      this.child.on('close', (code) => {
        clearTimeout(timer);
        process.stderr.write(`[acp] agent exited with ${code}\n`);
        resolvePromise();
      });
    });
  }
}

/** Spawn the built bundle as an ACP agent. */
export function spawnAgent(mainPath, { homeDir, env = {} } = {}) {
  const child = spawn(process.execPath, [mainPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(homeDir === undefined ? {} : { KIMI_CODE_HOME: homeDir }), ...env },
  });
  return new AcpChild(child);
}