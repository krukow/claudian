export interface FakeOwnerWindow {
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export interface FakeOwnerDocument {
  defaultView: FakeOwnerWindow;
}

/**
 * Mirrors the DOM guarantee that an element belongs to a document with a window, for hand-rolled
 * element doubles. The window paints immediately so frame-yielding code resolves on the microtask
 * queue.
 */
export function createFakeOwnerDocument(): FakeOwnerDocument {
  return {
    defaultView: {
      requestAnimationFrame(callback: FrameRequestCallback): number {
        callback(0);
        return 0;
      },
    },
  };
}
