import {
  normalizeCopilotResourcesByHost,
  normalizeCopilotResourceSettings,
} from '@/providers/copilot/resources/CopilotResourceSettings';

it('defaults MCP sign-in storage on for new and existing hosts while preserving an explicit off choice', () => {
  const settings = normalizeCopilotResourcesByHost({
    laptop: { rememberMcpSignIns: true },
    desktop: { selectedMcpServers: [{ configPath: '/home/user/mcp.json', name: 'notes' }] },
    optedOut: { rememberMcpSignIns: false },
    malformed: { rememberMcpSignIns: 'true' },
    malformedHost: 'not-a-host-selection',
  });

  expect(normalizeCopilotResourceSettings(undefined).rememberMcpSignIns).toBe(true);
  expect(settings.laptop.rememberMcpSignIns).toBe(true);
  expect(settings.desktop.rememberMcpSignIns).toBe(true);
  expect(settings.optedOut.rememberMcpSignIns).toBe(false);
  expect(normalizeCopilotResourcesByHost(settings).optedOut.rememberMcpSignIns).toBe(false);
  expect(settings.malformed.rememberMcpSignIns).toBe(false);
  expect(settings.malformedHost.rememberMcpSignIns).toBe(false);
  expect(settings.malformedHost.selectedMcpServers).toEqual([]);
});

it('keeps valid repository skill opt-outs per computer without changing empty defaults', () => {
  const settings = normalizeCopilotResourcesByHost({
    laptop: { disabledRepositorySkillPaths: ['/repo/.github/skills/review/SKILL.md', '', 7, '/repo/.github/skills/review/SKILL.md'] },
    desktop: { disabledRepositorySkillPaths: 'not-a-list' },
  });

  expect(settings.laptop.disabledRepositorySkillPaths).toEqual(['/repo/.github/skills/review/SKILL.md']);
  expect(settings.desktop.disabledRepositorySkillPaths).toBeUndefined();
});
