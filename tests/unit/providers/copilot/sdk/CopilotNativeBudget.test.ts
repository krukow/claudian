import {
  acquireNativeWithin,
  NATIVE_OPERATION_TIMEOUT_MS,
} from '@/providers/copilot/sdk/CopilotNativeBudget';

import { createDeferred } from './FakeCopilotSdkRuntime';

/** Runs the body with fake timers, restoring real ones however it ends. */
async function withFakeTimers(body: () => Promise<void>): Promise<void> {
  jest.useFakeTimers();
  try {
    await body();
  } finally {
    jest.useRealTimers();
  }
}

/** Records rejections Node had no handler for while the body ran. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  try {
    await body();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
  }

  expect(unhandled).toEqual([]);
}

/**
 * Acquiring a client or a session is the same kind of promise as releasing one: the
 * runtime answers, or it does not. The budget covers both, and a resource that arrives
 * once the caller has gone is released where it arrives rather than left running.
 */
describe('acquireNativeWithin', () => {
  it('hands back a resource the runtime produced within the budget', async () => {
    const released: string[] = [];

    const outcome = await acquireNativeWithin(
      Promise.resolve('client-1'),
      async (value: string) => { released.push(value); },
    );

    expect(outcome).toEqual({ kind: 'settled', value: 'client-1' });
    expect(released).toEqual([]);
  });

  it('reports a rejection the runtime raised within the budget', async () => {
    const failure = new Error('the CLI refused to start');
    const arriving = createDeferred<string>();

    const settling = acquireNativeWithin(arriving.promise, async () => {});
    arriving.reject(failure);

    expect(await settling).toEqual({ error: failure, kind: 'rejected' });
  });

  it('releases a resource that arrives after the budget elapsed', async () => {
    await withFakeTimers(async () => {
      const arriving = createDeferred<string>();
      const released: string[] = [];

      const settling = acquireNativeWithin(
        arriving.promise,
        async (value: string) => { released.push(value); },
      );
      await jest.advanceTimersByTimeAsync(NATIVE_OPERATION_TIMEOUT_MS);

      expect(await settling).toEqual({ kind: 'timed-out' });
      expect(released).toEqual([]);

      arriving.resolve('client-1');
      await jest.advanceTimersByTimeAsync(0);

      expect(released).toEqual(['client-1']);
    });
  });

  it('absorbs a rejection that arrives after the budget elapsed', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        const arriving = createDeferred<string>();
        const settling = acquireNativeWithin(arriving.promise, async () => {});
        await jest.advanceTimersByTimeAsync(NATIVE_OPERATION_TIMEOUT_MS);

        expect(await settling).toEqual({ kind: 'timed-out' });

        arriving.reject(new Error('the CLI gave up on the acquisition'));
        await jest.advanceTimersByTimeAsync(0);
      });
    });
  });

  /**
   * The release of a late resource has no caller left to report to either, so a release
   * that fails cannot surface as a rejection nobody handled.
   */
  it('absorbs a late release that fails', async () => {
    await withoutUnhandledRejections(async () => {
      await withFakeTimers(async () => {
        const arriving = createDeferred<string>();
        const settling = acquireNativeWithin(arriving.promise, async () => {
          throw new Error('the late release failed too');
        });
        await jest.advanceTimersByTimeAsync(NATIVE_OPERATION_TIMEOUT_MS);

        expect(await settling).toEqual({ kind: 'timed-out' });

        arriving.resolve('client-1');
        await jest.advanceTimersByTimeAsync(0);
      });
    });
  });

  it('needs no release for an answer that carries nothing to release', async () => {
    await withFakeTimers(async () => {
      const arriving = createDeferred<{ isAuthenticated: boolean }>();
      const settling = acquireNativeWithin(arriving.promise);
      await jest.advanceTimersByTimeAsync(NATIVE_OPERATION_TIMEOUT_MS);

      expect(await settling).toEqual({ kind: 'timed-out' });

      arriving.resolve({ isAuthenticated: true });
      await jest.advanceTimersByTimeAsync(0);
    });
  });
});
