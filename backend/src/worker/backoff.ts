// ASSUMPTION: Uses exponential backoff with equal jitter ([cap/2, cap]) where
// cap = min(backoffMaxMs, backoffBaseMs * 2^(attemptsInBudget - 1)).
// Equal jitter prevents thundering-herd retries while guaranteeing a predictable minimum backoff gap.
export function computeBackoffDelayMs(
  attemptsInBudget: number,
  backoffBaseMs: number,
  backoffMaxMs: number,
  randomFn: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptsInBudget - 1);
  const cap = Math.min(backoffMaxMs, backoffBaseMs * 2 ** exponent);
  return Math.floor(cap / 2 + randomFn() * (cap / 2));
}
