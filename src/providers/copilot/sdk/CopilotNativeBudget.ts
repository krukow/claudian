import { CopilotRuntimeError } from './CopilotRuntimeError';

/** What a bounded native call did, so a caller can tell silence from a refusal. */
export type CopilotNativeOutcome =
  | { readonly kind: 'settled' }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timed-out' };

/**
 * What a bounded native acquisition did, carrying the resource when there is one.
 *
 * A release reports only whether it happened; an acquisition has to hand back what it
 * acquired, because the caller cannot own a client or a session it was never given.
 */
export type CopilotNativeAcquisition<T> =
  | { readonly kind: 'settled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timed-out' };

/**
 * How long any single native call may hold cancellation, failure recovery, shutdown, or
 * disposal.
 *
 * Aborting a turn, releasing a session, and creating a session are the same kind of
 * promise: a runtime that is already up answers, or it does not. One budget covers all of
 * them, so a CLI that stopped answering can never hold Claudian open at whichever of them
 * it happens to be wedged on.
 *
 * Starting a client is not one of them; it runs on {@link NATIVE_STARTUP_TIMEOUT_MS}.
 */
export const NATIVE_OPERATION_TIMEOUT_MS = 5_000;

/** The budget as the seconds a message tells the user about. */
export const NATIVE_OPERATION_TIMEOUT_SECONDS = NATIVE_OPERATION_TIMEOUT_MS / 1_000;

/**
 * How long starting a client may take before the CLI it spawned is killed.
 *
 * A start is not a release. Spawning the executable, waiting for its server to listen, and
 * agreeing a protocol version is cold work that a first launch of the day, a slow disk, or
 * a virus scanner routinely stretches past every other native call's budget.
 * `@github/copilot-sdk` allows thirty seconds for its own half of that wait, so ending the
 * start any sooner only reports a CLI that was still coming up as one that went silent.
 */
export const NATIVE_STARTUP_TIMEOUT_MS = 30_000;

/** The startup budget as the seconds a message tells the user about. */
export const NATIVE_STARTUP_TIMEOUT_SECONDS = NATIVE_STARTUP_TIMEOUT_MS / 1_000;

/**
 * What a native call that outlasted its budget is reported as, named by the step that
 * went silent.
 *
 * Silence is a transport failure wherever it happens: the CLI stopped answering, which
 * says nothing about the step it was asked to run, so acquiring and releasing report it
 * the same way and the caller drops the runtime either way.
 */
export function copilotNativeSilenceError(
  context: string,
  timeoutSeconds: number = NATIVE_OPERATION_TIMEOUT_SECONDS,
): CopilotRuntimeError {
  return new CopilotRuntimeError(
    'transport',
    `${context}: the Copilot CLI did not answer within `
    + `${timeoutSeconds} seconds.`,
  );
}

/**
 * Waits for a native call under the given budget, defaulting to the shared release one,
 * and reports what it did.
 *
 * A rejection that arrives after the budget has already elapsed has no caller left to
 * report it to, so it is absorbed here rather than surfacing as an unhandled rejection or
 * replacing the failure the caller was already given.
 */
export async function settleNativeWithin(
  work: Promise<void>,
  timeoutMs: number = NATIVE_OPERATION_TIMEOUT_MS,
): Promise<CopilotNativeOutcome> {
  let timer: number | undefined;
  const settled = work.then(
    (): CopilotNativeOutcome => ({ kind: 'settled' }),
    (error: unknown): CopilotNativeOutcome => ({ error, kind: 'rejected' }),
  );
  try {
    return await Promise.race([
      settled,
      new Promise<CopilotNativeOutcome>((resolve) => {
        timer = window.setTimeout(() => resolve({ kind: 'timed-out' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * Waits for a native acquisition under the given budget, defaulting to the shared release
 * one, and reports what it produced.
 *
 * A client or a session that arrives after the budget has already elapsed has no caller
 * left to hand it to: the run that asked for it has ended and the caller was already told
 * the runtime went silent. It is released through `releaseLate` where it arrives instead
 * of being left running, and a release that fails there is absorbed for the same reason
 * the late rejection is — nothing is listening any more.
 *
 * `releaseLate` is omitted for an answer that carries nothing to release, such as an
 * authentication status.
 */
export async function acquireNativeWithin<T>(
  work: Promise<T>,
  releaseLate?: (value: T) => Promise<void>,
  timeoutMs: number = NATIVE_OPERATION_TIMEOUT_MS,
): Promise<CopilotNativeAcquisition<T>> {
  let timer: number | undefined;
  let withinBudget = true;
  const acquired = work.then(
    async (value: T): Promise<CopilotNativeAcquisition<T>> => {
      if (!withinBudget && releaseLate) {
        await releaseLate(value).catch(() => undefined);
      }
      return { kind: 'settled', value };
    },
    (error: unknown): CopilotNativeAcquisition<T> => ({ error, kind: 'rejected' }),
  );
  try {
    return await Promise.race([
      acquired,
      new Promise<CopilotNativeAcquisition<T>>((resolve) => {
        timer = window.setTimeout(() => {
          withinBudget = false;
          resolve({ kind: 'timed-out' });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    withinBudget = false;
  }
}
