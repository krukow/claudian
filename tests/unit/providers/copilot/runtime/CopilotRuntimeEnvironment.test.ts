import * as path from 'path';

import {
  buildCopilotRuntimeEnvironment,
  COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS,
  isCopilotJavaScriptEntrypoint,
  resolveCopilotHomeDirectory,
} from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';

describe('buildCopilotRuntimeEnvironment', () => {
  const baseInput = {
    baseDirectory: '/state/claudian/copilot/vault',
    cliPath: '/opt/copilot/bin/copilot',
    trustedPath: '/opt/copilot/bin:/usr/bin',
    providerEnvironment: {},
  };

  it('forwards only the host variables the CLI needs', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: {
        AWS_SECRET_ACCESS_KEY: 'secret',
        HOME: '/home/user',
        HTTPS_PROXY: 'http://proxy:8080',
        NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
        OPENAI_API_KEY: 'secret',
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      },
    });

    expect(environment).toEqual({
      COPILOT_HOME: '/state/claudian/copilot/vault',
      HOME: '/home/user',
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
      PATH: '/opt/copilot/bin:/usr/bin',
      SHELL: '/bin/zsh',
    });
  });

  it('does not forward arbitrary host secrets', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: {
        ANTHROPIC_API_KEY: 'secret',
        GITHUB_TOKEN: 'host-token',
        PATH: '/usr/bin',
      },
    });

    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
  });

  /**
   * A configured entry replaces the forwarded value for the settings the allow-list
   * names. `HOME` is not one of them: it decides where the CLI reads and writes the
   * user's own account state, which Claudian pins through `COPILOT_HOME` instead.
   */
  it('applies configured entries over the forwarded base, and nothing else', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { HOME: '/home/user', LANG: 'C', PATH: '/usr/bin' },
      providerEnvironment: { HOME: '/sandbox/home', LANG: 'en_US.UTF-8' },
    });

    expect(environment.LANG).toBe('en_US.UTF-8');
    expect(environment.HOME).toBe('/home/user');
  });

  /**
   * The CLI owns sign-in and keeps the credential in the OS keychain. A token typed into
   * Claudian's settings would be stored in plain text inside the vault, so it is refused
   * rather than forwarded, however it is spelled.
   */
  it.each(['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'github_token'])(
    'refuses a configured %s',
    (key) => {
      const environment = buildCopilotRuntimeEnvironment({
        ...baseInput,
        processEnvironment: { PATH: '/usr/bin' },
        providerEnvironment: { [key]: 'ghp_configured' },
      });

      expect(environment).not.toHaveProperty(key);
      expect(Object.values(environment)).not.toContain('ghp_configured');
    },
  );

  it('keeps COPILOT_HOME and PATH owned by Claudian', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { PATH: '/usr/bin' },
      providerEnvironment: {
        COPILOT_HOME: '/somewhere/else',
        PATH: '/attacker/bin',
      },
    });

    expect(environment.COPILOT_HOME).toBe('/state/claudian/copilot/vault');
    expect(environment.PATH).toBe('/opt/copilot/bin:/usr/bin');
  });

  it('omits forwarded variables that are absent or empty', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { PATH: '/usr/bin', SHELL: '' },
    });

    expect(environment).not.toHaveProperty('SHELL');
    expect(environment).not.toHaveProperty('HOME');
  });

  /**
   * The CLI switches that would let it act without asking, named independently of the
   * provider constant. Sourced from `copilot --help` and the CLI bundle for 1.0.83.
   */
  const BYPASS_ENVIRONMENT_KEYS = [
    'COPILOT_ALLOW_ALL',
    'COPILOT_ASSISTED_APPROVAL',
    'COPILOT_AUTO_UPDATE',
    'COPILOT_CLI_ENABLED_FEATURE_FLAGS',
    'COPILOT_CLI_PATH',
    'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
    'COPILOT_DYNAMIC_RETRIEVAL_MCP',
    'COPILOT_DYNAMIC_RETRIEVAL_SKILLS',
    'COPILOT_ENABLE_BUILTIN_GITHUB_MCP',
    'COPILOT_HOOK_ALLOW_HTTP_AUTH_HOOKS',
    'COPILOT_HOOK_ALLOW_LOCALHOST',
    'COPILOT_MCP_APPS',
    'COPILOT_SKILLS_DIRS',
    'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
    'GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS',
    'GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP',
  ];

  it.each(BYPASS_ENVIRONMENT_KEYS)('refuses %s from provider settings', (key) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { PATH: '/usr/bin' },
      providerEnvironment: { [key]: 'true' },
    });

    expect(environment).not.toHaveProperty(key);
  });

  it.each(BYPASS_ENVIRONMENT_KEYS)('refuses %s from the host environment', (key) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { [key]: 'true', PATH: '/usr/bin' },
    });

    expect(environment).not.toHaveProperty(key);
  });

  /**
   * Windows resolves environment variables without regard to case, so a differently
   * cased bypass or pinned key is the same variable to the CLI. The match is
   * case-insensitive on every platform so the safety rules do not depend on where the
   * vault is opened.
   */
  it.each([
    'copilot_allow_all',
    'Copilot_Assisted_Approval',
    'copilot_cli_path',
    'github_copilot_prompt_mode_repo_hooks',
  ])('refuses %s whatever case it is written in', (key) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { [key]: 'true', PATH: '/usr/bin' },
      providerEnvironment: { [key]: 'true' },
    });

    expect(Object.keys(environment).map(name => name.toLowerCase()))
      .not.toContain(key.toLowerCase());
  });

  it.each(['copilot_home', 'Path', 'electron_run_as_node'])(
    'keeps %s owned by Claudian whatever case it is written in',
    (key) => {
      const environment = buildCopilotRuntimeEnvironment({
        ...baseInput,
        processEnvironment: { PATH: '/usr/bin' },
        providerEnvironment: { [key]: '/attacker/bin' },
      });

      expect(environment).not.toHaveProperty(key);
      expect(environment.COPILOT_HOME).toBe('/state/claudian/copilot/vault');
      expect(environment.PATH).toBe('/opt/copilot/bin:/usr/bin');
    },
  );

  it('leaves one canonical PATH when the host forwards a lowercase one', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { path: 'C:\\Windows\\System32', PATH: '/usr/bin' },
      providerEnvironment: {},
    });

    expect(Object.keys(environment).filter(key => key.toLowerCase() === 'path'))
      .toEqual(['PATH']);
    expect(environment.PATH).toBe('/opt/copilot/bin:/usr/bin');
  });

  it('runs Electron as Node when the CLI is a JavaScript entry point', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      cliPath: '/opt/npm/node_modules/@github/copilot/npm-loader.js',
      processEnvironment: { PATH: '/usr/bin' },
    });

    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('leaves ELECTRON_RUN_AS_NODE unset for a native CLI executable', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' },
      providerEnvironment: { ELECTRON_RUN_AS_NODE: '1' },
    });

    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });
});

/**
 * Provider settings reach a process Claudian spawns with the user's own credentials, and
 * they are stored in plain text inside the vault. Only keys named on the allow-list ever
 * reach the CLI: a denial list would have to keep pace with every switch a CLI release
 * adds, while an allow-list refuses the ones nobody has thought of yet.
 */
describe('buildCopilotRuntimeEnvironment configured allow-list', () => {
  const baseInput = {
    baseDirectory: '/state/claudian/copilot/vault',
    cliPath: '/opt/copilot/bin/copilot',
    trustedPath: '/opt/copilot/bin:/usr/bin',
    processEnvironment: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
  };

  function configure(providerEnvironment: Record<string, string>): Record<string, string> {
    return buildCopilotRuntimeEnvironment({ ...baseInput, providerEnvironment });
  }

  it.each([...COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS])('carries %s to the CLI', (key) => {
    expect(configure({ [key]: 'configured' })[key]).toBe('configured');
  });

  it('names only locale settings', () => {
    expect([...COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS].sort()).toEqual(['LANG', 'LC_ALL']);
  });

  /**
   * Routing and TLS trust decide where the CLI's requests go and which certificates it
   * accepts, while the CLI is signed in with the user's own GitHub credential. Provider
   * settings are plain text inside a vault that syncs and can be shared, so a proxy or CA
   * entry typed there would point an already-authenticated CLI wherever the vault says.
   * The host process is a different thing entirely: it is the environment the user
   * already runs Obsidian in, so a corporate proxy or CA set there is inherited, and only
   * from there.
   */
  it.each([
    'ALL_PROXY',
    'CURL_CA_BUNDLE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'NO_PROXY',
    'REQUESTS_CA_BUNDLE',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
  ])('refuses a configured %s and keeps the host value', (key) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { [key]: 'host-value', PATH: '/usr/bin' },
      providerEnvironment: { [key]: 'vault-value' },
    });

    expect(environment[key]).toBe('host-value');
  });

  it.each(['https_proxy', 'Node_Extra_CA_Certs', 'ssl_cert_file'])(
    'refuses a configured %s whatever case it is written in',
    (key) => {
      const environment = buildCopilotRuntimeEnvironment({
        ...baseInput,
        processEnvironment: { PATH: '/usr/bin' },
        providerEnvironment: { [key]: 'vault-value' },
      });

      expect(Object.values(environment)).not.toContain('vault-value');
    },
  );

  /**
   * A configured entry written in another case is the same variable to the CLI on
   * Windows, so it is recognised and rewritten under the one spelling the forwarded base
   * uses. Otherwise it would sit beside the forwarded value instead of replacing it.
   */
  it('applies a configured entry over the forwarded base under one spelling', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { LANG: 'C', PATH: '/usr/bin' },
      providerEnvironment: { lang: 'en_US.UTF-8' },
    });

    expect(Object.keys(environment).filter(key => key.toLowerCase() === 'lang'))
      .toEqual(['LANG']);
    expect(environment.LANG).toBe('en_US.UTF-8');
  });

  /**
   * The CLI launches through `process.execPath`, which under Obsidian is Electron. Any
   * variable that makes Node or Electron load code, attach a debugger, or change its
   * bootstrap turns a configured environment entry into arbitrary code execution inside
   * the spawned runtime.
   */
  it.each([
    'ELECTRON_ENABLE_LOGGING',
    'ELECTRON_EXTRA_LAUNCH_ARGS',
    'ELECTRON_RUN_AS_NODE',
    'NODE_DEBUG',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_REPL_EXTERNAL_MODULE',
    'NODE_V8_COVERAGE',
  ])('refuses the %s bootstrap variable', (key) => {
    expect(configure({ [key]: '--require /tmp/evil.js' })).not.toHaveProperty(key);
    expect(buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { [key]: '--require /tmp/evil.js', PATH: '/usr/bin' },
      providerEnvironment: {},
    })).not.toHaveProperty(key);
  });

  /**
   * Every credential the CLI reads, captured from the Copilot CLI 1.0.83 bundle. Claudian
   * owns no GitHub credential: sign-in belongs to the CLI and its keychain entry, so a
   * token typed into the vault is refused rather than forwarded.
   */
  it.each([
    'COPILOT_CONNECTION_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_BEARER_TOKEN',
    'COPILOT_PROVIDER_GHES_TOKEN',
    'COPILOT_SDK_AUTH_TOKEN',
    'GH_TOKEN',
    'GITHUB_COPILOT_AGENT_GITHUB_TOKEN',
    'GITHUB_COPILOT_API_TOKEN',
    'GITHUB_COPILOT_GITHUB_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'GITHUB_TOKEN',
  ])('refuses the %s credential', (key) => {
    expect(Object.values(configure({ [key]: 'ghp_configured' })))
      .not.toContain('ghp_configured');
  });

  /**
   * The endpoint half of a credential pair. Repointing the API the CLI calls, while the
   * CLI still presents the token it holds in the OS keychain, sends that credential to
   * whoever the entry names, so the endpoint keys are refused with the token keys.
   */
  it.each([
    'COPILOT_AHP_URL',
    'COPILOT_API_URL',
    'COPILOT_DEBUG_GITHUB_API_URL',
    'COPILOT_GH_HOST',
    'COPILOT_MC_BASE_URL',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_GHES_HOST',
    'GH_HOST',
  ])('refuses the %s endpoint override', (key) => {
    expect(Object.values(configure({ [key]: 'https://attacker.example' })))
      .not.toContain('https://attacker.example');
  });

  it('refuses a configured entry the allow-list does not name', () => {
    expect(configure({ COPILOT_MODEL: 'gpt-5' })).not.toHaveProperty('COPILOT_MODEL');
  });

  /**
   * A configurable key that collided with a pinned one would be accepted and then
   * overwritten, which reads as support for something Claudian does not offer.
   */
  it('never offers a key Claudian pins', () => {
    const pinned = ['COPILOT_HOME', 'ELECTRON_RUN_AS_NODE', 'PATH'];

    expect(COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS.filter(
      key => pinned.some(name => name.toLowerCase() === key.toLowerCase()),
    )).toEqual([]);
  });
});

describe('isCopilotJavaScriptEntrypoint', () => {
  /**
   * The SDK spawns a path ending in a lowercase `.js` through the Node executable and
   * launches anything else directly, so this mirrors that test exactly. A path spelled
   * `.JS` is normalized by `resolveCopilotCliEntry` before it gets here; telling Electron
   * to behave as Node for one the SDK would launch directly only hides the failure.
   */
  it.each([
    ['/opt/npm/node_modules/@github/copilot/npm-loader.js', true],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.JS', false],
    ['/usr/local/bin/copilot', false],
    ['C:\\Program Files\\copilot\\copilot.exe', false],
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd', false],
  ])('classifies %j as a JavaScript entry point: %s', (cliPath, expected) => {
    expect(isCopilotJavaScriptEntrypoint(cliPath)).toBe(expected);
  });
});

describe('resolveCopilotHomeDirectory', () => {
  it('keeps Copilot session data out of the vault', () => {
    const home = resolveCopilotHomeDirectory(
      '/Users/person/Vault',
      { HOME: '/Users/person' },
      'darwin',
    );

    expect(home).toContain(
      path.join('/Users/person', 'Library', 'Application Support', 'Claudian', 'copilot'),
    );
    expect(home).not.toContain('/Vault');
    expect(home).not.toContain('.claudian');
  });

  it('uses the platform application-state location', () => {
    expect(resolveCopilotHomeDirectory('/vault', {
      LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local',
    }, 'win32')).toContain(path.join('C:\\Users\\person\\AppData\\Local', 'Claudian', 'copilot'));

    expect(resolveCopilotHomeDirectory('/vault', {
      HOME: '/home/person',
      XDG_STATE_HOME: '/home/person/.state',
    }, 'linux')).toContain(path.join('/home/person/.state', 'claudian', 'copilot'));

    expect(resolveCopilotHomeDirectory('/vault', { HOME: '/home/person' }, 'linux'))
      .toContain(path.join('/home/person', '.local', 'state', 'claudian', 'copilot'));
  });

  it('gives each vault its own store and leaks no path information', () => {
    const environment = { HOME: '/home/person' };
    const first = resolveCopilotHomeDirectory('/vaults/work', environment, 'linux');
    const second = resolveCopilotHomeDirectory('/vaults/personal', environment, 'linux');

    expect(first).not.toBe(second);
    expect(first).toMatch(/[0-9a-f]{16}$/);
  });

  it('is stable for equivalent vault paths', () => {
    const environment = { HOME: '/home/person' };

    expect(resolveCopilotHomeDirectory('/vaults/work/', environment, 'linux'))
      .toBe(resolveCopilotHomeDirectory('/vaults/work', environment, 'linux'));
  });
});

/**
 * A vault that already carries a GitHub token in either environment box keeps the text —
 * Claudian does not rewrite the user's settings — but the CLI never receives it, so the
 * only credential in play stays the one the CLI holds in the OS keychain.
 */
describe('buildCopilotRuntimeEnvironment token migration', () => {
  it('refuses a token already stored in the provider environment', () => {
    const environment = buildCopilotRuntimeEnvironment({
      baseDirectory: '/state/claudian/copilot/vault',
      cliPath: '/opt/copilot/bin/copilot',
      trustedPath: '/opt/copilot/bin:/usr/bin',
      processEnvironment: {
        GH_TOKEN: 'host-token',
        HTTPS_PROXY: 'http://proxy:8080',
        PATH: '/usr/bin',
      },
      providerEnvironment: {
        COPILOT_GITHUB_TOKEN: 'ghp_stored',
        GH_TOKEN: 'ghp_stored',
        GITHUB_TOKEN: 'ghp_stored',
        LANG: 'en_US.UTF-8',
      },
    });

    expect(environment).toEqual({
      COPILOT_HOME: '/state/claudian/copilot/vault',
      HTTPS_PROXY: 'http://proxy:8080',
      LANG: 'en_US.UTF-8',
      PATH: '/opt/copilot/bin:/usr/bin',
    });
  });
});
