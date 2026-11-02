import { detectBuiltInCommand } from '@/core/commands/builtInCommands';
import { COPILOT_PROVIDER_CAPABILITIES } from '@/providers/copilot/capabilities';

describe('COPILOT_PROVIDER_CAPABILITIES', () => {
  it('advertises only the behavior the provider implements', () => {
    expect(COPILOT_PROVIDER_CAPABILITIES).toEqual({
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
  });

  it('offers resume without enabling fork or rewind', () => {
    expect(detectBuiltInCommand('/resume', COPILOT_PROVIDER_CAPABILITIES)?.command.action)
      .toBe('resume');
    expect(detectBuiltInCommand('/fork', COPILOT_PROVIDER_CAPABILITIES)).toBeNull();
    expect(COPILOT_PROVIDER_CAPABILITIES.supportsRewind).toBe(false);
  });

  it('is frozen so a caller cannot widen the contract at runtime', () => {
    expect(Object.isFrozen(COPILOT_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
