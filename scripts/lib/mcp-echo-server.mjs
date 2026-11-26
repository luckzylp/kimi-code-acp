#!/usr/bin/env node
/**
 * A minimal stdio MCP server for the end-to-end tests: one `echo` tool.
 *
 * Implements just enough of the MCP wire protocol (initialize, tools/list,
 * tools/call, ping) to prove that a client-declared MCP server reaches the
 * model as a callable tool.
 */
import { createInterface } from 'node:readline';

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const tools = [
  {
    name: 'echo',
    description: 'Echo the given text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // notifications need no answer
  const reply = (result) => write({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      });
      break;
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({ tools });
      break;
    case 'tools/call': {
      const args = message.params?.arguments ?? {};
      reply({ content: [{ type: 'text', text: String(args.text ?? '') }], isError: false });
      break;
    }
    default:
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
