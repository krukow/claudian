import { normalizeCopilotResourcesByHost } from '@/providers/copilot/resources/CopilotResourceSettings';

it('remembers MCP authentication only after an explicit per-computer opt-in', () => {
  const settings = normalizeCopilotResourcesByHost({
    laptop: { rememberMcpSignIns: true },
    desktop: { rememberMcpSignIns: 'true' },
  });

  expect(settings.laptop.rememberMcpSignIns).toBe(true);
  expect(settings.desktop.rememberMcpSignIns).toBeUndefined();
});

it('keeps valid repository skill opt-outs per computer without changing empty defaults', () => {
  const settings = normalizeCopilotResourcesByHost({
    laptop: { disabledRepositorySkillPaths: ['/repo/.github/skills/review/SKILL.md', '', 7, '/repo/.github/skills/review/SKILL.md'] },
    desktop: { disabledRepositorySkillPaths: 'not-a-list' },
  });

  expect(settings.laptop.disabledRepositorySkillPaths).toEqual(['/repo/.github/skills/review/SKILL.md']);
  expect(settings.desktop.disabledRepositorySkillPaths).toBeUndefined();
});
