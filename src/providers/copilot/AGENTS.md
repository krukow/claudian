# Copilot Provider

`src/providers/copilot/` adapts the GitHub Copilot CLI through `@github/copilot-sdk` over
a stdio JSON-RPC subprocess.

Only the runtime and model foundation is here: the SDK boundary, the CLI the SDK is handed,
the environment that CLI runs with, the model catalog, and the provider settings those
answers are persisted in. There is no execution pipeline, history service, settings UI,
capability set, or registration yet, so nothing in this directory is reachable from
`src/main.ts` and no Copilot conversation can be created. Describe what these modules do,
not what a later layer will do with them.

## Dependency Boundary

- `sdk/CopilotSdkPort.ts` is the only description of `@github/copilot-sdk` the rest of the
  provider may depend on. `sdk/copilotSdkModule.ts` and `sdk/CopilotSdkRuntime.ts` are the
  only modules that import the SDK. Tests substitute a runtime through that port, so the
  SDK and the `copilot` CLI stay the only mocked boundary.
- Provider settings, models, and SDK payloads stay provider-owned until normalized into
  core contracts.

## Ownership

| Component | Owns |
| --- | --- |
| `sdk/CopilotSdkRuntime` | SDK construction, the SDK defaulting mode, the start and shutdown bounds, and every capability switched off for Claudian |
| `sdk/CopilotNativeBudget` | How long a cold start and any one native acquisition or release may take, and what silence means |
| `sdk/CopilotClientFactory` | CLI resolution, runtime environment, client identity, and the auth gate |
| `sdk/CopilotRuntimeError` | Failure categorization onto `ProviderExecutionErrorCategory`, and what each category leaves unusable |
| `runtime/CopilotCliResolver` | Discovering the user-installed `copilot` binary from settings and the host |
| `runtime/CopilotCliEntry` | Narrowing a discovered path to the executable the SDK is handed, and requiring it to be absolute |
| `runtime/CopilotNativeCliBinary` | Where an npm install's native platform binary lives |
| `runtime/CopilotRuntimeEnvironment` | `COPILOT_HOME` placement, the CLI process environment, and the canonical form of a configured environment |
| `runtime/CopilotModelDiscoveryService` | Its own short-lived client and the discovered catalog |
| `env/CopilotSettingsReconciler` | The runtime-input fingerprint and what a change to it invalidates |
| `models.ts` | Model id encoding, catalog normalization, reasoning efforts, context-window reading, and catalog equality |
| `settings.ts` | Persisted provider settings, their defaults, their fail-closed decoding, and the merge that leaves other layers' fields alone |
| `app/CopilotWorkspaceServices` | Publishing a discovered catalog only under the runtime it was discovered from |

## Runtime Rules

- The `copilot` CLI is user-installed and mandatory. Never resolve, bundle, or distribute
  the CLI that ships inside the SDK: an unresolvable binary is a configuration failure.
- The path handed to the SDK is always absolute and normalized, whether it was configured,
  found on the host's PATH, or resolved out of an npm install. The SDK spawns the CLI with
  the vault as the working directory, so a relative path names a note, an attachment, or a
  synced folder rather than an install, and the same setting would mean a different program
  in every vault. `runtime/CopilotCliEntry` gates that before it reads anything else from
  the path; a configured path that is still relative after expansion fails closed rather
  than falling through to host discovery, because the CLI that then ran would not be the
  one settings named. On Windows only a drive-qualified or UNC path counts, which is the
  same distinction a launcher's own references are read with: `\tools\copilot.exe` and
  `C:copilot.exe` resolve against the working directory's drive, which is the vault's.
- The SDK spawns a CLI path that ends in a lowercase `.js` through `process.execPath`,
  which under Obsidian is Electron, and anything else directly. `runtime/CopilotCliEntry`
  narrows a discovered path to one of those two shapes — resolving the npm `copilot.cmd`
  launcher to the package's JavaScript entry, rewriting a `.JS` suffix to the spelling the
  SDK recognises, and failing closed when it names nothing resolvable — and the
  environment sets `ELECTRON_RUN_AS_NODE` for the JavaScript shape.
  `isCopilotJavaScriptEntrypoint` mirrors the SDK's own lowercase test rather than
  matching without regard to case, because telling Electron to behave as Node for a path
  the SDK would launch directly only hides the failure. The suffix rewrite is allowed only
  where the filesystem identifies both spellings as one file, by device and inode:
  existence does not say that, since a case-sensitive filesystem can hold two different
  programs under the two names, and `realpath` resolves symlinks while leaving the
  spelling as given, so on macOS it reports two paths for one file. Claudian never spawns
  the CLI itself; the SDK owns `windowsHide`. That is enforced by the spawn gate in
  `scripts/check-architecture-boundaries.test.mjs`, which reads the syntax tree rather
  than the name, so `pattern.exec(line)` passes and a real spawn does not. It reads every
  route to the module — import, re-export, `require`, dynamic `import`, and
  `process.getBuiltinModule` — and reports a specifier it cannot resolve rather than
  passing it.
- Every supported npm install lands on `@github/copilot`'s `npm-loader.js`, which only
  `spawnSync`s the platform package's native binary. The SDK owns and force-stops the
  process it started, so handing it the loader would leave it stopping a Node process
  whose native child keeps running. `runtime/CopilotNativeCliBinary` resolves
  `@github/copilot-<platform>-<arch>` the way the loader's own module resolution would —
  nested first, then outward through every `node_modules` above it — and that binary is
  what reaches the SDK. A POSIX install puts a symlink on PATH rather than the launcher,
  so the link is followed before the name is read. A Copilot install with no platform
  package fails closed; a `npm-loader.js` belonging to another package is left alone,
  because this rule is about the CLI Claudian drives. Resolving the binary rather than
  spawning it keeps process ownership with the SDK: do not add a provider-side spawn.
- A launcher names its target relative to the directory it lives in, through `%~dp0`,
  `%dp0%` after a `SET dp0` line, `$basedir`, or `$PSScriptRoot`, and a launcher under
  `node_modules\.bin` points at the package beside it with a parent-relative path. All of
  those shapes resolve; a reference that names no directory is accepted only inside
  `node_modules`, so a `.js` word in a comment cannot become the CLI path.
- Only the stdio transport is supported. The in-process FFI transport, the BYOK request
  forwarder, and the SQLite session store are replaced with fail-closed stubs at bundle
  time by `scripts/copilotSdkBundleEnvelope.js`, which also keeps the native `koffi`
  addon out of the bundle. `sdk/CopilotSdkRuntime` is written against that envelope, so
  adding an SDK feature that reaches those modules requires revisiting it, not deleting
  it.
- The client is constructed with `mode: 'empty'`, so the SDK's ambient CLI behaviour is
  opted into rather than inherited: the default `copilot-cli` mode hands a session the
  coding agent's own tool set, instruction discovery, and cross-session capabilities, and
  the switches turned off below would only hold for as long as that list kept pace with
  the CLI. Empty mode also makes two things contractual, which is why the port requires
  them rather than leaving them to a later layer: a data directory of Claudian's own, and
  an explicit `availableTools` list on every session. `baseDirectory` is checked for
  content as well as presence, because the SDK only tests that one was supplied and an
  empty one leaves `COPILOT_HOME` unset, which puts this vault's agent state in the
  user's shared `~/.copilot`. Empty mode also flips tool filter precedence to deny-wins,
  so an `excludedTools` entry overrides the same tool in `availableTools`; a later
  execution layer reads its own tool list that way rather than the other way round.
- Remote sessions, remote export, MCP apps, the built-in session store, host git
  operations, embedding retrieval, memory, infinite sessions, scheduling, and file hooks
  are switched off explicitly in `sdk/CopilotSdkRuntime` rather than left to an empty-mode
  default, and never at call sites.
- The CLI does not inherit `process.env`. It receives a small forwarded base, then the
  configured entries the allow-list in `runtime/CopilotRuntimeEnvironment` names, and
  finally `COPILOT_HOME`, `PATH`, and `ELECTRON_RUN_AS_NODE`, which Claudian pins.
- What the vault may set and what only the host may set are two different lists. Proxy
  reachability and TLS trust are inherited from the host process and never configurable:
  they decide where an already-signed-in CLI sends its requests and which certificates it
  accepts, and provider settings are plain text in a vault that syncs and can be shared,
  so a `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS` entry there would be enough to route that
  CLI through someone else's proxy or make it trust someone else's certificate authority.
  The host process environment is trusted for them because it is the environment the user
  already runs Obsidian in. That leaves locale as the only configurable category, and it
  is an allow-list rather than a denial list because a denial list has to keep pace with
  every switch a CLI release adds. Adding a key to it is a security decision: it must be
  non-secret, must not choose where the CLI connects or what it trusts, must not name an
  endpoint the CLI would present a credential to, and must not make Node or Electron load
  code, attach a debugger, or change its bootstrap, because the CLI launches through
  `process.execPath`. Configured entries are matched without regard to case and written
  under the allow-list's own spelling, because Windows resolves environment variables
  that way and a second spelling would sit beside the forwarded value instead of
  replacing it.
- `resolveCopilotConfigurableEnvironment` is the one answer to what a configured
  environment is: the allow-listed entries under the allow-list's spelling, the last of
  two spellings winning, ordered by key. Everything that has to agree on that goes through
  it, so a caller that read the settings text instead would disagree with the process that
  was started.
- No vault setting contributes to `PATH`, at either end. `resolveCopilotTrustedPath`
  builds the CLI process PATH from the host's own resolution and the CLI Claudian
  resolved, and `runtime/CopilotCliResolver` discovers the binary through the configured
  CLI path or that same host resolution. The CLI resolves everything it runs against that
  PATH — the Node interpreter for a JavaScript entry, Git, a shell, the executables a
  turn's tools call — so a PATH typed into the vault would choose them for a CLI that is
  already signed in. An install the host cannot resolve names its CLI path explicitly;
  Obsidian's minimal GUI environment is still covered, because `getEnhancedPath` searches
  the host's own Homebrew, nvm, volta, and fnm locations.
- Nothing else reaches the CLI from either side, so every switch that would let the
  runtime act without asking — `COPILOT_ALLOW_ALL`, `COPILOT_ASSISTED_APPROVAL`, the
  `GITHUB_COPILOT_PROMPT_MODE_*` trust switches, the instruction, skill, and MCP
  discovery directories, and `COPILOT_CLI_PATH` — is refused by construction rather than
  by being named.
- Claudian owns no GitHub credential. Sign-in belongs to the CLI and its keychain entry,
  and provider environment entries are persisted in plain text inside the vault, so no
  token key is configurable. A key the provider accepts is a key it offers to store, so
  accepting a token key would be offering to keep one.
- `COPILOT_HOME` is a per-vault directory under the OS application-state location, keyed
  by a hash of the vault path. Copilot session state is agent data, not vault content, so
  it must never live under the vault — including under `.claudian/`.

## Failure and Budget Rules

- The failure category alone decides recoverability and what native state is dropped, in
  `sdk/CopilotRuntimeError`. It is decided where the failure is observed rather than by
  matching SDK message text downstream, and a transport, process-exit, or authentication
  failure drops the client so the next runtime starts fresh and re-runs the auth gate.
  `ENOENT` is read as a wrong CLI path before the process-exit shape, because a CLI that
  cannot be spawned is fixed in settings, not by retrying.
- Two SDK failures carry no category and no keyword the categorizer reads, so each is
  matched by its whole message shape rather than by a word in it: the turn that never
  reached `session.idle`, and `Copilot CLI not found at <path>.`, which the SDK throws
  when the path it was handed names nothing. The second is a configuration failure, not
  the transport failure its call site would otherwise report — the CLI cannot be
  reinstalled by sending the turn again. Both shapes are quoted from the SDK; an SDK
  upgrade that rewords either one silently returns it to the fallback category, so check
  them when the SDK moves.
- `CopilotClient.stop` resolves with the errors it hit rather than rejecting. A stop that
  did not do all of it — reported errors, rejected, or never answered — escalates to a
  forced stop and is reported, because the CLI was killed rather than shut down.
- A client no caller will ever be handed is always force-stopped after the graceful
  attempt, and nothing that escalation hits may replace the failure the caller is already
  being given. `abandonCopilotClient` does that for a client the factory gave up on, and
  `sdk/CopilotSdkRuntime` does it for a start that went silent; a discovery probe's own
  client is shut down for the same reason, so a failed discovery leaves no CLI running.
- Every native call that acquires something from a runtime that is already up — the
  authentication gate and the model catalog here — is bounded by the release budget in
  `sdk/CopilotNativeBudget`, because an acquisition nothing interrupts holds its caller
  open and holds whatever is queued behind it open with it. A client that arrives after
  the budget belongs to nobody and is released where it arrives: `acquireNativeWithin`
  carries the resource so that release has something to act on. Silence acquiring is the
  same transport failure as silence releasing, from `copilotNativeSilenceError`, and it
  drops the runtime rather than reusing state whose condition the CLI never reported.
- Starting a client is the exception, and runs on the longer startup budget instead. A
  start is not a release: spawning the CLI, waiting for it to listen, and handshaking
  versions is cold work a first launch, a slow disk, or a virus scanner stretches well
  past what a running runtime would ever take to answer, and `@github/copilot-sdk` allows
  thirty seconds for its own half of it. Bounding a start on the release budget would
  abandon CLIs that were about to answer.
- A shutdown is bounded inside `sdk/CopilotSdkRuntime` rather than by its caller: a client
  being stopped is discarded either way, so the SDK boundary is both enough and the only
  place that covers every caller. Do not add a second bound at a call site. The start of a
  raw SDK client is bounded there for the same reason and one more: it is the only native
  call made while that client is still private to the module, so a bound anywhere else
  would be waiting on a process it was never handed and could not stop. A start that goes
  silent kills the CLI and returns no client. `sdk/CopilotClientFactory` bounds its own
  start too, because it owns the CLI resolution and environment work wrapped around the
  runtime's start, and both bounds use the startup budget: a shorter one outside would cut
  the cold start the inner one is still waiting out.
- An abort and a disconnect are left to their caller to bound, because the caller has to
  decide what a silent runtime means for a session it might still reuse. The port says so;
  do not bind them to a budget here.

## Model and Settings Rules

- `COPILOT_REASONING_EFFORTS` mirrors the SDK's `ReasoningEffort` union exactly. Persisted
  and discovered efforts are validated against it so an unknown value never reaches
  `setModel`.
- Only explicitly enabled models are selectable. There is no synthetic entry, no hidden
  session model, and no provider-default fallback when the enabled list is empty.
- Persisted provider configuration is untrusted input. Every field is decoded, and an
  empty catalog is read as "not rediscovered yet" rather than as authority: a selection,
  its order, its aliases, and its reasoning preferences are retained across an
  invalidation and dropped only against a catalog that has models in it.
- `updateCopilotProviderSettings` merges into the persisted provider configuration rather
  than replacing it. That configuration is one object shared with every layer built on
  this one, so a field this module does not know about belongs to a layer that does, or to
  a newer Claudian than the vault is currently opened with.
- A context window is a token count, read as whole tokens and validated after flooring
  rather than before it, in both the discovered catalog and the custom limits typed into
  settings. A fractional value is positive right until it is floored, and a window of zero
  is what every caller then divides a turn's budget by.
- Catalog equality compares every field, not the id. A model whose context window,
  display name, reasoning efforts, or vision support changed is written back rather than
  hidden behind an id that stayed the same.
- The environment fingerprint in `env/CopilotSettingsReconciler` names the CLI path and
  the configured environment the CLI receives, resolved through
  `resolveCopilotConfigurableEnvironment` rather than read as settings text: the
  allow-list decides which entries exist, case decides which of two spellings is the same
  variable, and order decides which of them wins, so the text would give one identity to
  two settings that start different CLIs and two identities to settings that start the
  same one. The host-inherited base is deliberately outside it — no vault edit moves it,
  and Obsidian is restarted to change it. A change to the fingerprint clears the
  discovered catalog and invalidates live Copilot sessions.
- Model discovery uses its own short-lived client so it never contends with a chat
  session, and drops models the account policy disables. The fingerprint is captured
  before discovery starts and revalidated inside the conditional settings transaction that
  would publish the catalog, because transactions are serialized and a check made outside
  one can be outrun by an edit queued ahead of it. A catalog the user's own edits outran is
  discarded rather than persisted under inputs it was never discovered under.
- The fingerprint says what the runtime inputs are, not whether they held still, and the
  probe resolves its own CLI path and environment after the fingerprint is taken. Settings
  that changed and changed back while the CLI was answering produce the fingerprint
  discovery started under while the catalog belongs to the runtime in between, so the
  provider's execution generation — which moves once per runtime settings transition and
  never moves back — is captured and revalidated beside the fingerprint. Read that
  generation from `executionLifecycleRegistry`; a revision persisted in settings would
  duplicate it and would have to be kept correct twice.
