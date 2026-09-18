import { Setting } from 'obsidian';

import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import {
  decodeCopilotPermissionMode,
  getCopilotPermissionMode,
  setCopilotPermissionMode,
} from '@/providers/copilot/settings';

export function renderCopilotPermissionSettings(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
): void {
  new Setting(container).setName('Permissions').setHeading();
  const setting = new Setting(container)
    .setName('Tool approvals')
    .setDesc('Applies only to persistent Copilot chat on this computer. Allow all permits '
      + 'available tools to run commands, read or change files (including paths outside the '
      + 'vault), and access unrestricted network destinations and URLs without asking. '
      + 'LLM judge uses the native CLI safety model for approval checks, which '
      + 'can make additional model requests; uncertain or failed checks ask you. Managed '
      + 'approvals always ask. Auxiliary and restricted turns always use Ask. MCP sign-in '
      + 'is separate.');
  const status = container.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });

  setting.addDropdown(dropdown => {
    dropdown.selectEl.setAttribute('aria-label', 'Copilot permissions');
    dropdown
      .addOption('ask', 'Ask')
      .addOption('judge', 'LLM judge')
      .addOption('allow-all', 'Allow all')
      .setValue(getCopilotPermissionMode(context.plugin.settings))
      .onChange(async value => {
        const mode = decodeCopilotPermissionMode(value);
        if (getCopilotPermissionMode(context.plugin.settings) === mode) return;
        dropdown.setDisabled(true);
        status.textContent = 'Saving permission mode...';
        try {
          await context.plugin.applyProviderRuntimeSettings(['copilot'], settings => {
            setCopilotPermissionMode(settings, mode);
          });
          status.textContent = 'Permission mode saved for this computer.';
        } catch (error) {
          status.textContent = `Could not save permission mode: ${
            error instanceof Error ? error.message : String(error)
          }`;
        } finally {
          dropdown.setDisabled(false).setValue(getCopilotPermissionMode(context.plugin.settings));
        }
      });
  });
}
