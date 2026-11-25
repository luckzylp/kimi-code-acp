/**
 * Login (ADR 0001, auth).
 *
 * kimi-code authenticates through a device-code flow against the managed
 * provider. ACP clients start that flow by running the agent with the auth
 * method's args in a terminal (the `terminal` auth method type), so this
 * module implements the flow as a subcommand and advertises it from
 * `initialize`:
 *
 *   AuthMethod { id: 'login', type: 'terminal', args: ['login'] }
 *
 * The flow writes the verification URL and code to stdout, which is what the
 * user needs in the terminal window the client opened.
 */
import type { AuthMethod } from '@agentclientprotocol/sdk';
import { createKimiHarness, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { AGENT_NAME, VERSION } from './version';

export const LOGIN_METHOD_ID = 'login';

export function terminalAuthMethod(): AuthMethod {
  return {
    id: LOGIN_METHOD_ID,
    type: 'terminal',
    name: 'Login with Kimi account',
    description: 'Open the device-code login flow in a terminal.',
    args: ['login'],
    env: {},
  };
}

function harness(): KimiHarness {
  return createKimiHarness({
    identity: { productName: AGENT_NAME, version: VERSION, platform: 'kimi_acp' },
  });
}

/**
 * Run the device-code login in this process's terminal.
 * Returns a process exit code: 0 when logged in, 1 when login failed.
 */
export async function runLogin(write: (text: string) => void = (text) => process.stdout.write(text)): Promise<number> {
  const kimi = harness();
  try {
    const status = await kimi.auth.status();
    const managed = status.providers.find((provider) => provider.providerName === 'managed:kimi-code');
    if (managed?.hasToken === true) {
      write('Already logged in.\n');
      return 0;
    }
    const result = await kimi.auth.login(undefined, {
      onDeviceCode: (authorization) => {
        write(`\nOpen this URL in a browser:\n  ${authorization.verificationUriComplete}\n`);
        if (authorization.userCode.length > 0) {
          write(`and confirm the code: ${authorization.userCode}\n\n`);
        }
        write('Waiting for the login to complete…\n');
      },
    });
    write(`\nLogged in. Default model: ${result.defaultModel}\n`);
    return 0;
  } catch (error) {
    write(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await kimi.close();
  }
}

/** Whether the managed provider already has a token. */
export async function isLoggedIn(kimi: KimiHarness): Promise<boolean> {
  try {
    const status = await kimi.auth.status();
    return status.providers.some(
      (provider) => provider.providerName === 'managed:kimi-code' && provider.hasToken,
    );
  } catch {
    return false;
  }
}
