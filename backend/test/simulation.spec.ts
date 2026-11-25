import { computeBackoffDelayMs } from '../src/worker/backoff';
import { executeSimulation, parseSimulation } from '../src/worker/simulation';

describe('parseSimulation', () => {
  it('treats undefined, "ok", and trimmed " ok " as ok without warning', () => {
    expect(parseSimulation(undefined)).toEqual({ kind: 'ok' });
    expect(parseSimulation('ok')).toEqual({ kind: 'ok' });
    expect(parseSimulation('  ok  ')).toEqual({ kind: 'ok' });
  });

  it('parses "always_fail"', () => {
    expect(parseSimulation('always_fail')).toEqual({ kind: 'always_fail' });
    expect(parseSimulation(' always_fail ')).toEqual({ kind: 'always_fail' });
  });

  it('parses "fail_then_succeed:N" for valid safe non-negative integers including 0 and MAX_SAFE_INTEGER', () => {
    expect(parseSimulation('fail_then_succeed:0')).toEqual({
      kind: 'fail_then_succeed',
      failUntilAttempt: 0,
    });
    expect(parseSimulation('fail_then_succeed:2')).toEqual({
      kind: 'fail_then_succeed',
      failUntilAttempt: 2,
    });
    expect(parseSimulation(`fail_then_succeed:${Number.MAX_SAFE_INTEGER}`)).toEqual({
      kind: 'fail_then_succeed',
      failUntilAttempt: Number.MAX_SAFE_INTEGER,
    });
  });

  it('treats huge non-safe-integer or malformed fail_then_succeed:N as ok with warning', () => {
    const cases = [
      'fail_then_succeed:9007199254740992',
      'fail_then_succeed:99999999999999999999999',
      'fail_then_succeed:-1',
      'fail_then_succeed:1.5',
      'fail_then_succeed:abc',
      'fail_then_succeed:',
      'fail_then_succeed: 2',
    ];
    for (const input of cases) {
      const parsed = parseSimulation(input);
      expect(parsed.kind).toBe('ok');
      expect(parsed.kind === 'ok' && parsed.warning).toBeTruthy();
    }
  });

  it('parses "slow:N" for non-negative finite numbers including 0, decimals, and scientific notation', () => {
    expect(parseSimulation('slow:0')).toEqual({ kind: 'slow', seconds: 0 });
    expect(parseSimulation('slow:1.5')).toEqual({ kind: 'slow', seconds: 1.5 });
    expect(parseSimulation('slow:1e3')).toEqual({ kind: 'slow', seconds: 1000 });
    expect(parseSimulation('slow:.25')).toEqual({ kind: 'slow', seconds: 0.25 });
  });

  it('treats negative, non-finite, internal-whitespace, or malformed slow:N as ok with warning', () => {
    const cases = [
      'slow:-1',
      'slow:-0.1',
      'slow:NaN',
      'slow:Infinity',
      'slow:1e400',
      'slow: 1',
      'slow:',
      'slow:abc',
      'slow:1px',
    ];
    for (const input of cases) {
      const parsed = parseSimulation(input);
      expect(parsed.kind).toBe('ok');
      expect(parsed.kind === 'ok' && parsed.warning).toBeTruthy();
    }
  });

  it('treats wrong case and unknown directives as ok with warning', () => {
    const cases = ['OK', 'Always_Fail', 'SLOW:1', 'FAIL_THEN_SUCCEED:1', 'banana', '', '   '];
    for (const input of cases) {
      const parsed = parseSimulation(input);
      expect(parsed.kind).toBe('ok');
      expect(parsed.kind === 'ok' && parsed.warning).toBeTruthy();
    }
  });
});

describe('executeSimulation', () => {
  it('handles fail_then_succeed:2 across attempts', async () => {
    const directive = parseSimulation('fail_then_succeed:2');
    const controller = new AbortController();

    const a1 = await executeSimulation(directive, 1, controller.signal);
    const a2 = await executeSimulation(directive, 2, controller.signal);
    const a3 = await executeSimulation(directive, 3, controller.signal);

    expect(a1.succeeded).toBe(false);
    expect(a1.error).toContain('attempt 1 of fail_then_succeed:2');
    expect(a2.succeeded).toBe(false);
    expect(a3).toEqual({ succeeded: true });
  });

  it('succeeds immediately on fail_then_succeed:0 and slow:0', async () => {
    const controller = new AbortController();
    expect(
      await executeSimulation(parseSimulation('fail_then_succeed:0'), 1, controller.signal),
    ).toEqual({
      succeeded: true,
    });
    expect(await executeSimulation(parseSimulation('slow:0'), 1, controller.signal)).toEqual({
      succeeded: true,
    });
  });

  it('aborts slow sleep promptly when signal aborts', async () => {
    const directive = parseSimulation('slow:10');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Lease lost')), 25);

    await expect(executeSimulation(directive, 1, controller.signal)).rejects.toThrow('Lease lost');
  });
});

describe('computeBackoffDelayMs', () => {
  it('computes exponential backoff with equal jitter bounded by [cap/2, cap]', () => {
    expect(computeBackoffDelayMs(1, 1000, 15000, () => 0)).toBe(500);
    expect(computeBackoffDelayMs(1, 1000, 15000, () => 0.9999)).toBe(999);
    expect(computeBackoffDelayMs(3, 1000, 15000, () => 0)).toBe(2000);
    expect(computeBackoffDelayMs(3, 1000, 15000, () => 0.9999)).toBe(3999);
    expect(computeBackoffDelayMs(10, 1000, 15000, () => 0)).toBe(7500);
    expect(computeBackoffDelayMs(10, 1000, 15000, () => 0.9999)).toBe(14999);
  });
});
