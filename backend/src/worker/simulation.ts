export type ParsedSimulation =
  | { kind: 'ok'; warning?: string }
  | { kind: 'always_fail' }
  | { kind: 'fail_then_succeed'; failUntilAttempt: number }
  | { kind: 'slow'; seconds: number };

export interface SimulationOutcome {
  succeeded: boolean;
  error?: string;
  warning?: string;
}

const NON_NEGATIVE_DECIMAL_OR_SCI = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_TIMEOUT_CHUNK_MS = 2_147_483_647;

// ASSUMPTION: Directive names are strictly lowercase (`ok`, `always_fail`, `fail_then_succeed:N`, `slow:N`);
// outer whitespace is trimmed, while wrong case, internal whitespace, negative numbers, non-finite values,
// or non-safe integers are treated as unknown and safely fall back to `"ok"` with a warning.
export function parseSimulation(raw?: string): ParsedSimulation {
  if (raw === undefined) {
    return { kind: 'ok' };
  }

  const trimmed = raw.trim();
  if (trimmed === 'ok') {
    return { kind: 'ok' };
  }
  if (trimmed === 'always_fail') {
    return { kind: 'always_fail' };
  }

  if (trimmed.startsWith('fail_then_succeed:')) {
    const arg = trimmed.slice('fail_then_succeed:'.length);
    if (/^\d+$/.test(arg)) {
      const parsed = Number(arg);
      if (Number.isSafeInteger(parsed)) {
        return { kind: 'fail_then_succeed', failUntilAttempt: parsed };
      }
    }
    return {
      kind: 'ok',
      warning: `Unknown or out-of-range simulate directive "${raw}" — treated as "ok"`,
    };
  }

  if (trimmed.startsWith('slow:')) {
    const arg = trimmed.slice('slow:'.length);
    if (NON_NEGATIVE_DECIMAL_OR_SCI.test(arg)) {
      const seconds = Number(arg);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return { kind: 'slow', seconds };
      }
    }
    return {
      kind: 'ok',
      warning: `Unknown or invalid simulate directive "${raw}" — treated as "ok"`,
    };
  }

  return {
    kind: 'ok',
    warning: `Unknown simulate directive "${raw}" — treated as "ok"`,
  };
}

export async function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
    }
    return;
  }

  let remaining = delayMs;
  while (remaining > 0) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
    }

    const chunk = Math.min(remaining, MAX_TIMEOUT_CHUNK_MS);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, chunk);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    remaining -= chunk;
  }
}

export async function executeSimulation(
  directive: ParsedSimulation,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<SimulationOutcome> {
  switch (directive.kind) {
    case 'ok':
      return { succeeded: true, warning: directive.warning };
    case 'always_fail':
      return {
        succeeded: false,
        error: `simulated failure (always_fail, attempt ${attemptNumber})`,
      };
    case 'fail_then_succeed':
      if (attemptNumber <= directive.failUntilAttempt) {
        return {
          succeeded: false,
          error: `simulated failure (attempt ${attemptNumber} of fail_then_succeed:${directive.failUntilAttempt})`,
        };
      }
      return { succeeded: true };
    case 'slow': {
      await abortableSleep(directive.seconds * 1000, signal);
      return { succeeded: true };
    }
  }
}
