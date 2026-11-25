/**
 * Diagnostics go to stderr: stdout carries the ACP JSON-RPC stream and nothing
 * else. One JSON object per line, so a parent can grep by level or key.
 */
function write(level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, ...ctx });
  process.stderr.write(`${line}\n`);
}

export const log = {
  debug(msg: string, ctx?: Record<string, unknown>): void {
    if (process.env['KIMI_ACP_DEBUG'] === '1') write('debug', msg, ctx);
  },
  info(msg: string, ctx?: Record<string, unknown>): void {
    write('info', msg, ctx);
  },
  warn(msg: string, ctx?: Record<string, unknown>): void {
    write('warn', msg, ctx);
  },
  error(msg: string, ctx?: Record<string, unknown>): void {
    write('error', msg, ctx);
  },
};

/** Keep `console.*` from ever writing into the protocol stream. */
export function redirectConsoleToStderr(): void {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.debug = sink;
  globalThis.console.warn = sink;
}
