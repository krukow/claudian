import { copilotProviderRegistration } from '@/providers/copilot/registration';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';

/** Settings with a discovered catalog whose enabled models are `visibleModels`, in order. */
function withEnabledModels(
  visibleModels: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...overrides };
  updateCopilotProviderSettings(settings, {
    discoveredModels: ['gpt-5', 'gpt-5-mini'].map(rawId => ({
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
      supportsVision: false,
    })),
    enabled: true,
    visibleModels: [...visibleModels],
  });
  return settings;
}

describe('copilotProviderRegistration', () => {
  it('registers Copilot as a disabled-by-default provider module', () => {
    expect(copilotProviderRegistration).toMatchObject({
      displayName: 'Copilot',
      id: 'copilot',
    });
    expect(copilotProviderRegistration.isEnabled({})).toBe(false);
    expect(copilotProviderRegistration.workspace.initialize).toEqual(expect.any(Function));
  });

  it('toggles enablement through the provider settings bag', () => {
    const settings: Record<string, unknown> = {};

    copilotProviderRegistration.setEnabled?.(settings, true);
    expect(copilotProviderRegistration.isEnabled(settings)).toBe(true);

    copilotProviderRegistration.setEnabled?.(settings, false);
    expect(copilotProviderRegistration.isEnabled(settings)).toBe(false);
  });

  /**
   * Claiming a key routes it into the Copilot environment box, which is stored in plain
   * text in the vault. The CLI owns sign-in through the OS keychain, so Claudian does not
   * offer a place to keep a GitHub token instead.
   */
  it('claims the environment keys that configure the CLI, and no token keys', () => {
    const patterns = copilotProviderRegistration.environmentKeyPatterns ?? [];
    const claims = (key: string): boolean => patterns.some(pattern => pattern.test(key));

    expect(claims('COPILOT_HOME')).toBe(true);
    expect(claims('GITHUB_TOKEN')).toBe(false);
    expect(claims('GH_TOKEN')).toBe(false);
    expect(claims('ANTHROPIC_API_KEY')).toBe(false);
  });

  /**
   * Every credential the Copilot CLI reads, captured from the 1.0.83 bundle, plus the
   * shapes a later release would spell them with. A claimed key is offered as a Copilot
   * setting and stored in plain text inside the vault, so claiming one of these would be
   * offering to keep a credential the CLI already holds in the OS keychain.
   */
  it.each([
    'COPILOT_CONNECTION_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_BEARER_TOKEN',
    'COPILOT_PROVIDER_GHES_TOKEN',
    'COPILOT_SDK_AUTH_TOKEN',
    'GITHUB_COPILOT_AGENT_GITHUB_TOKEN',
    'GITHUB_COPILOT_API_TOKEN',
    'GITHUB_COPILOT_GITHUB_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN',
  ])('never claims %s', (key) => {
    const patterns = copilotProviderRegistration.environmentKeyPatterns ?? [];

    expect(patterns.some(pattern => pattern.test(key))).toBe(false);
    expect(patterns.some(pattern => pattern.test(key.toLowerCase()))).toBe(false);
  });

  /**
   * A credential shape is refused whatever it is attached to, so a key a later CLI
   * release adds does not have to be discovered before it stops being claimed.
   */
  it.each([
    'COPILOT_ANYTHING_TOKEN',
    'COPILOT_ANYTHING_API_KEY',
    'COPILOT_ANYTHING_APIKEY',
    'COPILOT_ANYTHING_AUTH',
    'COPILOT_ANYTHING_CREDENTIAL',
    'COPILOT_ANYTHING_PASSWORD',
    'COPILOT_ANYTHING_SECRET',
  ])('never claims the credential shape %s', (key) => {
    const patterns = copilotProviderRegistration.environmentKeyPatterns ?? [];

    expect(patterns.some(pattern => pattern.test(key))).toBe(false);
  });

  it('still claims the Copilot switches the runtime refuses', () => {
    const patterns = copilotProviderRegistration.environmentKeyPatterns ?? [];
    const claims = (key: string): boolean => patterns.some(pattern => pattern.test(key));

    expect(claims('COPILOT_ALLOW_ALL')).toBe(true);
    expect(claims('COPILOT_SKILLS_DIRS')).toBe(true);
  });

  it('scopes the CLI path per host so a synced vault does not share it', () => {
    expect(copilotProviderRegistration.settingsStorage.hostScopedFields)
      .toEqual(['cliPathsByHost']);
  });

  it('reports normalization only when the stored bag actually changed', () => {
    const canonical: Record<string, unknown> = {};
    updateCopilotProviderSettings(canonical, {});

    expect(copilotProviderRegistration.settingsStorage.normalizeStored({}, canonical))
      .toBe(false);
    expect(copilotProviderRegistration.settingsStorage.normalizeStored({}, {
      providerConfigs: { copilot: { enabled: 'yes' } },
    })).toBe(true);
  });

  it('claims a title generation model only when Copilot owns the selection', () => {
    const resolve = copilotProviderRegistration.resolveTitleGenerationModel;

    expect(resolve?.({ settings: withEnabledModels(['gpt-5'], {
      titleGenerationModel: 'copilot/gpt-5',
    }) } as never)).toBe('copilot/gpt-5');
    expect(resolve?.({ settings: withEnabledModels(['gpt-5'], {
      titleGenerationModel: 'grok/grok-4',
    }) } as never)).toBeUndefined();
  });

  it('leaves Auto model resolution to execution', () => {
    const resolve = copilotProviderRegistration.resolveTitleGenerationModel;
    const settings = withEnabledModels(['gpt-5-mini', 'gpt-5'], {
      titleGenerationModel: '',
    });

    expect(resolve?.({ settings } as never)).toBeUndefined();
    expect(resolve?.({ settings: withEnabledModels(['gpt-5-mini', 'gpt-5'], {}) } as never))
      .toBeUndefined();
  });

  /**
   * There is no provider default to fall back to, so a vault with nothing enabled titles
   * with no model rather than with one the user never turned on.
   */
  it('claims no title generation model when none is enabled', () => {
    const resolve = copilotProviderRegistration.resolveTitleGenerationModel;

    expect(resolve?.({ settings: withEnabledModels([], {
      titleGenerationModel: 'copilot/gpt-5',
    }) } as never)).toBeUndefined();
    expect(resolve?.({ settings: {} } as never)).toBeUndefined();
  });

  /** A selection the user has since hidden is not a model a turn may still run with. */
  it('does not forward a disabled title model', () => {
    const resolve = copilotProviderRegistration.resolveTitleGenerationModel;
    const settings = withEnabledModels(['gpt-5'], {
      titleGenerationModel: 'copilot/gpt-5-mini',
    });

    expect(resolve?.({ settings } as never)).toBeUndefined();
  });

  it('exposes no subagent adapter while subagents are unsupported', () => {
    expect(copilotProviderRegistration.subagentAdapter).toBeUndefined();
    expect(copilotProviderRegistration.createSubagentHistoryService).toBeUndefined();
  });
});
