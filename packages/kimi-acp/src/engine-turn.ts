/**
 * Turns the engine starts on its own (ADR 0001, Decision 2.4).
 *
 * The engine launches turns no `session/prompt` asked for: a background task
 * finished, a schedule fired, a goal continued. While a run is live those turns
 * belong to it and are streamed without ceremony. A turn with **no** live run —
 * a notification arriving minutes after the last run settled — is streamed too,
 * but introduced by one line that says what set the agent off; otherwise the
 * thread shows work for no visible reason.
 *
 * `session/load` replays the same stored prompts, so it uses the same wording:
 * live and replayed history must read the same.
 */

const MAX_EXCERPT_CHARS = 200;

/**
 * Origins that start a turn on their own. Everything else stays verbatim:
 * reminders (`injection`) are folded into an existing turn and were never
 * prompts; skill/plugin/shell prompts are user-driven.
 */
const AUTONOMOUS_ORIGIN_KINDS: ReadonlySet<string> = new Set(['task', 'cron_job', 'cron_missed']);

type OriginLike = Record<string, unknown>;

function originKind(origin: unknown): string | undefined {
  const kind = (origin as OriginLike | null | undefined)?.['kind'];
  return typeof kind === 'string' ? kind : undefined;
}

function originField(origin: unknown, key: string): string | undefined {
  const value = (origin as OriginLike | null | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isAutonomousOrigin(origin: unknown): boolean {
  const kind = originKind(origin);
  return kind !== undefined && AUTONOMOUS_ORIGIN_KINDS.has(kind);
}

/**
 * The line that introduces a turn the engine started: what started it and, as
 * far as the prompt says, what happened. `undefined` for a user prompt.
 */
export function describeEngineTurn(origin: unknown, prompt: string | undefined): string | undefined {
  if (originKind(origin) === 'user') return undefined;
  const detail = notificationSummary(prompt) ?? excerpt(prompt);
  return `[kimi-code] The agent continued on its own — ${engineTurnSource(origin)}${
    detail === undefined ? '' : `: ${detail}`
  }`;
}

function engineTurnSource(origin: unknown): string {
  switch (originKind(origin)) {
    case 'task': {
      const status = originField(origin, 'status');
      return `background task ${originField(origin, 'taskId') ?? 'unknown'}${
        status === undefined ? '' : ` ${status}`
      }`;
    }
    case 'cron_job': {
      const cron = originField(origin, 'cron');
      return `scheduled job ${originField(origin, 'jobId') ?? 'unknown'}${cron === undefined ? '' : ` (${cron})`}`;
    }
    case 'cron_missed':
      return 'missed schedule catch-up';
    case 'system_trigger':
      return `system trigger ${originField(origin, 'name') ?? 'unknown'}`;
    case 'hook_result': {
      const event = originField(origin, 'event');
      const blocked = (origin as OriginLike | null | undefined)?.['blocked'] === true;
      return `hook result${event === undefined ? '' : ` (${event})`}${blocked ? ', blocked' : ''}`;
    }
    case 'retry': {
      const trigger = originField(origin, 'trigger');
      return `automatic retry${trigger === undefined ? '' : ` (${trigger})`}`;
    }
    case 'injection':
      return 'an internal reminder';
    default:
      return (originKind(origin) ?? 'internal event').replaceAll('_', ' ');
  }
}

/** The gist of a `<notification>` prompt: its title, first line, and wall time. */
function notificationSummary(prompt: string | undefined): string | undefined {
  if (prompt === undefined || !prompt.startsWith('<notification')) return undefined;
  const title = /^Title: (.+)$/m.exec(prompt)?.[1];
  const wallSeconds = /^Wall time: ([\d.]+) seconds$/m.exec(prompt)?.[1];
  const body = prompt
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith('<') &&
        !/^(Title|Severity|Wall time|Read the output file):?/.test(line) &&
        !/^<\/notification>$/.test(line),
    );
  const ran =
    wallSeconds === undefined || !Number.isFinite(Number(wallSeconds))
      ? ''
      : ` (ran ${String(Math.round(Number(wallSeconds)))}s)`;
  const summary = [title, body].filter((part): part is string => part !== undefined).join(' — ');
  return summary.length === 0 ? undefined : `${summary}${ran}`;
}

/** The first line of any other engine prompt, short enough to read as a caption. */
function excerpt(prompt: string | undefined): string | undefined {
  const line = prompt
    ?.split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined || line === '') return undefined;
  const flat = line.replaceAll(/\s+/g, ' ');
  return flat.length > MAX_EXCERPT_CHARS ? `${flat.slice(0, MAX_EXCERPT_CHARS)}…` : flat;
}
