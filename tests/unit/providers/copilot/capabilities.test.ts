import { COPILOT_PROVIDER_CAPABILITIES } from '@/providers/copilot/capabilities';

describe('COPILOT_PROVIDER_CAPABILITIES', () => {
  it('advertises only the behavior the foundation layer implements', () => {
    expect(COPILOT_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'copilot',
      reasoningControl: 'effort',
      supportsFork: false,
      supportsImageAttachments: false,
      supportsInstructionMode: true,
      supportsNativeHistory: false,
      supportsPlanMode: false,
      supportsProviderCommands: false,
      supportsRewind: false,
      supportsTurnSteer: false,
    });
  });

  it('is frozen so a caller cannot widen the contract at runtime', () => {
    expect(Object.isFrozen(COPILOT_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
