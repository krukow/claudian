import type { SessionConfig } from '@github/copilot-sdk';

export type {
  CopilotSession,
  ModelInfo,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
export { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

/** The SDK does not re-export its reasoning union, so it is derived from the config. */
export type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;
