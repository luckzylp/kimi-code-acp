import { describe, expect, it } from 'vitest';

import { fallbackTitle, resolveTitleModel } from '../src/title';

describe('resolveTitleModel', () => {
  it('resolves a model that names a provider entry', () => {
    const config = {
      providers: { p: { type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-key' } },
      models: { 'p/model': { provider: 'p', model: 'real-model' } },
      defaultModel: 'p/model',
    } as never;
    expect(resolveTitleModel(config, undefined)).toEqual({
      apiType: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-key',
      model: 'real-model',
    });
  });

  it('falls back to an inline model endpoint', () => {
    const config = {
      providers: {},
      models: {
        fake: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 't', name: 'fake-model' },
      },
      defaultModel: 'fake',
    } as never;
    expect(resolveTitleModel(config, 'fake')).toMatchObject({
      apiType: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 't',
      model: 'fake-model',
    });
  });

  it('uses the session model alias when it is known', () => {
    const config = {
      providers: { p: { type: 'openai_responses', baseUrl: 'https://x/v1' } },
      models: {
        a: { provider: 'p', model: 'm-a' },
        b: { provider: 'p', model: 'm-b' },
      },
      defaultModel: 'a',
    } as never;
    expect(resolveTitleModel(config, 'b')).toMatchObject({ model: 'm-b', apiType: 'openai_responses' });
  });

  it('returns undefined without an endpoint', () => {
    const config = { providers: {}, models: { x: { name: 'm' } }, defaultModel: 'x' } as never;
    expect(resolveTitleModel(config, undefined)).toBeUndefined();
  });
});

describe('fallbackTitle', () => {
  it('takes the first meaningful line without markdown noise', () => {
    expect(fallbackTitle('## Fix the parser\n\nmore text')).toBe('Fix the parser');
    expect(fallbackTitle("'quoted title'")).toBe('quoted title');
    expect(fallbackTitle('   \n\n')).toBeUndefined();
  });

  it('caps the title length', () => {
    const title = fallbackTitle('x'.repeat(200));
    expect(title?.length).toBeLessThanOrEqual(60);
  });
});
