# Copilot Provider

Claudian can run turns through the GitHub Copilot CLI. This page covers what you need to install, how sign-in works, what the provider can and cannot do, and where its data lives.

The Copilot provider is disabled until you turn it on.

## Requirements

- The GitHub Copilot CLI, installed by you. Claudian never bundles, downloads, or updates it.
- A current Copilot CLI. Claudian uses `@github/copilot-sdk` 1.0.11; native permission modes have been exercised against CLI 1.0.86-2. An older CLI may not implement these APIs even if the SDK exposes them.
- A GitHub account with an active Copilot subscription. **Connect Copilot** handles sign-in.
- In-app connection requires a CLI whose `login` command supports `--web-flow`. Claudian checks this capability before starting sign-in.
- The same Obsidian and desktop requirements as the rest of Claudian.

Install the CLI the way GitHub documents it. A global npm install works:

```bash
npm install -g @github/copilot
copilot --version
```

Claudian resolves an npm install down to the platform binary the launcher would have started, so an npm install needs its `@github/copilot-<platform>-<arch>` package present. Reinstall the CLI if that package is missing.

## Sign-in

Select **Connect Copilot** in Settings > Claudian > Providers > Copilot. Claudian checks existing sign-in, opens GitHub in your browser if needed, discovers your models, and asks you to confirm one. It enables Copilot after that confirmation. Once the CLI is installed, connection requires no terminal commands or API keys.

Claudian runs the CLI with a `COPILOT_HOME` of this vault's own, so this vault's agent state, plugins, and configuration stay out of your shared Copilot install. The credential itself is shared — the CLI keeps one per host in the OS keychain — but the record of which account it belongs to lives in the home it was signed in with. A vault home nobody has signed in to therefore reports itself signed out, however recently you signed in elsewhere.

The CLI performs OAuth and stores credentials in the operating system's credential store. Claudian disables plaintext token storage in this vault's private CLI settings and never requests consent for a plaintext fallback. If secure storage is unavailable, connection fails instead of writing a token into the vault. Global Copilot configuration is not modified.

The browser still requires your GitHub approval and any organization SSO step. If it did not open automatically, use **Open GitHub sign-in** in the connection window. Closing the window or selecting **Cancel** stops the pending login; the browser tab itself is left open. You can retry if authorization expires or the connection is interrupted.

## Setting it up

1. Open Settings > Claudian > Providers > Copilot and select **Connect Copilot**.
2. Complete browser approval if asked.
3. Choose a model and select **Use this model**. Copilot is enabled and the chosen model is used for new chats. Existing chats are unchanged.

After setup, the **Models** section lets you discover additional models, enable them, and drag to order them. Only selected models appear in chat; the first is the provider's default. Existing selections are preserved when you connect again. You can give models aliases and choose supported reasoning efforts.

Leave **CLI path** empty for automatic discovery. Set an absolute path only when the CLI is installed somewhere this computer's PATH does not reach. A configured path is the only one tried, so a moved or removed install fails rather than silently launching a different CLI.

## Using it

- **Chat**: pick a Copilot model in the chat model selector and send a message. Text and reasoning stream as they arrive, tool calls appear as they start and finish, and usage is reported against the model's context window.
- **Tools**: Copilot runs its own built-in tools with the vault as its working directory, not a filesystem sandbox. Claudian narrows them to the ones it can render, and the background-agent and factory families are never available.
- **Approvals**: use the single **Tool approvals** dropdown to choose **Ask**, **LLM judge**, or **Allow all** under Copilot's permission settings. The choice applies to chat on this computer, not auxiliary or restricted turns. Requests without a live owning turn are refused.
- **Questions**: when the CLI asks a question, Claudian shows it with the choices the CLI offered.
- **Context**: the note a message was sent from, the editor selection, and any browser or canvas selection travel with the prompt. Directories you have added as external context are opened to the session alongside the vault.
- **Auxiliary work**: conversation titles, inline edits, and instruction refinement each run as their own short-lived Copilot session, separate from the chat runtime. Their native session data is deleted when the work finishes, and none of them ever starts an MCP server or loads a skill.
- **Skills**: a selected skill's slash command appears in the chat command list. Choosing one asks the CLI to expand it and sends the prompt it produced; your message is shown as you typed it. A message that starts with a slash but names no selected skill is sent as ordinary text.

## Capabilities

| Feature | Copilot |
| --- | --- |
| Streaming text and reasoning | Yes |
| Tool calls with output | Yes |
| Approval prompts and questions | Yes |
| Model selection and reasoning effort | Yes |
| Custom instructions and instruction mode | Yes |
| External directories as context | Yes |
| Conversation titles and inline edit | Yes |
| Image attachments | No — an attached image is reported as unsent rather than dropped |
| Native history browsing and replay | No |
| Rewind and fork | No |
| Plan mode | No |
| Subagents and background agents | No |
| Provider slash commands | Yes — the slash commands of the skills you selected |
| MCP servers | Yes — only the servers you selected, in chat |
| Skills | Yes — only the skill folders you selected, in chat |
| Plugin selection | No — see the plugin isolation limit below |

Unsupported capabilities are not offered in Claudian's UI.

## Permission modes

- **Ask** keeps the ordinary CLI approval prompts.
- **Allow all** uses the CLI's native permission mode to let available tools run commands, read or change files including paths outside the vault, and access unrestricted network destinations and URLs without asking. It does not enable additional tools or MCP servers.
- **LLM judge** uses the native CLI's assisted approval: an affirmative recommendation may approve a request, while uncertain, excluded, failed, or managed-human-approval requests still ask you. The native judge can make additional model requests and uses its own model selection.

These preferences apply only to persistent Copilot chat with a provider-default or unrestricted tool policy on this computer. They do not change global Copilot CLI configuration or another computer's choice. Titles, inline edits, instruction refinement, and restricted tool policies always use Ask.

Claudian configures each created or resumed session through the native `/permissions` command, enabling only the `AUTO_APPROVAL` feature flag for LLM judge. It does not enable general experimental mode or run a custom judge. A CLI that cannot configure the requested mode fails before a turn starts rather than silently using a different mode.

## MCP servers and skills

Copilot chat can use MCP servers and skills that already exist on this computer. Nothing is used until you select it, including anything in the vault.

**How it works**

1. Open Settings → Claudian → Copilot → **Resources**.
2. Optionally add absolute paths under **Additional MCP configuration files** or **Additional skill folders**, for sources outside the standard locations.
3. Click **Discover**. Claudian reads the configuration files and skill folders below and lists what it found, with the source each entry came from.
4. Turn on the servers and skills you want. Selections take effect on the next chat turn: the Copilot CLI is restarted so the change applies before anything starts, and the conversation keeps its Copilot session.

After editing a skill in place, click **Refresh** to reload its native command metadata and rebuild the chat runtime without changing your selections.

**Where Claudian looks**

| Kind | Standard locations |
| --- | --- |
| MCP configuration | `~/.copilot/mcp-config.json`, `<vault>/.mcp.json`, `<vault>/.github/mcp.json` |
| Skills | `~/.copilot/skills/`, `~/.agents/skills/`, `<vault>/.github/skills/`, `<vault>/.agents/skills/`, `<vault>/.claude/skills/` |

An MCP configuration file is the format the Copilot CLI uses: a JSON document with an `mcpServers` map, keyed by server name. A skill is a folder containing `SKILL.md`; Claudian points the CLI at the folder of the skill you selected, so its siblings are not loaded.

**What is stored, and where**

- A selection is stored as a reference — the file a server is declared in plus its name, or the path of a `SKILL.md` — under this computer's own key. The definitions, including commands, arguments, environment entries, URLs, and headers, are read fresh each time a session needs them and are never written into your settings.
- A selection therefore does not travel: syncing the vault to another computer carries the reference but selects nothing there, because that computer's own selection is empty until you make one.
- Claudian never edits your global Copilot configuration, and never adds, removes, or rewrites a server or a skill.

**Limits worth knowing**

- Selecting a server permits connecting to it, independently of tool permissions. A session with no tools receives none of the server's tools. The skill-command discovery session loads only selected skills and does not connect to selected MCP servers.
- Resources reach chat only, and only while the turn's tools are not restricted. A read-only or otherwise narrowed turn, and every title, inline edit, and instruction-refinement run, starts no server and loads no skill.
- Environment entries and headers are passed to the CLI exactly as your configuration file spells them. There is no variable substitution or credential lookup, so a server that needs a secret needs it written literally in the file it is declared in — keep such a file outside the vault and select it as an additional source.
- Server definitions that authenticate through OAuth or OIDC, or that use `deferTools`, are refused with a message naming the field: the pinned SDK cannot carry them, and Claudian will not silently drop the mechanism a server is reached with.
- Only the tools a selected server actually offers are allowed, and a server's own `tools` restriction is kept. A server that is still starting is waited for while the session opens; one that failed, needs authentication, or is disabled contributes no tools and is reported on the turn rather than waited out.
- Skills a selected package did not declare — including the CLI's own built-in skills — are disabled for the session before any turn runs.
- Selecting resources never changes your permission mode. **Ask**, **Allow all**, or **LLM judge** continues to govern the requests they make.

## Data, storage, and network

- **Sent to GitHub**: your message, the context above, the system instructions Claudian builds, and the results of tools the CLI runs. Requests are made by the Copilot CLI to GitHub's Copilot service under your own subscription.
- **Session state**: the CLI writes its own session data under the per-vault `COPILOT_HOME` Claudian creates outside your notes — under `Application Support` on macOS, `%LOCALAPPDATA%` on Windows, and `$XDG_STATE_HOME` or `~/.local/state` on Linux, in a directory named after the vault's path. Claudian treats that data as read-only and never deletes it, except for the short-lived sessions it creates for titles and inline edits.
- **Settings**: Copilot settings live in `.claudian/claudian-settings.json` inside the vault, in plain text. Never put a token or an API key there.
- **Environment**: Claudian forwards a small host environment to the CLI and accepts only `LANG` and `LC_ALL` from provider settings. PATH, proxy reachability, and certificate trust come from the environment Obsidian itself runs in, because a vault syncs and can be shared. `COPILOT_HOME` and PATH are set by Claudian and cannot be overridden.
- **Switched off for every session**: telemetry, the shared on-disk embedding cache, keychain-backed MCP token storage, MCP apps, remote sessions and export, the cross-session store, host git operations, memory, scheduling, file hooks, additional plugin directories, and instruction and configuration discovery outside the vault. MCP servers and skills are off too, except the ones you selected under Resources: every server the CLI would otherwise start from its own configuration is named and disabled before the session opens.
- **Plugin isolation limit**: the SDK mode needed for keychain sign-in does not clear plugins already installed in this vault's `COPILOT_HOME`. Keep that home dedicated to Claudian and do not install CLI plugins into it. Plugins installed there can affect sessions even though Claudian exposes no plugin controls; disabling additional plugin directories does not disable installed plugins.

## Install footprint

Claudian depends on `@github/copilot-sdk`, which declares `@github/copilot` and the native `koffi` FFI addon as ordinary dependencies. Installing Claudian's development dependencies therefore downloads one per-platform Copilot CLI (a few hundred MB unpacked) and the native addon into `node_modules`. That cost is contributor and CI disk only: the published plugin bundles neither, the SDK's own bundled CLI is replaced with a fail-closed stub, and Claudian always runs the CLI you installed yourself. Plugin users download none of it.

## Troubleshooting

**"The Copilot CLI could not be launched"** — the path in settings does not resolve, or nothing named `copilot` is on this computer's PATH. Fix the path, or clear it to let Claudian search. The path must be absolute; a relative one would be read against the vault. On Windows, point it at `copilot.exe` or at the npm install rather than at a `.cmd` launcher, and name a JavaScript entry with a lowercase `.js`.

**"The Copilot CLI is not signed in for this vault"** — select **Connect Copilot** to sign in through your browser. A shared CLI login does not necessarily initialize this vault's private state. Expired credentials and organization SSO requirements may also need browser approval.

**Browser sign-in fails or times out** — retry **Connect Copilot**, complete GitHub's approval, and check that the system credential store is available. Browser sign-in has a five-minute deadline. Claudian does not enable plaintext credential storage as a fallback.

**No models after clicking Discover** — the CLI answered but the account offers none. Check that the signed-in account has an active Copilot subscription and that your organization's policy does not disable every model.

**"Could not load the Copilot model catalog"** — the CLI could not be started or did not answer. Check the CLI path, run `copilot --version` in a terminal, and confirm sign-in.

**Turns fail with a transport error** — the CLI stopped answering and was terminated. Sending the message again starts a fresh one. If it repeats, run the CLI in a terminal with the same `COPILOT_HOME` to see what it reports.

**"Select an enabled Copilot model before starting a turn"** — no Copilot model is selected in settings. Discover the catalog and select at least one.

**A selected server or skill is reported as not found** — the configuration file or skill folder moved, or the server was renamed. The selection is kept rather than removed: fix the file, or clear the selection under Resources. Chat reports the same thing on the turn instead of running as though the resource had answered.

## Native resource smoke

Contributors can exercise the real SDK and installed CLI against synthetic skill packages, local MCP servers, and a loopback-only model fixture:

```bash
CLAUDIAN_COPILOT_RESOURCE_SMOKE_CLI_PATH="/absolute/path/to/copilot" npm run check:copilot-resources -- --runInBand
```

This opt-in smoke uses temporary state homes and no real account credentials or model endpoint. It covers resource isolation, cold resume, MCP approval decisions, native allow-all, Allow all to Ask downgrades on resident and cold-client resumes, affirmative and failed native judge recommendations, and native skill expansion; it does not deploy the plugin or exercise the Obsidian UI.
