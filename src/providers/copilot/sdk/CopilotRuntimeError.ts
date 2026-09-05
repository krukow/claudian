import type { ProviderExecutionErrorCategory } from '../../../core/execution';

/**
 * What a failure leaves unusable behind it, and therefore what the session has to drop
 * before the next turn. `session` drops the live SDK session and keeps the CLI process;
 * `client` drops the process too, so the next turn starts one and re-runs the auth gate.
 */
export type CopilotNativeReset = 'none' | 'session' | 'client';

/**
 * Recoverability is a property of the category, not of the call site that raised it, so
 * the same failure always reports the same thing to chat.
 */
const CATEGORY_RECOVERABILITY: Readonly<Record<ProviderExecutionErrorCategory, boolean>> = {
  authentication: true,
  configuration: false,
  'process-exited': true,
  provider: true,
  'provider-session-missing': true,
  transport: true,
  unknown: true,
};

const CATEGORY_NATIVE_RESET: Readonly<
  Record<ProviderExecutionErrorCategory, CopilotNativeReset>
> = {
  authentication: 'client',
  configuration: 'none',
  'process-exited': 'client',
  provider: 'none',
  'provider-session-missing': 'session',
  transport: 'client',
  unknown: 'none',
};

export function isCopilotRecoverableCategory(
  category: ProviderExecutionErrorCategory,
): boolean {
  return CATEGORY_RECOVERABILITY[category];
}

export function resolveCopilotNativeReset(
  category: ProviderExecutionErrorCategory,
): CopilotNativeReset {
  return CATEGORY_NATIVE_RESET[category];
}

/**
 * Categorized Copilot runtime failure. The category is decided where the failure is
 * observed rather than by matching SDK message text downstream, and it alone decides
 * whether the failure is recoverable and what native state has to be dropped.
 */
export class CopilotRuntimeError extends Error {
  readonly recoverable: boolean;
  readonly missingProviderSessionId: string | undefined;

  constructor(
    readonly category: ProviderExecutionErrorCategory,
    message: string,
    options?: { readonly cause?: unknown; readonly missingProviderSessionId?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CopilotRuntimeError';
    this.recoverable = isCopilotRecoverableCategory(category);
    this.missingProviderSessionId = options?.missingProviderSessionId;
  }

  get nativeReset(): CopilotNativeReset {
    return resolveCopilotNativeReset(this.category);
  }
}

export function copilotAuthenticationError(message: string): CopilotRuntimeError {
  return new CopilotRuntimeError('authentication', message);
}

export function copilotConfigurationError(message: string): CopilotRuntimeError {
  return new CopilotRuntimeError('configuration', message);
}

export function copilotMissingSessionError(
  message: string,
  providerSessionId: string,
): CopilotRuntimeError {
  return new CopilotRuntimeError('provider-session-missing', message, {
    missingProviderSessionId: providerSessionId,
  });
}

const MISSING_SESSION_PATTERN = /session\b[^.]*\b(?:not found|does not exist|missing|unknown)/i;
const TRANSPORT_PATTERN =
  /\b(?:econnrefused|econnreset|epipe|socket|pipe|stream|connection (?:closed|lost)|disconnected|transport)\b/i;
const PROCESS_EXIT_PATTERN =
  /\b(?:process exited|exited with code|terminated|killed|sigterm|sigkill)\b/i;
const AUTHENTICATION_PATTERN =
  /\b(?:unauthorized|unauthenticated|not authenticated|forbidden|invalid token|expired token|401|403)\b/i;
const CONFIGURATION_PATTERN =
  /\b(?:enoent|eacces|not found on PATH|unsupported protocol|protocol version|invalid configuration)\b/i;

/**
 * The shape `CopilotSession.sendAndWait` rejects with when the CLI never reaches idle.
 * The SDK has no typed timeout error, so it is recognized at the one call site that owns
 * the budget rather than by a downstream message match.
 */
const SEND_TIMEOUT_PATTERN = /^Timeout after \d+ms waiting for session\.idle$/;

/**
 * Maps a `send` failure onto the provider contract.
 *
 * A timeout is reported as a transport failure with an actionable message: the CLI is
 * still holding the turn, so the caller aborts it and drops the process rather than
 * reusing a runtime that stopped answering.
 */
export function toCopilotSendError(error: unknown, timeoutMs: number): CopilotRuntimeError {
  if (error instanceof Error && SEND_TIMEOUT_PATTERN.test(error.message)) {
    return new CopilotRuntimeError(
      'transport',
      `Copilot did not finish the turn within ${Math.round(timeoutMs / 60_000)} minutes. `
      + 'The turn was aborted and the CLI was restarted; send it again, '
      + 'or split it into smaller steps.',
      { cause: error },
    );
  }
  return toCopilotRuntimeError(error, 'provider');
}

/**
 * Maps an arbitrary thrown value onto the provider-neutral error contract. Errors the
 * provider raised itself already carry a category and are passed through unchanged.
 */
export function toCopilotRuntimeError(
  error: unknown,
  fallbackCategory: ProviderExecutionErrorCategory = 'provider',
): CopilotRuntimeError {
  if (error instanceof CopilotRuntimeError) {
    return error;
  }

  const message = describeError(error);
  return new CopilotRuntimeError(
    categorizeMessage(message) ?? fallbackCategory,
    message,
    { cause: error },
  );
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return typeof error === 'string' && error.trim() ? error.trim() : 'Unknown Copilot error.';
}

/**
 * `ENOENT` is checked before the process-exit shape on purpose: a CLI that cannot be
 * spawned is a wrong path, which the user fixes in settings, not a runtime that died.
 */
function categorizeMessage(message: string): ProviderExecutionErrorCategory | null {
  if (MISSING_SESSION_PATTERN.test(message)) return 'provider-session-missing';
  if (AUTHENTICATION_PATTERN.test(message)) return 'authentication';
  if (CONFIGURATION_PATTERN.test(message)) return 'configuration';
  if (PROCESS_EXIT_PATTERN.test(message)) return 'process-exited';
  if (TRANSPORT_PATTERN.test(message)) return 'transport';
  return null;
}
