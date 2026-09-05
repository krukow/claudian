import type { Conversation } from '@/core/types';
import {
  computeCopilotEnvironmentHash,
  copilotSettingsReconciler,
} from '@/providers/copilot/env/CopilotSettingsReconciler';
import { buildCopilotRuntimeEnvironment } from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';
import {
  getCopilotProviderSettings,
  updateCopilotProviderSettings,
} from '@/providers/copilot/settings';
import { parseEnvironmentVariables } from '@/utils/env';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    createdAt: 0,
    id: 'conversation-1',
    messages: [],
    providerId: 'copilot',
    sessionId: 'copilot-session',
    title: 'Conversation',
    updatedAt: 0,
    ...overrides,
  } as Conversation;
}

function enabledSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...overrides };
  updateCopilotProviderSettings(settings, {
    discoveredModels: [{
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: ['low', 'high'],
      supportsReasoning: true,
      supportsVision: false,
    }],
    enabled: true,
    visibleModels: ['gpt-5'],
  });
  return settings;
}

describe('computeCopilotEnvironmentHash', () => {
  it('produces a versioned fingerprint', () => {
    expect(computeCopilotEnvironmentHash(enabledSettings()))
      .toMatch(/^runtime-input:v1:[0-9a-f]+$/);
  });

  it('changes when the host CLI path changes', () => {
    const settings = enabledSettings();
    const before = computeCopilotEnvironmentHash(settings);

    updateCopilotProviderSettings(settings, { cliPath: '/opt/copilot/bin/copilot' });

    expect(computeCopilotEnvironmentHash(settings)).not.toBe(before);
  });

  it('changes when provider environment variables change', () => {
    const settings = enabledSettings();
    const before = computeCopilotEnvironmentHash(settings);

    updateCopilotProviderSettings(settings, { environmentVariables: 'LANG=en_US.UTF-8' });

    expect(computeCopilotEnvironmentHash(settings)).not.toBe(before);
  });
});

/**
 * The fingerprint says what runtime a session and a catalog belong to, so it has to be
 * taken from the environment the CLI is actually handed rather than from the text it was
 * written in. `buildCopilotRuntimeEnvironment` resolves configured entries without regard
 * to case and lets the last one win, which is how Windows reads them, so two texts that
 * differ only in the order of two spellings of one variable start two different runtimes.
 */
describe('computeCopilotEnvironmentHash against the environment the CLI receives', () => {
  const LOWERCASE_FIRST = 'lang=en_US.UTF-8\nLANG=C';
  const UPPERCASE_FIRST = 'LANG=C\nlang=en_US.UTF-8';

  function environmentOf(environmentVariables: string): Record<string, string> {
    return buildCopilotRuntimeEnvironment({
      baseDirectory: '/state/claudian/copilot/vault',
      cliPath: '/opt/copilot/bin/copilot',
      processEnvironment: { PATH: '/usr/bin' },
      providerEnvironment: parseEnvironmentVariables(environmentVariables),
      trustedPath: '/opt/copilot/bin:/usr/bin',
    });
  }

  function fingerprintOf(environmentVariables: string): string {
    const settings = enabledSettings();
    updateCopilotProviderSettings(settings, { environmentVariables });
    return computeCopilotEnvironmentHash(settings);
  }

  it('separates orderings that start different runtimes', () => {
    expect(environmentOf(LOWERCASE_FIRST).LANG).not.toBe(environmentOf(UPPERCASE_FIRST).LANG);
    expect(fingerprintOf(LOWERCASE_FIRST)).not.toBe(fingerprintOf(UPPERCASE_FIRST));
  });

  it('gives one identity to the spellings that start one runtime', () => {
    expect(environmentOf('lang=en_US.UTF-8').LANG)
      .toBe(environmentOf('LANG=en_US.UTF-8').LANG);
    expect(fingerprintOf('lang=en_US.UTF-8')).toBe(fingerprintOf('LANG=en_US.UTF-8'));
  });

  /**
   * An entry the allow-list does not name never reaches the CLI, so it describes no
   * runtime the catalog could belong to. Moving the fingerprint for it would discard a
   * catalog the user would then have to rediscover for nothing.
   */
  it('ignores an entry the CLI never receives', () => {
    expect(environmentOf('COPILOT_HOME=/tmp/home')).toEqual(environmentOf(''));
    expect(fingerprintOf('COPILOT_HOME=/tmp/home')).toBe(fingerprintOf(''));
  });
});

describe('copilotSettingsReconciler.reconcileModelWithEnvironment', () => {
  it('does nothing while the provider is disabled', () => {
    const settings: Record<string, unknown> = {};

    expect(copilotSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getCopilotProviderSettings(settings).environmentHash).toBe('');
  });

  it('clears the discovered catalog and invalidates sessions on first reconcile', () => {
    const settings = enabledSettings();
    const conversation = createConversation();

    const result = copilotSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [conversation],
    );

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toEqual([conversation]);
    expect(conversation.sessionId).toBeNull();
    const providerSettings = getCopilotProviderSettings(settings);
    expect(providerSettings.discoveredModels).toEqual([]);
    expect(providerSettings.environmentHash).not.toBe('');
  });

  it('is idempotent once the fingerprint is recorded', () => {
    const settings = enabledSettings();
    copilotSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(copilotSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
  });

  it('leaves conversations owned by another provider alone', () => {
    const settings = enabledSettings();
    const other = createConversation({ id: 'other', providerId: 'grok' });

    const result = copilotSettingsReconciler.reconcileModelWithEnvironment(settings, [other]);

    expect(result.invalidatedConversations).toEqual([]);
    expect(other.sessionId).toBe('copilot-session');
  });
});

describe('copilotSettingsReconciler.invalidateConversationSessions', () => {
  it('only drops session references for Copilot conversations that have one', () => {
    const withSession = createConversation();
    const withoutSession = createConversation({ id: 'no-session', sessionId: null });
    const otherProvider = createConversation({ id: 'other', providerId: 'pi' });

    expect(copilotSettingsReconciler.invalidateConversationSessions([
      withSession,
      withoutSession,
      otherProvider,
    ])).toEqual([withSession]);
    expect(withSession.sessionId).toBeNull();
    expect(otherProvider.sessionId).toBe('copilot-session');
  });
});

describe('copilotSettingsReconciler.normalizeModelVariantSettings', () => {
  it('canonicalizes Copilot selections wherever they are stored', () => {
    const settings: Record<string, unknown> = {
      model: 'copilot/  gpt-5  ',
      savedProviderModel: { copilot: 'copilot/gpt-5 ' },
      titleGenerationModel: 'copilot/gpt-5',
    };

    expect(copilotSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings.model).toBe('copilot/gpt-5');
    expect(settings.savedProviderModel).toEqual({ copilot: 'copilot/gpt-5' });
    expect(settings.titleGenerationModel).toBe('copilot/gpt-5');
  });

  it('leaves selections owned by other providers untouched', () => {
    const settings: Record<string, unknown> = { model: 'grok/grok-4' };

    expect(copilotSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(settings.model).toBe('grok/grok-4');
  });
});
