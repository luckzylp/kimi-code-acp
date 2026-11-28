import { describe, expect, it } from 'vitest';

import { displayTitle, isPublishableTitle } from '../src/session';
import { conversationDigest, fallbackTitle, MAX_TITLE_DIGEST_CHARS, resolveTitleModel, withTitleLock } from '../src/title';

describe('conversationDigest', () => {
  const user = (text: string, origin?: { kind: string }) => ({
    role: 'user',
    content: [{ type: 'text', text }],
    ...(origin === undefined ? {} : { origin }),
  });
  const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

  it('summarizes every exchange, not just the first prompt', () => {
    const digest = conversationDigest([
      user('fix the parser'),
      assistant('done, the parser handles quotes now'),
      user('now the linter'),
      assistant('linter passes'),
    ]);
    expect(digest).toBe(
      'user: fix the parser\nassistant: done, the parser handles quotes now\nuser: now the linter\nassistant: linter passes',
    );
  });

  it('keeps the last answer of an exchange, and collapses whitespace', () => {
    const digest = conversationDigest([
      user('  fix\n\nthe   parser '),
      assistant('first answer'),
      assistant('final answer'),
    ]);
    expect(digest).toBe('user: fix the parser\nassistant: final answer');
  });

  it('skips prompts the user did not type', () => {
    const digest = conversationDigest([
      user('continue the goal', { kind: 'system_trigger' }),
      assistant('working'),
      user('what changed?'),
      assistant('the parser'),
    ]);
    expect(digest).toBe('user: what changed?\nassistant: the parser');
  });

  it('keeps both ends when the conversation does not fit', () => {
    const turns = Array.from({ length: 40 }, (_, index) => [
      user(`question ${index} ${'x'.repeat(150)}`),
      assistant(`answer ${index} ${'y'.repeat(150)}`),
    ]).flat();
    const digest = conversationDigest(turns);
    expect(digest).toBeDefined();
    expect(digest!.length).toBeLessThanOrEqual(MAX_TITLE_DIGEST_CHARS);
    expect(digest!.startsWith('user: question 0')).toBe(true);
    expect(digest!.includes('...')).toBe(true);
    expect(digest!.endsWith('y'.repeat(150))).toBe(true);
  });

  it('has nothing to say about a session with no conversation', () => {
    expect(conversationDigest([])).toBeUndefined();
    expect(conversationDigest([user('   ')])).toBeUndefined();
  });
});

describe('displayTitle', () => {
  it('trusts the kind a live or restored session carries', () => {
    expect(displayTitle({ title: '构建脚本工具链', titleKind: 'custom' })).toBe('构建脚本工具链');
    expect(displayTitle({ title: '构建脚本工具链', titleKind: 'generated' })).toBe('构建脚本工具链');
    expect(displayTitle({ title: '帮我看看构建脚本', titleKind: 'replaceable' })).toBeUndefined();
  });

  it('tells a listed placeholder by being exactly the first 200 characters of the prompt', () => {
    const prompt = 'x'.repeat(250);
    expect(displayTitle({ title: prompt.slice(0, 200), lastPrompt: prompt })).toBeUndefined();
    expect(displayTitle({ title: '构建脚本工具链', lastPrompt: '帮我看看这个仓库的构建脚本' })).toBe('构建脚本工具链');
  });

  it('does not mistake a generated title that merely starts like the prompt', () => {
    // A short prompt whose title starts with the same words is a real title.
    expect(displayTitle({ title: '测试', lastPrompt: '测试一下登录流程' })).toBe('测试');
  });

  it('has nothing to show for an untitled session', () => {
    expect(displayTitle(undefined)).toBeUndefined();
    expect(displayTitle({ title: '   ' })).toBeUndefined();
    expect(displayTitle({})).toBeUndefined();
  });
});

describe('withTitleLock', () => {
  it('gives up on a rename the engine never answers, and frees the lock', async () => {
    const holder = { titleLock: Promise.resolve() };
    const started = Date.now();
    await expect(
      withTitleLock(holder, () => new Promise<never>(() => undefined), 20),
    ).rejects.toThrow(/session rename timed out/);
    expect(Date.now() - started).toBeLessThan(500);
    // The next rename is not stuck behind the abandoned one.
    await expect(withTitleLock(holder, async () => 'later', 20)).resolves.toBe('later');
  });

  it('gives up on a lock whose holder never releases it', async () => {
    const holder = { titleLock: new Promise<void>(() => undefined) };
    await expect(withTitleLock(holder, async () => 'x', 20)).rejects.toThrow(/title lock timed out/);
  });
});

describe('isPublishableTitle', () => {
  it('drops the engine placeholder, which is just the first prompt', () => {
    // The engine names an untitled session after its first message so its own
    // list is never empty; a client that showed it would name the thread that.
    expect(isPublishableTitle({ lastPrompt: '帮我看看这个仓库', isCustomTitle: false }, '帮我看看这个仓库')).toBe(false);
  });

  it('keeps a custom title, which is what the adapter rename and /title set', () => {
    expect(isPublishableTitle({ title: '仓库构建脚本工具链', isCustomTitle: true }, '仓库构建脚本工具链')).toBe(true);
  });

  it('keeps a generated title that carries no prompt patch', () => {
    expect(isPublishableTitle(undefined, '仓库构建脚本工具链')).toBe(true);
  });

  it('ignores an update without a title', () => {
    expect(isPublishableTitle({ lastPrompt: 'hi' }, undefined)).toBe(false);
    expect(isPublishableTitle(undefined, '   ')).toBe(false);
  });
});

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
