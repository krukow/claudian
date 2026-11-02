import type { ProviderCapabilities } from '../../core/providers/types';

/**
 * History restoration reads native transcripts without acquiring an execution session.
 * Rewind, fork, plan mode, and images remain independent, unsupported capabilities.
 */
export const COPILOT_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'copilot',
  reasoningControl: 'effort',
  supportsFork: false,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsNativeHistory: true,
  supportsPlanMode: false,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: false,
});
