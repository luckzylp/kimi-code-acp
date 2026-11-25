/**
 * ACP session surface: config options and modes (ADR 0001, Decision 4).
 *
 * Zed renders the model, thinking level and mode pickers from these. They are
 * derived from the live engine state on every call — a session can change its
 * model elsewhere (TUI, another window), so nothing here is cached.
 */
import type { SessionConfigOption, SessionConfigSelectOption, SessionMode } from '@agentclientprotocol/sdk';
import type { SessionStatus } from '@moonshot-ai/kimi-code-sdk';

export const ACP_MODES = [
  { id: 'default', name: 'Default', description: 'Manual approvals; tools execute normally.' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning; no tool execution.' },
  { id: 'auto', name: 'Auto', description: 'Auto-approve safe operations.' },
  { id: 'yolo', name: 'YOLO', description: 'Auto-approve everything.' },
] as const satisfies readonly SessionMode[];

export type AcpModeId = (typeof ACP_MODES)[number]['id'];

export function isAcpModeId(value: unknown): value is AcpModeId {
  return value === 'default' || value === 'plan' || value === 'auto' || value === 'yolo';
}

export function acpModeToToggles(id: AcpModeId): { readonly plan: boolean; readonly permission: 'manual' | 'auto' | 'yolo' } {
  switch (id) {
    case 'default':
      return { plan: false, permission: 'manual' };
    case 'plan':
      return { plan: true, permission: 'manual' };
    case 'auto':
      return { plan: false, permission: 'auto' };
    case 'yolo':
      return { plan: false, permission: 'yolo' };
  }
}

/** The mode the engine's status corresponds to. */
export function modeOf(status: SessionStatus): AcpModeId {
  if (status.planMode) return 'plan';
  if (status.permission === 'yolo') return 'yolo';
  if (status.permission === 'auto') return 'auto';
  return 'default';
}

export interface ModelEntry {
  readonly id: string;
  readonly name: string;
  readonly supportEfforts?: readonly string[];
  readonly alwaysThinking?: boolean;
}

function thinkingName(value: string): string {
  return `Thinking ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function buildConfigOptions(
  models: readonly ModelEntry[],
  status: SessionStatus,
): SessionConfigOption[] {
  const current = status.model ?? models[0]?.id ?? '';
  const modelOptions: SessionConfigSelectOption[] = (
    models.some((model) => model.id === current) || current === '' ? models : [{ id: current, name: current, ...( {} ) }, ...models]
  ).map((model) => ({ value: model.id, name: model.name }));

  const entry = models.find((model) => model.id === current);
  const levels = entry?.supportEfforts ?? ['off', 'low', 'medium', 'high'];
  const thinkingOptions: SessionConfigSelectOption[] = levels
    .filter((value) => !(entry?.alwaysThinking === true && value === 'off'))
    .map((value) => ({ value, name: thinkingName(value) }));
  if (status.thinkingEffort !== undefined && !thinkingOptions.some((option) => option.value === status.thinkingEffort)) {
    thinkingOptions.push({ value: status.thinkingEffort, name: thinkingName(status.thinkingEffort) });
  }

  return [
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: current,
      options: modelOptions,
    },
    {
      type: 'select',
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      currentValue: status.thinkingEffort,
      options: thinkingOptions,
    },
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: modeOf(status),
      options: ACP_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
  ];
}

/** The model aliases a session's own config offers, with display names. */
export function modelEntries(config: unknown): ModelEntry[] {
  const models = (config as { models?: Record<string, unknown> } | null | undefined)?.models;
  if (models === undefined || models === null || typeof models !== 'object') return [];
  return Object.entries(models).map(([alias, value]) => {
    const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const name = typeof record['name'] === 'string' && record['name'].length > 0 ? record['name'] : alias;
    const efforts = Array.isArray(record['supportEfforts'])
      ? record['supportEfforts'].filter((item): item is string => typeof item === 'string')
      : undefined;
    const capabilities = Array.isArray(record['capabilities'])
      ? record['capabilities'].filter((item): item is string => typeof item === 'string')
      : [];
    return {
      id: alias,
      name,
      ...(efforts === undefined ? {} : { supportEfforts: efforts }),
      alwaysThinking: capabilities.includes('always_thinking'),
    };
  });
}
