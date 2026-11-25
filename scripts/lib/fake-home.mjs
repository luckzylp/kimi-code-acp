/** A throwaway KIMI_CODE_HOME with one OpenAI-protocol model, for the test scripts. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function writeFakeHome({ baseUrl = 'http://127.0.0.1:1/v1', apiKey = 'test-token' } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'kimi-acp-home-'));
  writeFileSync(
    join(homeDir, 'config.toml'),
    [
      'defaultModel = "fake"',
      '',
      '[models.fake]',
      'name = "fake-model"',
      'protocol = "openai"',
      `baseUrl = "${baseUrl}"`,
      `apiKey = "${apiKey}"`,
      'maxContextSize = 8192',
      'capabilities = ["image_in"]',
      '',
    ].join('\n'),
    'utf8',
  );
  return homeDir;
}