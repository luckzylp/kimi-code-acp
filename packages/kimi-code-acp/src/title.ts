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
const REQUEST_TIMEOUT_MS = 10_000;

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
  'Create a short title (at most 6 words) for the conversation that starts with the ' +
  "user's message. Reply with the title only: no quotes, no markdown, no trailing period.";

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
  try {
    return await requestTitle(model, firstUserText);
  } catch {
    return undefined;
  }
}
