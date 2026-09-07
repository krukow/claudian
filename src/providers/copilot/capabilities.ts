import type { ProviderCapabilities } from '../../core/providers/types';

/**
 * The Copilot foundation layer streams turns, tools, and approvals, and offers the skills
 * this computer selected as provider commands. Every flag that would advertise native
 * history browsing, rewind, fork, plan mode, or images stays false until the owning
 * behavior actually exists.
 */
export const COPILOT_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'copilot',
  reasoningControl: 'effort',
  supportsFork: false,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsNativeHistory: false,
  supportsPlanMode: false,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: false,
});
