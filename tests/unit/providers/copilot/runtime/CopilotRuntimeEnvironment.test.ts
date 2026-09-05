import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { toAbsoluteCopilotPath } from '@/providers/copilot/runtime/CopilotAbsolutePath';
import type { CopilotPathCanonicalizer } from '@/providers/copilot/runtime/CopilotCanonicalPath';
import {
  buildCopilotRuntimeEnvironment,
  COPILOT_CONFIGURABLE_ENVIRONMENT_KEYS,
  isCopilotJavaScriptEntrypoint,
  resolveCopilotHomeDirectory,
} from '@/providers/copilot/runtime/CopilotRuntimeEnvironment';

type NodeOs = typeof os;

/**
 * The host locations `resolveCopilotHomeDirectory` falls back to when the environment it
 * is handed names none. They are the environment boundary this module reads directly, so
 * they are the only thing stood in for here.
 */
jest.mock('node:os', () => {
  const actual = jest.requireActual<NodeOs>('node:os');
  return { ...actual, homedir: jest.fn(actual.homedir), tmpdir: jest.fn(actual.tmpdir) };
});

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

  /**
   * Routing and TLS trust are inherited from the host process, and the conventional
   * spelling for them on macOS and Linux is lowercase: `https_proxy` is what a shell
   * profile, a corporate onboarding script, and curl's own documentation set. Reading
   * only the uppercase spelling would drop a proxy or certificate authority the host
   * imposes and send the CLI direct, so the host base is matched without regard to case
   * on every platform.
   */
  it.each([
    ['all_proxy', 'ALL_PROXY'],
    ['curl_ca_bundle', 'CURL_CA_BUNDLE'],
    ['http_proxy', 'HTTP_PROXY'],
    ['https_proxy', 'HTTPS_PROXY'],
    ['no_proxy', 'NO_PROXY'],
    ['Node_Extra_CA_Certs', 'NODE_EXTRA_CA_CERTS'],
    ['requests_ca_bundle', 'REQUESTS_CA_BUNDLE'],
    ['ssl_cert_dir', 'SSL_CERT_DIR'],
    ['ssl_cert_file', 'SSL_CERT_FILE'],
  ])('carries a host %s to the CLI as %s', (hostKey, canonicalKey) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { [hostKey]: 'host-value', PATH: '/usr/bin' },
    });

    expect(environment[canonicalKey]).toBe('host-value');
    expect(Object.keys(environment).filter(
      key => key.toLowerCase() === canonicalKey.toLowerCase(),
    )).toEqual([canonicalKey]);
  });

  /**
   * Two spellings of one variable are one variable to the CLI, so exactly one reaches it
   * and which one it is cannot depend on the order the host happens to enumerate its
   * environment in. The allow-list's own spelling is the answer whenever it carries a
   * value.
   */
  it.each([
    ['the canonical spelling first', { HTTPS_PROXY: 'canonical', https_proxy: 'variant' }],
    ['a variant first', { https_proxy: 'variant', HTTPS_PROXY: 'canonical' }],
  ])('prefers the canonical host spelling with %s', (_name, processEnvironment) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { ...processEnvironment, PATH: '/usr/bin' },
    });

    expect(environment.HTTPS_PROXY).toBe('canonical');
  });

  /**
   * With no canonical spelling to defer to, the last variant by code unit wins, which is
   * the same "last spelling wins" rule the configured environment resolves by and is
   * decided by the spellings themselves rather than by enumeration order.
   */
  it.each([
    ['ascending', { Https_Proxy: 'mixed', https_proxy: 'lower' }],
    ['descending', { https_proxy: 'lower', Https_Proxy: 'mixed' }],
  ])('resolves coexisting host variants the same way in %s order', (_name, processEnvironment) => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { ...processEnvironment, PATH: '/usr/bin' },
    });

    expect(environment.HTTPS_PROXY).toBe('lower');
  });

  /**
   * An empty value is already read as absent, so a spelling the host left empty does not
   * hide the one it filled in.
   */
  it('reads an empty canonical spelling as absent', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: {
        HTTPS_PROXY: '',
        https_proxy: 'http://proxy:8080',
        PATH: '/usr/bin',
      },
    });

    expect(environment.HTTPS_PROXY).toBe('http://proxy:8080');
  });

  /**
   * Case-insensitive matching is about which host variable was set, not about what the
   * vault may say: a proxy or certificate authority typed into provider settings is still
   * refused however it is spelled, and the host value stands.
   */
  it('keeps the host proxy when the vault names the same variable in another case', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: { https_proxy: 'http://corporate:8080', PATH: '/usr/bin' },
      providerEnvironment: { HTTPS_PROXY: 'http://attacker:8080' },
    });

    expect(environment.HTTPS_PROXY).toBe('http://corporate:8080');
  });

  it('never forwards a host variable the allow-list does not name in any case', () => {
    const environment = buildCopilotRuntimeEnvironment({
      ...baseInput,
      processEnvironment: {
        copilot_allow_all: 'true',
        github_token: 'ghp_host',
        PATH: '/usr/bin',
      },
    });

    expect(Object.values(environment)).not.toContain('ghp_host');
    expect(Object.values(environment)).not.toContain('true');
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
  beforeEach(() => {
    const actual = jest.requireActual<NodeOs>('node:os');
    jest.mocked(os.homedir).mockImplementation(actual.homedir);
    jest.mocked(os.tmpdir).mockImplementation(actual.tmpdir);
  });

  /** A path that means one place wherever it is resolved from, per platform. */
  function isAbsoluteFor(platform: NodeJS.Platform, value: string): boolean {
    return platform === 'win32'
      ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)
      : path.posix.isAbsolute(value);
  }

  it('keeps Copilot session data out of the vault', () => {
    const home = resolveCopilotHomeDirectory(
      '/Users/person/Vault',
      { HOME: '/Users/person' },
      'darwin',
    );

    expect(home).toContain(
      path.posix.join('/Users/person', 'Library', 'Application Support', 'Claudian', 'copilot'),
    );
    expect(home).not.toContain('/Vault');
    expect(home).not.toContain('.claudian');
  });

  it('uses the platform application-state location', () => {
    expect(resolveCopilotHomeDirectory('/vault', {
      LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local',
    }, 'win32')).toContain(
      path.win32.join('C:\\Users\\person\\AppData\\Local', 'Claudian', 'copilot'),
    );

    expect(resolveCopilotHomeDirectory('/vault', {
      HOME: '/home/person',
      XDG_STATE_HOME: '/home/person/.state',
    }, 'linux')).toContain(path.posix.join('/home/person/.state', 'claudian', 'copilot'));

    expect(resolveCopilotHomeDirectory('/vault', { HOME: '/home/person' }, 'linux'))
      .toContain(path.posix.join('/home/person', '.local', 'state', 'claudian', 'copilot'));
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

  /**
   * `COPILOT_HOME` is handed to a CLI the SDK spawns with the vault as its working
   * directory, so a relative one is resolved against vault content: this vault's agent
   * state would be written into the notes it is meant to stay out of, and would be
   * indexed, synced, and shared with them. A host variable that names a relative location
   * therefore names nothing, and the next absolute candidate answers instead.
   */
  it.each([
    ['linux', { HOME: '/home/person', XDG_STATE_HOME: 'state' },
      path.posix.join('/home/person', '.local', 'state', 'claudian')],
    ['linux', { HOME: '/home/person', XDG_STATE_HOME: './state' },
      path.posix.join('/home/person', '.local', 'state', 'claudian')],
    ['win32', { LOCALAPPDATA: 'AppData\\Local', USERPROFILE: 'C:\\Users\\person' },
      path.win32.join('C:\\Users\\person', 'AppData', 'Local', 'Claudian')],
    ['darwin', { HOME: 'person/Library', USERPROFILE: '/Users/person' },
      path.posix.join('/Users/person', 'Library', 'Application Support', 'Claudian')],
  ] as ReadonlyArray<[NodeJS.Platform, NodeJS.ProcessEnv, string]>)(
    'ignores a relative %s state location',
    (platform, environment, expectedRoot) => {
      const home = resolveCopilotHomeDirectory('/vault', environment, platform);

      expect(home.startsWith(expectedRoot)).toBe(true);
      expect(isAbsoluteFor(platform, home)).toBe(true);
    },
  );

  /**
   * Windows resolves a drive-relative or root-relative reference against the working
   * directory's drive, which is the vault's, so neither shape names a place either.
   */
  it.each(['C:AppData\\Local', '\\AppData\\Local', 'AppData/Local'])(
    'ignores the Windows state location %s',
    (localAppData) => {
      const home = resolveCopilotHomeDirectory(
        'C:\\Vault',
        { LOCALAPPDATA: localAppData, USERPROFILE: 'C:\\Users\\person' },
        'win32',
      );

      expect(home).toContain(
        path.win32.join('C:\\Users\\person', 'AppData', 'Local', 'Claudian', 'copilot'),
      );
    },
  );

  /**
   * There is no candidate left to fall through to, and no answer that names the vault is
   * acceptable, so a host that supplies no absolute location of its own still receives an
   * absolute one it can write to.
   */
  it.each(['darwin', 'linux', 'win32'] as ReadonlyArray<NodeJS.Platform>)(
    'always answers with an absolute directory on %s',
    (platform) => {
      for (const environment of [
        {},
        { HOME: 'person', LOCALAPPDATA: 'local', USERPROFILE: 'person', XDG_STATE_HOME: 'state' },
      ]) {
        const home = resolveCopilotHomeDirectory('/vaults/work', environment, platform);

        expect(isAbsoluteFor(platform, home)).toBe(true);
        expect(home).toMatch(/[0-9a-f]{16}$/);
        expect(home).not.toContain('vaults');
      }
    },
  );

  /**
   * The last resort is the host's own temporary location rather than anything derived
   * from the vault, and it is still keyed by vault so two vaults never share a store. A
   * host that reports no absolute home is what reaches it, so `os.homedir` stands in for
   * one here.
   */
  it.each([
    ['darwin', { TMPDIR: '/var/folders/9x' }, path.posix.join('/var/folders/9x', 'Claudian', 'copilot')],
    ['linux', { TMPDIR: '/var/tmp' }, path.posix.join('/var/tmp', 'claudian', 'copilot')],
    ['win32', { TEMP: 'D:\\Temp' }, path.win32.join('D:\\Temp', 'Claudian', 'copilot')],
  ] as ReadonlyArray<[NodeJS.Platform, NodeJS.ProcessEnv, string]>)(
    'falls back to the %s temporary location, never to the vault',
    (platform, environment, expected) => {
      jest.mocked(os.homedir).mockReturnValue('person');
      const home = resolveCopilotHomeDirectory('/vaults/work', environment, platform);

      expect(home).toContain(expected);
      expect(isAbsoluteFor(platform, home)).toBe(true);
    },
  );

  /**
   * With neither a home nor a temporary location to read, the answer is a platform
   * constant. Deriving one from the working directory would put the store in the vault,
   * which is the one place it may never be.
   */
  it.each([
    ['darwin', path.posix.join('/tmp', 'Claudian', 'copilot')],
    ['linux', path.posix.join('/tmp', 'claudian', 'copilot')],
    ['win32', path.win32.join('C:\\Temp', 'Claudian', 'copilot')],
  ] as ReadonlyArray<[NodeJS.Platform, string]>)(
    'answers with a %s platform default when the host names nothing absolute',
    (platform, expected) => {
      jest.mocked(os.homedir).mockReturnValue('person');
      jest.mocked(os.tmpdir).mockReturnValue('temp');

      expect(resolveCopilotHomeDirectory('/vaults/work', {}, platform))
        .toContain(expected);
    },
  );

  /** Whether the vault holds a place, decided the way the named platform would. */
  function holdsPath(platform: NodeJS.Platform, vaultPath: string, candidate: string): boolean {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const fold = (value: string): string => {
      const normalized = paths.normalize(value);
      return platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    const vault = fold(vaultPath);
    const prefix = vault.endsWith(paths.sep) ? vault : `${vault}${paths.sep}`;

    return fold(candidate) === vault || fold(candidate).startsWith(prefix);
  }

  /**
   * An absolute host location still names the vault when the vault holds it — a home, a
   * state directory, or a temporary directory inside the notes, which is what a vault
   * opened on the home directory itself gives. Agent state written there would be
   * indexed, synced, and shared as vault content, so such a candidate names nothing
   * either and the next host root answers.
   */
  it.each([
    [
      'linux',
      '/vaults/work',
      {
        HOME: '/vaults/work',
        TMP: '/var/tmp',
        TMPDIR: '/vaults/work/tmp',
        XDG_STATE_HOME: '/vaults/work/.state',
      },
      { homedir: '/vaults/work', tmpdir: '/vaults/work/tmp' },
      path.posix.join('/var/tmp', 'claudian', 'copilot'),
    ],
    [
      'darwin',
      '/Users/person/Vault',
      { HOME: '/Users/person/Vault/home', TMPDIR: '/Users/person/Vault/tmp' },
      { homedir: '/Users/person/Vault/home', tmpdir: '/var/folders/9x' },
      path.posix.join('/var/folders/9x', 'Claudian', 'copilot'),
    ],
    [
      'win32',
      'C:\\Vault',
      {
        LOCALAPPDATA: 'c:\\vault\\appdata\\local',
        TEMP: 'C:\\Vault\\Temp',
        TMP: 'D:\\Temp',
        USERPROFILE: 'C:\\Vault',
      },
      { homedir: 'C:\\Vault', tmpdir: 'C:\\Vault\\Temp' },
      path.win32.join('D:\\Temp', 'Claudian', 'copilot'),
    ],
  ] as ReadonlyArray<[
    NodeJS.Platform,
    string,
    NodeJS.ProcessEnv,
    { homedir: string; tmpdir: string },
    string,
  ]>)(
    'refuses a %s host location the vault holds',
    (platform, vaultPath, environment, hostPaths, expectedRoot) => {
      jest.mocked(os.homedir).mockReturnValue(hostPaths.homedir);
      jest.mocked(os.tmpdir).mockReturnValue(hostPaths.tmpdir);

      const home = resolveCopilotHomeDirectory(vaultPath, environment, platform);

      expect(home.startsWith(expectedRoot)).toBe(true);
      expect(isAbsoluteFor(platform, home)).toBe(true);
      expect(holdsPath(platform, vaultPath, home)).toBe(false);
    },
  );

  /**
   * With every host location inside the vault, the platform constant answers — and it is
   * held to the same rule, so a vault opened on that constant falls through to the next
   * external one rather than receiving its own notes back.
   */
  it.each([
    ['linux', '/vaults/work', path.posix.join('/tmp', 'claudian', 'copilot')],
    ['linux', '/tmp', path.posix.join('/var/tmp', 'claudian', 'copilot')],
    ['darwin', '/tmp', path.posix.join('/var/tmp', 'Claudian', 'copilot')],
    ['win32', 'C:\\Temp', path.win32.join('C:\\Windows\\Temp', 'Claudian', 'copilot')],
  ] as ReadonlyArray<[NodeJS.Platform, string, string]>)(
    'keeps the %s platform default outside the vault',
    (platform, vaultPath, expectedRoot) => {
      const inVault = platform === 'win32'
        ? `${vaultPath}\\host`
        : path.posix.join(vaultPath, 'host');
      jest.mocked(os.homedir).mockReturnValue(inVault);
      jest.mocked(os.tmpdir).mockReturnValue(inVault);

      const home = resolveCopilotHomeDirectory(vaultPath, {
        HOME: inVault,
        LOCALAPPDATA: inVault,
        TMPDIR: inVault,
        USERPROFILE: inVault,
        XDG_STATE_HOME: inVault,
      }, platform);

      expect(home.startsWith(expectedRoot)).toBe(true);
      expect(holdsPath(platform, vaultPath, home)).toBe(false);
    },
  );

  /**
   * A vault opened on the filesystem root holds every location there is, so there is no
   * answer left that keeps agent state out of the notes. That is said rather than
   * answered with a directory inside the vault.
   */
  it.each([
    ['linux', '/'],
    ['darwin', '/'],
    ['win32', 'C:\\'],
  ] as ReadonlyArray<[NodeJS.Platform, string]>)(
    'refuses to place %s session state when the vault holds the whole host',
    (platform, vaultPath) => {
      expect(() => resolveCopilotHomeDirectory(vaultPath, {}, platform))
        .toThrow(/outside/i);
    },
  );

  /**
   * The store is keyed by the vault path alone, so a vault that pushes the answer onto
   * another host root keeps the identity the CLI's session data is filed under.
   */
  it('keys the store by vault however the host root was chosen', () => {
    jest.mocked(os.homedir).mockReturnValue('/vaults/work/home');
    jest.mocked(os.tmpdir).mockReturnValue('/var/tmp');

    const pushedOut = resolveCopilotHomeDirectory(
      '/vaults/work',
      { HOME: '/vaults/work/home' },
      'linux',
    );
    const hosted = resolveCopilotHomeDirectory('/vaults/work', { HOME: '/home/person' }, 'linux');

    expect(path.posix.basename(pushedOut)).toBe(path.posix.basename(hosted));
  });
});

/**
 * A host location the vault holds is refused whichever name it is reached by. A vault, a
 * home, and a temporary directory are all reached through links on a real host — macOS
 * puts every temporary directory behind `/var`, which is a link to `/private/var`, and a
 * vault kept on an external disk or a synced folder is commonly a link itself — so a
 * comparison of spellings alone calls a directory the vault physically holds external and
 * writes this vault's agent state into its own notes.
 */
describe('resolveCopilotHomeDirectory through links', () => {
  const actualOs = jest.requireActual<NodeOs>('node:os');

  /**
   * Symlink creation needs a privilege Windows does not grant by default, so what needs a
   * real link runs where every host can make one, and the alias-like host is injected.
   */
  const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;
  const hostDirectoryName = process.platform === 'linux' ? 'claudian' : 'Claudian';

  /** A host that reads `/var` as the link to `/private/var` that macOS makes it. */
  const withPrivateVarAlias: CopilotPathCanonicalizer = (value, platform) => {
    const absolute = toAbsoluteCopilotPath(value, platform);
    if (!absolute) {
      return null;
    }
    return absolute === '/var' || absolute.startsWith('/var/')
      ? `/private${absolute}`
      : absolute;
  };

  let temporaryRoot: string | null = null;

  afterEach(() => {
    if (temporaryRoot) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  });

  function makeTemporaryRoot(): string {
    temporaryRoot = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'claudian-copilot-home-'));
    return temporaryRoot;
  }

  it('refuses a host location the vault holds under the canonical name for it', () => {
    jest.mocked(os.homedir).mockReturnValue('/private/var/notes/home');
    jest.mocked(os.tmpdir).mockReturnValue('/private/var/notes/tmp');

    const home = resolveCopilotHomeDirectory(
      '/var/notes',
      { HOME: '/private/var/notes/home', TMPDIR: '/private/var/notes/tmp' },
      'darwin',
      withPrivateVarAlias,
    );

    expect(home.startsWith(path.posix.join('/tmp', 'Claudian', 'copilot'))).toBe(true);
  });

  /**
   * Where no canonical name can be read — an unreadable root, a host location that names
   * nothing — the spelling is all there is, and the lexical answer stands. It still keeps
   * agent state out of every place the vault is spelled as holding.
   */
  it('keeps the lexical answer where the host cannot say', () => {
    jest.mocked(os.homedir).mockReturnValue('/private/var/notes/home');
    jest.mocked(os.tmpdir).mockReturnValue('/private/var/notes/tmp');

    const home = resolveCopilotHomeDirectory(
      '/var/notes',
      { HOME: '/private/var/notes/home' },
      'darwin',
      () => null,
    );

    expect(home.startsWith(path.posix.join(
      '/private/var/notes/home',
      'Library',
      'Application Support',
      'Claudian',
      'copilot',
    ))).toBe(true);
  });

  describeOnPosix('on a host with real links', () => {
    it('refuses a host location that is a link into the vault', () => {
      const root = makeTemporaryRoot();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(path.join(vault, 'state'), { recursive: true });
      const linkedHome = path.join(root, 'home');
      fs.symlinkSync(path.join(vault, 'state'), linkedHome);
      const external = path.join(root, 'external');
      fs.mkdirSync(external);
      jest.mocked(os.homedir).mockReturnValue(linkedHome);
      jest.mocked(os.tmpdir).mockReturnValue(external);

      const home = resolveCopilotHomeDirectory(
        vault,
        { HOME: linkedHome, XDG_STATE_HOME: linkedHome },
        process.platform,
      );

      expect(home.startsWith(path.join(external, hostDirectoryName, 'copilot'))).toBe(true);
      expect(home.startsWith(linkedHome)).toBe(false);
    });

    it('refuses a host location inside a vault that is itself reached through a link', () => {
      const root = makeTemporaryRoot();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(path.join(vault, 'home'), { recursive: true });
      const linkedVault = path.join(root, 'notes');
      fs.symlinkSync(vault, linkedVault);
      const external = path.join(root, 'external');
      fs.mkdirSync(external);
      jest.mocked(os.homedir).mockReturnValue(path.join(vault, 'home'));
      jest.mocked(os.tmpdir).mockReturnValue(external);

      const home = resolveCopilotHomeDirectory(
        linkedVault,
        { HOME: path.join(vault, 'home'), XDG_STATE_HOME: path.join(vault, 'home') },
        process.platform,
      );

      expect(home.startsWith(path.join(external, hostDirectoryName, 'copilot'))).toBe(true);
      expect(home.startsWith(vault)).toBe(false);
    });
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
