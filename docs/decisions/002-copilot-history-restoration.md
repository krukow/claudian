# ADR 002: Read-only Copilot history restoration

Status: Accepted

Date: 2026-11-02

## Context

Claudian persists conversation metadata and accepted inputs, not a second copy of provider transcripts. Restoring a Copilot conversation therefore requires reading its native history. History selection must not acquire an execution session or start MCP servers.

## Decision

Use the provider-owned `CopilotHistoryStore` to read `session-state/<sessionId>/events.jsonl` from the exact per-vault home used by `CopilotClientFactory`. Keep SDK execution and history projection separate. Do not start or resume the CLI to read history, scan other homes, or accept a persisted filesystem locator.

Validate the file's session identity and every consumed event, and reject paths outside the vault's Copilot home. Project main-agent aggregate messages, readable reasoning, and tool results into the existing chat types. Ignore transient deltas and internal/subagent messages. Preserve populated in-memory conversations and let `ConversationRepository` attach accepted-input context through its existing hydration contract. A failed read leaves the conversation and native files unchanged and can be retried.

The committed synthetic fixtures preserve event shapes observed in native Claudian sessions; they contain no original message text. Native history support enables `/resume`, not fork, rewind, or cross-device history.

## Consequences

Existing local conversations can be restored without account access or a running CLI. There is no transcript migration or duplicated message storage. Missing or malformed files produce a load error instead of an apparently empty chat.

This depends on Copilot's on-disk event format. Reconsider direct reads if the SDK provides an offline, read-only transcript API that does not acquire a session or enable its bundled runtime/filesystem facilities.
