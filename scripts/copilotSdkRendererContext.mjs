// Blink and Node's AsyncLocalStorage use the same V8 slot in Electron 43.
// The SDK only reads client initialization contexts to reject re-entry. Keep
// its live callback tokens per client instead of installing native async hooks.
export class InitializationCallbacks {
  #callbacks = new Set();

  run(context, callback, ...args) {
    if (context !== undefined) this.#callbacks.add(context);
    try {
      return callback(...args);
    } finally {
      // The SDK marks RPC tokens inactive when it writes their response, and
      // trace tokens inactive when their callback settles.
      for (const token of this.#callbacks) {
        if (!token.active) this.#callbacks.delete(token);
      }
    }
  }

  getStore() {
    let active;
    for (const token of this.#callbacks) {
      if (!token.active) {
        this.#callbacks.delete(token);
      } else if (active && active.sessionId !== token.sessionId) {
        throw new Error('Cannot initialize Copilot sessions while callbacks for multiple sessions are active.');
      } else {
        active = token;
      }
    }
    return active;
  }
}

// Claudian never registers SDK workflows. Do not simulate their async scopes.
export class DisabledWorkflowContext {
  getStore() { throw new Error('Copilot SDK workflow execution is disabled in Claudian.'); }
  run() { throw new Error('Copilot SDK workflow execution is disabled in Claudian.'); }
}
