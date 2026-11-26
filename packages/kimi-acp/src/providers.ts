/**
 * `providers/list` (v1 and v2 share the shape).
 *
 * The engine's providers are configured in config.toml and consumed by every
 * model request; ACP only needs to describe them so a client can show which
 * provider a session will use. Mutating them is rejected: the engine has no
 * safe, live provider-write surface for an agent.
 */
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

export interface ProviderInfo {
  readonly providerId: string;
  readonly supported: readonly string[];
  readonly required: boolean;
  readonly current?: { readonly apiType: string; readonly baseUrl: string };
}

export async function listProviders(harness: KimiHarness): Promise<{ providers: ProviderInfo[] }> {
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
  return { providers };
}
