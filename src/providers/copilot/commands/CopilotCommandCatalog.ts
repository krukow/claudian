import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

/**
 * Copilot's dropdown entries are the skills this computer selected, as the runtime
 * reported them. They are read-only here: a skill is a directory of the user's own, and
 * the Copilot CLI owns creating, editing, and deleting one.
 */
function skillCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.description ? { description: command.description } : {}),
    content: '',
    displayPrefix: '/',
    id: command.id,
    insertPrefix: '/',
    isDeletable: false,
    isEditable: false,
    kind: 'skill',
    name: command.name,
    providerId: 'copilot',
    scope: 'runtime',
    source: 'sdk',
    userInvocable: true,
  };
}

export class CopilotCommandCatalog extends RuntimeCommandCatalog {
  constructor() {
    super({
      dropdownConfig: {
        builtInPrefix: '/',
        commandPrefix: '/',
        providerId: 'copilot',
        skillPrefix: '/',
        triggerChars: ['/'],
      },
      projectEntry: skillCommandToEntry,
    });
  }
}
