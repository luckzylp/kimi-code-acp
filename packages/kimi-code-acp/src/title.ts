/**
 * Session titles for clients that show them (Zed's thread name, AIR's session
 * index).
 *
 * The engine's own `generateSessionTitle` only runs against the managed Kimi
 * Code OAuth provider — for every other provider it returns `provider_unavailable`,
 * which is why a custom-endpoint user never sees a generated title. The adapter
 * therefore asks the session's own model for a short title after the first
 * completed turn, and falls back to a trimmed first message when the provider
 * cannot answer (unsupported protocol, network error).
 */
import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { log } from './log';


const MAX_TITLE_CHARS = 60;
/** A rename that neither answers nor fails in this time is given up on. */
const TITLE_TIMEOUT_MS = 10_000;
/** A reasoning model spends most of a short request thinking before it answers. */
const REQUEST_TIMEOUT_MS = 30_000;
const ATTEMPTS = 2;

interface ResolvedModel {
  readonly apiType: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly model: string;
}

export function resolveTitleModel(
  config: KimiConfig,
  alias: string | undefined,
): ResolvedModel | undefined {
  const models = (config.models ?? {}) as Record<string, Record<string, unknown>>;
  const modelAlias = alias !== undefined && models[alias] !== undefined ? alias : config.defaultModel;
  const entry = modelAlias === undefined ? undefined : models[modelAlias];
  if (entry === undefined) return undefined;
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  const providerId = typeof entry['provider'] === 'string' ? entry['provider'] : undefined;
  const provider = providerId === undefined ? undefined : providers[providerId];
  // Older/simple configs keep the endpoint on the model itself; treat that as
  // an implicit provider.
  const source = provider ?? entry;
  const baseUrl = typeof source['baseUrl'] === 'string' ? source['baseUrl'] : undefined;
  if (baseUrl === undefined) return undefined;
  const apiKeyEnv = typeof source['apiKeyEnv'] === 'string' ? source['apiKeyEnv'] : undefined;
  const apiKey =
    typeof source['apiKey'] === 'string'
      ? source['apiKey']
      : apiKeyEnv === undefined
        ? undefined
        : process.env[apiKeyEnv];
  const model =
    typeof entry['model'] === 'string'
      ? entry['model']
      : typeof entry['name'] === 'string'
        ? entry['name']
        : (modelAlias ?? 'model');
  return {
    apiType:
      typeof source['type'] === 'string'
        ? source['type']
        : typeof source['protocol'] === 'string'
          ? source['protocol']
          : 'openai',
    baseUrl,
    apiKey,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(source['customHeaders'] === undefined
      ? {}
      : { customHeaders: source['customHeaders'] as Record<string, string> }),
    model,
  };
}

const SYSTEM_PROMPT =
  'Create a short title (at most 6 words) that summarizes this conversation. ' +
  'Reply with the title only: no quotes, no markdown, no trailing period.';

/** How much of the conversation a title is generated from (the engine's digest). */
export const MAX_TITLE_DIGEST_CHARS = 3_000;
const DIGEST_USER_CHARS = 200;
const DIGEST_ASSISTANT_CHARS = 200;

/** The parts of a conversation message this module reads. */
interface DigestMessage {
  readonly role: string;
  readonly content: readonly { readonly type: string; readonly text?: string | undefined }[];
  readonly origin?: { readonly kind?: string | undefined } | undefined;
}

/** Prompt origins the user did not type: their text is not the conversation's subject. */
const AUTONOMOUS_ORIGINS: ReadonlySet<string> = new Set([
  'system_trigger',
  'cron_job',
  'cron_missed',
  'injection',
  'shell_command',
]);

function textOf(message: DigestMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The whole conversation as a title is generated from, shaped like the engine's
 * own digest: `user: …` / `assistant: …` per exchange, each side cut short, the
 * ends kept when the whole thing does not fit.
 */
export function conversationDigest(messages: readonly DigestMessage[]): string | undefined {
  const turns: string[][] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const origin = message.origin?.kind;
      if (origin !== undefined && AUTONOMOUS_ORIGINS.has(origin)) continue;
      const text = textOf(message);
      if (text.length === 0) continue;
      turns.push([`user: ${text.slice(0, DIGEST_USER_CHARS)}`]);
      continue;
    }
    if (message.role !== 'assistant' || turns.length === 0) continue;
    const text = textOf(message);
    if (text.length === 0) continue;
    const turn = turns[turns.length - 1]!;
    // The last answer of the exchange is the one worth summarizing.
    if (turn.length === 1) turn.push(`assistant: ${text.slice(0, DIGEST_ASSISTANT_CHARS)}`);
    else turn[1] = `assistant: ${text.slice(0, DIGEST_ASSISTANT_CHARS)}`;
  }
  if (turns.length === 0) return undefined;
  const joined = turns.flat().join('\n');
  if (joined.length <= MAX_TITLE_DIGEST_CHARS) return joined;
  const marker = '...';
  let budget = MAX_TITLE_DIGEST_CHARS - marker.length - 2;
  const head: string[] = [];
  for (const line of turns[0]!) {
    if (budget < line.length + 1) break;
    head.push(line);
    budget -= line.length + 1;
  }
  const tail: string[] = [];
  for (let index = turns.length - 1; index >= 1; index -= 1) {
    const group = turns[index]!;
    const cost = group.reduce((sum, line) => sum + line.length + 1, 0);
    if (budget < cost) break;
    tail.unshift(...group);
    budget -= cost;
  }
  return [...head, marker, ...tail].join('\n');
}

function sanitize(raw: string): string | undefined {
  const first = raw
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find((line) => line.length > 0);
  if (first === undefined) return undefined;
  const unquoted = first.replace(/^[`"'“‘]+|[`"'”’]+$/g, '').trim();
  const title = unquoted.replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim();
  return title.length === 0 ? undefined : title.slice(0, MAX_TITLE_CHARS);
}

/** A readable fallback when the provider cannot generate one. */
export function fallbackTitle(firstUserText: string): string | undefined {
  const line = firstUserText
    .split('\n')
    .map((entry) => entry.replace(/^[#>*\-\s]+/, '').trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? undefined : sanitize(line);
}

async function requestTitle(
  model: ResolvedModel,
  firstUserText: string,
): Promise<string | undefined> {
  if (model.baseUrl === undefined) return undefined;
  const base = model.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(model.customHeaders ?? {}),
  };
  if (model.apiKey !== undefined && model.apiKey.length > 0) {
    headers['authorization'] = `Bearer ${model.apiKey}`;
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const userText = firstUserText.slice(0, 2_000);

  if (model.apiType === 'openai_responses') {
    const response = await fetch(`${base}/responses`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: model.model,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: `${SYSTEM_PROMPT}\n\n${userText}` }],
          },
        ],
        max_output_tokens: 512,
      }),
    });
    if (!response.ok) {
      log.warn('acp: title request failed', {
        apiType: model.apiType,
        status: response.status,
        body: (await response.text()).slice(0, 200),
      });
      return undefined;
    }
    const body = (await response.json()) as {
      output_text?: unknown;
      output?: readonly { content?: readonly { text?: unknown }[] }[];
    };
    if (typeof body.output_text === 'string') return sanitize(body.output_text);
    const text = (body.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join(' ');
    return text.length === 0 ? undefined : sanitize(text);
  }

  if (model.apiType !== 'openai' && model.apiType !== 'kimi') return undefined;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: model.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      // Reasoning models spend the budget on reasoning first: 32 tokens left
      // deepseek returning an empty `content` (the title never appeared). 512
      // is enough for a short reasoning pass plus the title.
      max_tokens: 512,
      temperature: 0.2,
      stream: false,
    }),
  });
  if (!response.ok) {
    log.warn('acp: title request failed', {
      apiType: model.apiType,
      status: response.status,
      body: (await response.text()).slice(0, 200),
    });
    return undefined;
  }
  const payload = (await response.json()) as {
    choices?: readonly { message?: { content?: unknown } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (process.env['KIMI_ACP_TITLE_DEBUG'] === '1') {
    log.info('acp: title response', {
      status: response.status,
      content: typeof content === 'string' ? content.slice(0, 80) : null,
    });
  }
  return typeof content === 'string' ? sanitize(content) : undefined;
}

/** A session whose renames are serialized through `withTitleLock`. */
export interface TitleLockHolder {
  titleLock: Promise<void>;
}

function bounded<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs).unref?.();
    }),
  ]);
}

/**
 * Run one rename with the session's title lock held, so the last writer is
 * the user's. Both the wait for the lock and the rename itself are bounded: a
 * rename the engine never answers must not block every later one. Giving up
 * does not cancel the rename — if it lands after all, it can still overwrite
 * what was applied meanwhile, which is the price of not waiting forever.
 */
export async function withTitleLock<T>(
  holder: TitleLockHolder,
  rename: () => Promise<T>,
  timeoutMs: number = TITLE_TIMEOUT_MS,
): Promise<T> {
  const previous = holder.titleLock;
  let release = (): void => undefined;
  holder.titleLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await bounded(previous, timeoutMs, 'title lock');
    return await bounded(rename(), timeoutMs, 'session rename');
  } finally {
    release();
  }
}

/**
 * Ask the session's model for a title. Returns undefined when the provider
 * cannot serve it; callers then decide whether to use `fallbackTitle`.
 */
export async function generateTitle(
  config: KimiConfig,
  modelAlias: string | undefined,
  firstUserText: string,
): Promise<string | undefined> {
  const model = resolveTitleModel(config, modelAlias);
  if (model === undefined) return undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const title = await requestTitle(model, firstUserText);
      if (title !== undefined) return title;
    } catch {
      // A timeout or a dropped connection is worth one more try; the caller
      // falls back to the first message only after both attempts fail.
    }
    if (attempt < ATTEMPTS) log.info('acp: retrying title request', { attempt, model: model.model });
  }
  return undefined;
}
