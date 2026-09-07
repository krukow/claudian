import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { CopilotCommandLoader } from '@/providers/copilot/app/CopilotCommandLoader';
import { CopilotCommandMetadataProbe } from '@/providers/copilot/app/CopilotCommandMetadataProbe';
import { createCopilotWorkspaceServices } from '@/providers/copilot/app/CopilotWorkspaceServices';
import { updateCopilotProviderSettings } from '@/providers/copilot/settings';
import { getHostnameKey } from '@/utils/env';

import {
  createDeferred,
  FakeCopilotSdkClient,
  FakeCopilotSdkRuntime,
} from '../sdk/FakeCopilotSdkRuntime';

const VAULT_PATH = '/vault';

let skillRoot = '';

beforeEach(async () => {
  skillRoot = await mkdtemp(path.join(os.tmpdir(), 'copilot-command-loader-'));
});

afterEach(async () => {
  await rm(skillRoot, { force: true, recursive: true });
});

async function writeSkill(name: string): Promise<string> {
  const skillPath = path.join(skillRoot, name, 'SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, `---\nname: ${name}\n---\nbody\n`, 'utf8');
  return skillPath;
}

function createHost(selectedSkillPaths: string[] = []): ProviderHost {
  const settings: Record<string, unknown> = {};
  updateCopilotProviderSettings(settings, {
    discoveredModels: [{
      contextWindow: 200_000,
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: [],
      supportsReasoning: false,
      supportsVision: false,
    }],
    enabled: true,
    resourcesByHost: {
      [getHostnameKey()]: {
        additionalMcpConfigPaths: [],
        additionalSkillRoots: [],
        selectedMcpServers: [],
        selectedSkillPaths,
      },
    },
    visibleModels: ['gpt-5'],
  });

  return {
    app: { vault: { adapter: { basePath: VAULT_PATH } } },
    getResolvedProviderCliPath: async () => '/usr/local/bin/copilot',
    settings,
  } as unknown as ProviderHost;
}

function loaderContext(): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: true,
    conversation: null,
    externalContextPaths: [],
    plugin: {} as ProviderHost,
  };
}

describe('CopilotCommandLoader', () => {
  it('offers no commands until a skill is selected', async () => {
    const skillPath = await writeSkill('review');
    const probe = new CopilotCommandMetadataProbe(createHost());

    expect(new CopilotCommandLoader(probe).isAvailable(
      createHost().settings as unknown as Record<string, unknown>,
    )).toBe(false);
    expect(new CopilotCommandLoader(probe).isAvailable(
      createHost([skillPath]).settings as unknown as Record<string, unknown>,
    )).toBe(true);
  });

  /**
   * A fingerprint is a cache identity that is kept and compared long after the listing it
   * belongs to, so the skills it names are digested rather than spelled out.
   */
  it('names the selection without carrying the paths it names', async () => {
    const skillPath = await writeSkill('review');
    const loader = new CopilotCommandLoader(new CopilotCommandMetadataProbe(createHost()));
    const settings = createHost([skillPath]).settings as unknown as Record<string, unknown>;

    const fingerprint = loader.getCacheFingerprint(settings);

    expect(fingerprint).not.toContain(skillPath);
    expect(fingerprint).not.toEqual(loader.getCacheFingerprint(
      createHost().settings as unknown as Record<string, unknown>,
    ));
    loader.requestRefresh();
    expect(loader.getCacheFingerprint(settings)).not.toEqual(fingerprint);
  });

  /**
   * The listing runs on a client and a session of its own, and leaves neither behind: the
   * native session was Claudian's own lease, so it is deleted rather than left in the
   * user's history.
   */
  it('lists the selected skills on its own runtime and leaves nothing running', async () => {
    const skillPath = await writeSkill('review');
    const client = new FakeCopilotSdkClient({
      onSessionCreated: (session) => {
        session.skillCommands = [{ description: 'Review a note', name: 'review' }];
      },
    });
    const runtime = new FakeCopilotSdkRuntime(() => client);
    const probe = new CopilotCommandMetadataProbe(createHost([skillPath]), { runtime });

    const result = await new CopilotCommandLoader(probe).loadCommands(loaderContext());

    expect(result).toEqual({
      items: [{
        content: '',
        description: 'Review a note',
        id: 'copilot-skill-review',
        kind: 'skill',
        name: 'review',
        source: 'sdk',
        userInvocable: true,
      }],
      status: 'ready',
    });
    expect(client.lastSession?.config.model).toBe('gpt-5');
    expect(client.lastSession?.config.resources).toEqual({
      mcpServers: {},
      skillDirectories: [path.dirname(skillPath)],
    });
    expect(client.lastSession?.config.availableTools).toEqual([]);
    expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
    expect(client.stopped).toBe(1);
  });

  it.each(['disconnect', 'delete', 'stop'] as const)(
    'reports %s cleanup failure rather than publishing a successful listing',
    async (step) => {
      const skillPath = await writeSkill('review');
      const failure = async (): Promise<never> => { throw new Error(`${step} failed`); };
      const client = new FakeCopilotSdkClient({
        ...(step === 'delete' ? { deleteSessionBehavior: failure } : {}),
        ...(step === 'stop' ? { stopBehavior: failure } : {}),
        onSessionCreated: session => {
          session.skillCommands = [{ name: 'review' }];
          if (step === 'disconnect') {
            session.disconnectBehavior = failure;
          }
        },
      });
      const probe = new CopilotCommandMetadataProbe(createHost([skillPath]), {
        runtime: new FakeCopilotSdkRuntime(() => client),
      });

      const result = await new CopilotCommandLoader(probe).loadCommands(loaderContext());

      expect(result.status).toBe('error');
      expect(client.stopped).toBe(1);
    },
  );

  it('reports an unreadable selected skill instead of caching an empty listing', async () => {
    const runtime = new FakeCopilotSdkRuntime();
    const probe = new CopilotCommandMetadataProbe(
      createHost([path.join(skillRoot, 'missing', 'SKILL.md')]), { runtime },
    );

    const result = await new CopilotCommandLoader(probe).loadCommands(loaderContext());

    expect(result.status).toBe('error');
    expect(runtime.clients).toEqual([]);
  });

  it('starts no runtime when nothing is selected', async () => {
    const runtime = new FakeCopilotSdkRuntime();
    const probe = new CopilotCommandMetadataProbe(createHost(), { runtime });

    const result = await new CopilotCommandLoader(probe).loadCommands(loaderContext());

    expect(result).toEqual({ status: 'empty' });
    expect(runtime.clients).toEqual([]);
  });

  it('drains an active metadata probe before disposing workspace services', async () => {
    const skillPath = await writeSkill('review');
    const entered = createDeferred();
    const release = createDeferred();
    const client = new FakeCopilotSdkClient({
      sessionGate: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const host = createHost([skillPath]);
    const probe = new CopilotCommandMetadataProbe(host, {
      runtime: new FakeCopilotSdkRuntime(() => client),
    });
    const workspace = createCopilotWorkspaceServices(host, { commandMetadataProbe: probe });
    const listing = probe.load();
    await entered.promise;
    let disposed = false;
    const disposal = Promise.resolve(workspace.dispose?.()).then(() => { disposed = true; });
    await Promise.resolve();
    await Promise.resolve();
    const disposedWhileOpening = disposed;
    release.resolve();
    await Promise.all([listing, disposal]);

    expect(disposedWhileOpening).toBe(false);
    expect(client.deletedSessions).toEqual([client.lastSession?.sessionId]);
    expect(client.stopped).toBe(1);
  });
});
