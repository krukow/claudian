import { readFileSync } from 'node:fs';
import path from 'node:path';

const sdkClientSource = readFileSync(
  path.resolve(__dirname, '../../../../node_modules/@github/copilot-sdk/dist/client.js'),
  'utf8',
);

/**
 * Every place `@github/copilot-sdk` writes the switch that shuts the CLI out of its
 * credential store, with the condition guarding it.
 *
 * The SDK writes it into the environment it builds for the runtime it spawns, after the
 * caller's own environment has been spread in, so no connection or client environment
 * entry can take it back out. Which clients get it is therefore decided entirely by the
 * mode they were constructed with.
 */
function keychainSwitchGuards(): string[] {
  const lines = sdkClientSource.split('\n');
  return lines.flatMap((line, index) => (
    /\bCOPILOT_DISABLE_KEYTAR\b/.test(line) ? [lines[index - 1]?.trim() ?? ''] : []
  ));
}

/**
 * The Copilot CLI signs in for itself and keeps the credential in the OS keychain, which
 * is the only sign-in Claudian supports: it owns no GitHub credential, offers nowhere to
 * store one, and does not fall back to the `gh` CLI. `mode: 'empty'` would take that away
 * — with `COPILOT_DISABLE_KEYTAR=1` the CLI never opens its credential store and reports
 * itself signed out however recently the user signed in.
 *
 * This pins the SDK's rule rather than Claudian's use of it. An SDK upgrade that disables
 * the keychain for another mode has to be read before it is taken, because the mode
 * `sdk/CopilotSdkRuntime` picks would no longer mean what it means here.
 */
describe('@github/copilot-sdk keychain mode', () => {
  it('disables the CLI keychain only in empty mode', () => {
    const guards = keychainSwitchGuards();

    expect(guards.length).toBeGreaterThan(0);
    expect(new Set(guards)).toEqual(new Set(['if (this.options.mode === "empty") {']));
  });

  /**
   * Empty mode is also the only mode that clears a session's installed plugins, through a
   * patch the SDK sends after create and resume. Outside it the plugin list comes from the
   * runtime's own `COPILOT_HOME`, which is why Claudian's has to be one of its own.
   */
  it('clears installed plugins only in empty mode', () => {
    const [, guarded] = sdkClientSource.split('patch.installedPlugins = [];');

    expect(guarded).toBeDefined();
    expect(sdkClientSource).toContain(
      'if (this.options.mode === "empty") {\n      patch.skipCustomInstructions',
    );
  });

  /**
   * `builtinPluginDirectories: []` cannot be used to clear anything: the SDK only sends
   * `plugins.builtin.set` when the list it was given is non-empty, so an empty one is a
   * no-op rather than a denial. There is no client option that empties that set.
   */
  it('registers builtin plugin directories only when it was given some', () => {
    expect(sdkClientSource).toContain('if (this.builtinPluginDirectories.length > 0) {');
  });
});
