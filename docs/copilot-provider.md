# Copilot Provider

Claudian can run turns through the GitHub Copilot CLI. This page covers what you need to install, how sign-in works, what the provider can and cannot do, and where its data lives.

The Copilot provider is disabled until you turn it on.

## Requirements

- The GitHub Copilot CLI, installed by you. Claudian never bundles, downloads, or updates it.
- CLI version 1.0.79 or newer. Claudian talks to the CLI through `@github/copilot-sdk` 1.0.11, which is built against `@github/copilot` 1.0.79, so an older CLI may not speak the protocol the SDK sends. The built-in tool list Claudian filters against was captured on CLI 1.0.83, and a newer CLI is recommended.
- A GitHub account with an active Copilot subscription, signed in through the CLI.
- The same Obsidian and desktop requirements as the rest of Claudian.

Install the CLI the way GitHub documents it. A global npm install works:

```bash
npm install -g @github/copilot
copilot --version
```

Claudian resolves an npm install down to the platform binary the launcher would have started, so an npm install needs its `@github/copilot-<platform>-<arch>` package present. Reinstall the CLI if that package is missing.

## Sign-in

Sign-in belongs to the CLI. Claudian owns no GitHub credential, offers nowhere to store one, and refuses token-shaped environment entries, so there is no API key to paste and no `gh` fallback to configure.

Claudian runs the CLI with a `COPILOT_HOME` of this vault's own, so this vault's agent state, plugins, and configuration stay out of your shared Copilot install. The credential itself is shared — the CLI keeps one per host in the OS keychain — but the record of which account it belongs to lives in the home it was signed in with. A vault home nobody has signed in to therefore reports itself signed out, however recently you signed in elsewhere.

Sign in to the vault's own home once. Claudian names the exact directory in the sign-in error it shows in chat; run the CLI with `COPILOT_HOME` set to that directory and sign in there:

```bash
COPILOT_HOME="<the directory Claudian named>" copilot
```

```powershell
$env:COPILOT_HOME = "<the directory Claudian named>"; copilot
```

Running a bare `copilot` signs in to the shared `~/.copilot` install instead and leaves the vault signed out.

## Setting it up

1. Open Settings → Claudian → Copilot.
2. Turn **Enable Copilot** on.
3. Leave **CLI path** empty to let Claudian find `copilot` on this computer's own PATH. Set it only when the CLI is installed somewhere PATH does not reach. A path that is set is the only one tried, so a moved or removed install fails with an error rather than silently running a different CLI. It must be absolute.
4. Click **Discover** under Models. Claudian asks the CLI which models your account may use and lists them.
5. Select the models you want in the chat model selector, and drag to order them. Only models you select are selectable, and the first one is the provider's default. With none selected, a Copilot turn fails rather than falling back to a model you never turned on.
6. Optionally give a model an alias, and pick a reasoning effort for models that support one. The effort you pick is remembered per model.

## Using it

- **Chat**: pick a Copilot model in the chat model selector and send a message. Text and reasoning stream as they arrive, tool calls appear as they start and finish, and usage is reported against the model's context window.
- **Tools**: Copilot runs its own built-in tools inside your vault. Claudian narrows them to the ones it can render, and the background-agent and factory families are never available.
- **Approvals**: every action the CLI asks permission for is routed to the Claudian approval prompt. There is no blanket allow and no permission-mode switch: approving once and approving for the session are both your choice, and a request that arrives with no live turn is refused.
- **Questions**: when the CLI asks a question, Claudian shows it with the choices the CLI offered.
- **Context**: the note a message was sent from, the editor selection, and any browser or canvas selection travel with the prompt. Directories you have added as external context are opened to the session alongside the vault.
- **Auxiliary work**: conversation titles, inline edits, and instruction refinement each run as their own short-lived Copilot session, separate from the chat runtime. Their native session data is deleted when the work finishes.

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
| Provider slash commands | No |
| Skills and MCP servers | No — disabled in the session configuration |
| Plugin selection | No — see the plugin isolation limit below |

Unsupported capabilities are not offered in Claudian's UI.

## Data, storage, and network

- **Sent to GitHub**: your message, the context above, the system instructions Claudian builds, and the results of tools the CLI runs. Requests are made by the Copilot CLI to GitHub's Copilot service under your own subscription.
- **Session state**: the CLI writes its own session data under the per-vault `COPILOT_HOME` Claudian creates outside your notes — under `Application Support` on macOS, `%LOCALAPPDATA%` on Windows, and `$XDG_STATE_HOME` or `~/.local/state` on Linux, in a directory named after the vault's path. Claudian treats that data as read-only and never deletes it, except for the short-lived sessions it creates for titles and inline edits.
- **Settings**: Copilot settings live in `.claudian/claudian-settings.json` inside the vault, in plain text. Never put a token or an API key there.
- **Environment**: Claudian forwards a small host environment to the CLI and accepts only `LANG` and `LC_ALL` from provider settings. PATH, proxy reachability, and certificate trust come from the environment Obsidian itself runs in, because a vault syncs and can be shared. `COPILOT_HOME` and PATH are set by Claudian and cannot be overridden.
- **Switched off for every session**: telemetry, the shared on-disk embedding cache, keychain-backed MCP token storage, MCP servers and apps, remote sessions and export, the cross-session store, host git operations, memory, scheduling, skills, file hooks, additional plugin directories, and instruction and configuration discovery outside the vault.
- **Plugin isolation limit**: the SDK mode needed for keychain sign-in does not clear plugins already installed in this vault's `COPILOT_HOME`. Keep that home dedicated to Claudian and do not install CLI plugins into it. Plugins installed there can affect sessions even though Claudian exposes no plugin controls; disabling additional plugin directories does not disable installed plugins.

## Install footprint

Claudian depends on `@github/copilot-sdk`, which declares `@github/copilot` and the native `koffi` FFI addon as ordinary dependencies. Installing Claudian's development dependencies therefore downloads one per-platform Copilot CLI (a few hundred MB unpacked) and the native addon into `node_modules`. That cost is contributor and CI disk only: the published plugin bundles neither, the SDK's own bundled CLI is replaced with a fail-closed stub, and Claudian always runs the CLI you installed yourself. Plugin users download none of it.

## Troubleshooting

**"The Copilot CLI could not be launched"** — the path in settings does not resolve, or nothing named `copilot` is on this computer's PATH. Fix the path, or clear it to let Claudian search. The path must be absolute; a relative one would be read against the vault. On Windows, point it at `copilot.exe` or at the npm install rather than at a `.cmd` launcher, and name a JavaScript entry with a lowercase `.js`.

**"The Copilot CLI is not signed in for this vault"** — the vault's own `COPILOT_HOME` has never been signed in to. The error names the directory; sign in with `COPILOT_HOME` set to it, as above. If the message quotes something else from the CLI — an expired credential, a single-sign-on refusal — that is the CLI's own report and usually needs the same command.

**No models after clicking Discover** — the CLI answered but the account offers none. Check that the signed-in account has an active Copilot subscription and that your organization's policy does not disable every model.

**"Could not load the Copilot model catalog"** — the CLI could not be started or did not answer. Check the CLI path, run `copilot --version` in a terminal, and confirm sign-in.

**Turns fail with a transport error** — the CLI stopped answering and was terminated. Sending the message again starts a fresh one. If it repeats, run the CLI in a terminal with the same `COPILOT_HOME` to see what it reports.

**"Select an enabled Copilot model before starting a turn"** — no Copilot model is selected in settings. Discover the catalog and select at least one.
