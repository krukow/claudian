# Claudian

<p>
  <a href="https://trendshift.io/repositories/21115?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-21115">
    <img align="right" src="https://trendshift.io/api/badge/repositories/21115" alt="Claudian on Trendshift" width="180">
  </a>
  <img src="https://img.shields.io/github/stars/YishenTu/claudian" alt="GitHub stars" vspace="10">
  <a href="https://community.obsidian.md/plugins/realclaudian">
    <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&amp;query=%24%5B%22realclaudian%22%5D.downloads&amp;label=downloads&amp;logo=obsidian&amp;color=7C3AED" alt="Obsidian downloads" vspace="10">
  </a>
  <img src="https://img.shields.io/github/v/release/YishenTu/claudian" alt="GitHub release" vspace="10">
  <img src="https://img.shields.io/github/license/YishenTu/claudian" alt="License" vspace="10">
  <br clear="both">
</p>

![Preview](assets/Preview.png)

An Obsidian plugin that embeds AI coding agents (Claude Code, Codex, Grok, Opencode, Pi, and more to come) in your vault. Your vault becomes the agent's working directory — file read/write, search, bash, and multi-step workflows all work out of the box. Visit [claudian.md](https://claudian.md/) to learn more.

## Features & Usage

Open the chat sidebar from the ribbon icon or command palette. Select text and use the hotkey for inline edit. Everything works like your familiar coding agent, Claude Code, Codex, Grok, Opencode, and Pi — talk to the agent, and it reads, writes, edits, and searches files in your vault.

**Inline Edit** — Select text or start at the cursor position + hotkey to edit directly in notes with word-level diff preview.

**Slash Commands & Skills** — Type `/` or `$` for reusable prompt templates or Skills from user- and vault-level scopes.

**`@mention`** - Type `@` to mention anything you want the agent to work with, including vault files, subagents, and files in external directories.

**Plan Mode** — Toggle via `Shift+Tab`. The agent explores and designs before implementing, then presents a plan for approval.

**Instruction Mode (`/instruction`)** — Refined custom instructions added from the chat input.

**MCP Servers** — Connect external tools through each coding agent's native CLI-managed MCP configuration.

**Tabs & Session Management** — Use multiple tabs in single-panel mode or a persistent session manager beside the chat in dual-pane mode.

**Stop a Response** — Select **Stop** in the running chat's composer or press **Esc**. Only that tab's response is cancelled; the conversation and queued or draft input are preserved. **Stopping...** stays disabled until cancellation settles. Rewind is not interrupted by this control.

**Collab Mode** (Experimental) — Collaborate on shared projects with other Claudian users. [Learn more](https://claudian.md/docs/collab-mode/).

## Requirements

- At least one of the following harnesses:
  - [Claude Code CLI](https://code.claude.com/docs/en/overview)
  - [Codex CLI](https://github.com/openai/codex)
  - [Grok Build](https://github.com/xai-org/grok-build)
  - [OpenCode](https://github.com/anomalyco/opencode)
  - [Pi](https://github.com/earendil-works/pi)
  - [GitHub Copilot CLI](https://docs.github.com/copilot) — see [Copilot provider](docs/copilot-provider.md) for the supported CLI versions, sign-in, and capabilities
- A compatible subscription or API provider, such as [OpenRouter](https://openrouter.ai/docs/guides/guides/claude-code-integration), [Kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi), [GLM](https://docs.z.ai/devpack/tool/claude), or [DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) etc.
- Obsidian v1.13.0+
- Desktop only (macOS, Linux, Windows)
- Collab Mode requires [Git](https://git-scm.com/install/)

## Installation

### From Obsidian Community Plugins (upstream)

Community Plugins installs upstream Claudian, not this fork's Copilot integration. To install this fork, use the [from-source guide](docs/copilot-provider.md#install-this-fork-from-source-on-a-new-computer).

1. Open Obsidian → Settings → Community plugins → Browse
2. Search for "Claudian" and click Install
3. Enable the plugin

Or install directly from the [community plugin page](https://community.obsidian.md/plugins/realclaudian).

### From source (this fork)

Follow [Install this fork from source on a new computer](docs/copilot-provider.md#install-this-fork-from-source-on-a-new-computer) for [krukow/claudian](https://github.com/krukow/claudian) on `main`. Use Node.js 24.16.0 and `npm ci`, build outside the vault with auto-copy disabled, and copy only `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/realclaudian`. The Copilot CLI is a separate user-installed prerequisite.

### Development

```bash
# Watch mode
npm run dev

# Production build
npm run build
```

## Privacy & Data Use

- **Model requests**: The selected provider receives your prompt and relevant context, such as note excerpts, supported attachments, and tool results. Requests go to Anthropic (Claude), OpenAI (Codex), xAI (Grok), GitHub (Copilot), or the service configured for OpenCode or Pi. Some providers let you change the destination.
- **Plugin telemetry**: Claudian does not send analytics of its own. Editor selection polling stays on your device. Provider CLIs and MCP servers you connect can make network requests under their own policies.
- **Collab LAN traffic**: When you explicitly Host or synchronize a Collab Project, Project Git data and authenticated coordination metadata travel directly between invited teammates' devices on the local network. Collab Mode itself does not send Project data to a Claudian cloud service or any third party.

### GitHub Copilot

**Claudian turns off cloud transcript sync, not model requests.** These settings apply to Copilot sessions opened by Claudian, not to your standalone CLI or other providers.

- **Local history:** The CLI stores the transcript outside your vault in a directory specific to that vault. Claudian reads it when you reopen a chat. Claudian also saves conversation metadata and can save prompt text in `.claudian/sessions/` inside the vault; your vault sync and backup settings apply to those files.
- **GitHub session history:** Every time Claudian creates or resumes a session, it waits for the CLI to disable transcript export and remote control before sending a prompt. If the CLI cannot confirm that, Claudian does not send the prompt. This does not delete a copy already synced or shared elsewhere.
- **Telemetry and usage:** Claudian disables the CLI's per-session telemetry. That setting does not cover CLI startup or sign-in diagnostics. GitHub still processes your model requests and can record the request ID, model, token counts, and timing. A usage record is not a synced conversation, and turning off sync does not set the service's data retention policy.

See [where Copilot stores transcripts and how to check for a synced copy](docs/copilot-provider.md#data-storage-and-network).

## Troubleshooting

The following sections use Claude Code as an example.

### Provider CLI not found

If Claudian cannot auto-detect a provider CLI, verify that the CLI is installed and available to GUI applications through PATH. Typical errors include `spawn claude ENOENT` and `Claude CLI not found`. This issue is common with Node version managers (nvm, fnm, volta).

Leave the CLI path setting empty first so Claudian can auto-detect the CLI. If auto-detection fails, find the executable path and set it in Settings → Advanced → Claude CLI path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which claude` | `/Users/you/.volta/bin/claude` |
| Windows (native) | `where.exe claude` | `C:\Users\you\AppData\Local\Claude\claude.exe` |
| Windows (npm) | `npm root -g` | `{root}\@anthropic-ai\claude-code\cli-wrapper.cjs` |

> **Note**: On Windows, avoid `.cmd` and `.ps1` wrappers. Use `claude.exe` for native installs, or `cli-wrapper.cjs` for package-manager installs. `cli.js` is only a legacy fallback for older Claude Code npm packages.

**Alternative**: Add your Node.js bin directory to PATH in Settings → Environment → Custom variables.

### npm CLI and Node.js not in the same directory

When using an npm-installed provider CLI, make sure its executable and Node.js are available from the same environment. Check their paths:

```bash
dirname $(which claude)
dirname $(which node)
```

If the paths differ, GUI apps like Obsidian may not find Node.js.

Either:

1. Install the native binary (recommended).
2. Add the Node.js path in Settings → Environment: `PATH=/path/to/node/bin`.

### More help

For provider-specific installation and configuration guidance, refer to the provider documentation linked in the [Requirements](#requirements) section. Copilot has its own page: [Copilot provider](docs/copilot-provider.md). If you have a feature request or run into a bug, please [submit a GitHub issue](https://github.com/YishenTu/claudian/issues).

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── app/                         # Application services, storage, and lazy Collab infrastructure
├── core/                        # Provider-neutral runtime, registry, and type contracts
│   ├── runtime/                 # ChatRuntime interface and approval types
│   ├── providers/               # Provider registry and workspace services
│   ├── auxiliary/               # Shared provider auxiliary services
│   ├── bootstrap/               # Plugin bootstrap wiring
│   ├── security/                # Approval utilities
│   └── ...                      # commands, prompt, storage, tools, types
├── providers/
│   ├── claude/                  # Claude SDK adaptor, prompt encoding, storage, MCP, plugins
│   ├── codex/                   # Codex app-server adaptor, JSON-RPC transport, JSONL history
│   ├── grok/                    # Grok Build ACP adaptor, native history, models, and tools
│   ├── opencode/                # Opencode adaptor
│   ├── pi/                      # Pi RPC adaptor, model discovery, JSONL history
│   └── acp/                     # Agent Client Protocol shared transport
├── features/
│   ├── chat/                    # Sidebar chat: tabs, controllers, renderers
│   ├── collab/                  # Collab sidebar, review, conflict, and access UI
│   ├── inline-edit/             # Inline edit modal and provider-backed edit services
│   └── settings/                # Settings shell with provider tabs
├── shared/                      # Reusable UI components and modals
├── i18n/                        # Internationalization (10 locales)
├── types/                       # Shared ambient types
├── utils/                       # Cross-cutting utilities
└── style/                       # Modular CSS
```

## Contributing

Issues and focused pull requests are welcome. Issues are the preferred starting point: describe the problem, reproduction steps, and environment clearly so it can be investigated.

Before opening a pull request, please read the [contribution guide](CONTRIBUTING.md). Pull requests must explain the problem, the proposed solution, why the approach is appropriate, and how the change was validated. Pull requests that add a new provider are not accepted; the guide explains this maintenance and product-quality boundary in detail.

## Star History

<a href="https://www.star-history.com/?repos=YishenTu%2Fclaudian&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=YishenTu/claudian&type=date&theme=dark&legend=top-left&sealed_token=UAS9n3qO4GyhCCkOr9kcAl7msVtDEz-DoQTkpFuPrAELxMEK9PQWj9zG566afbx0CkF5OoIbLRkxiDIoMRCK5Q-HXbLUiimg1lT8wKDdcc_eP48_EodHFrR6UtY8jS7Mzik4lLd_sY8oVj2I42lISFB1tSlr4gnXwOCNwtTn6iQakbru7yKPIO3uVYpP" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=YishenTu/claudian&type=date&legend=top-left&sealed_token=UAS9n3qO4GyhCCkOr9kcAl7msVtDEz-DoQTkpFuPrAELxMEK9PQWj9zG566afbx0CkF5OoIbLRkxiDIoMRCK5Q-HXbLUiimg1lT8wKDdcc_eP48_EodHFrR6UtY8jS7Mzik4lLd_sY8oVj2I42lISFB1tSlr4gnXwOCNwtTn6iQakbru7yKPIO3uVYpP" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=YishenTu/claudian&type=date&legend=top-left&sealed_token=UAS9n3qO4GyhCCkOr9kcAl7msVtDEz-DoQTkpFuPrAELxMEK9PQWj9zG566afbx0CkF5OoIbLRkxiDIoMRCK5Q-HXbLUiimg1lT8wKDdcc_eP48_EodHFrR6UtY8jS7Mzik4lLd_sY8oVj2I42lISFB1tSlr4gnXwOCNwtTn6iQakbru7yKPIO3uVYpP" />
 </picture>
</a>

## Sponsorship

### Kimi (Moonshot AI)

<img src="https://gcdn.moonshot.cn/growth-cdn/sponsor/kimi-en.png" alt="Kimi (Moonshot AI)" width="90%">

Thanks to Kimi (Moonshot AI), our Open Source Friend, for supporting Claudian! With 2.8T parameters, native vision, and a
1-million-token context window, Kimi K3 delivers frontier performance across long-horizon coding, knowledge work, and
reasoning.

New users receive bonus API credits equal to 10% of their first successful top-up. Use the discount link for the
[CN](https://platform.kimi.com?track_id=track-1f391886e67141d4866ff9d261767ee7&aff=claudian) or
[Global](https://platform.kimi.ai?track_id=track-9800ef0cb7f444b1b33371617443c186&aff=claudian) platform. This offer
ends September 30, 2026. Claudian receives no affiliate commission from these links.

### Ke Holdings Inc. (BEIKE)

<img src="assets/sponsors/MOMA.png" alt="MOMA" width="90%">

Claudian is proudly sponsored by Ke Holdings Inc. (BEIKE) and the MOMA team. Their support helps Claudian continue to improve through ongoing development and maintenance.

> Want to support Claudian or appear here? Contact me: [tysk01213@gmail.com](mailto:tysk01213@gmail.com).

## License

Licensed under the [MIT License](LICENSE).
