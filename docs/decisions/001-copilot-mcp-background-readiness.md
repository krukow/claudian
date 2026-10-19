# ADR 001: Workspace-owned Copilot MCP readiness

Status: Accepted

Date: 2026-10-19

## Context

MCP connection checks start temporary Copilot processes. Serial checks make large selections slow, and tying their lifetime to settings prevents authentication notifications during normal use.

## Decision

Keep scheduling, results, and authentication-notification deduplication in the existing provider-owned `CopilotMcpReadinessCoordinator`. Settings observes that workspace service rather than owning its lifetime. Both manual and automatic checks use the same queue, capped at three simultaneous probes including native cleanup. New work wakes the scheduler to refill idle slots; the shared completion promise drains every worker, including later arrivals.

The SDK runtime owns the native startup deadline and failed-start cleanup. The client factory awaits that full operation instead of imposing another timeout, because a caller-side deadline cannot release a process the caller has not acquired.

The composition root initializes selected, enabled Copilot MCP checks after Obsidian layout readiness, without blocking plugin startup or eagerly initializing other providers. Check after relevant settings changes and completed sign-in, and on returning to a visible Obsidian window with a 15-minute cooldown. Automatic checks require an enabled provider and an available enabled model. Do not add idle polling or filesystem watchers.

Preserve isolated, tool-free sessions and typed native readiness. Notify once for newly authentication-required servers, distinguishing remote browser sign-in from local configuration. Successful connection rearms the notification; transient checking or network failures do not. Never start OAuth automatically.

Provider transitions and workspace disposal drain all active probes, including when one fails to release. Keep selection, configuration, client-identity, and generation fences; an older probe cannot invalidate a newer result.

## Consequences

Selected servers can start before settings or chat is opened, with at most three temporary CLI processes from the readiness queue. Those probes can access the native credential cache and connect to the selected services, but never invoke tools or send model turns.

Settings reuses point-in-time results. Credentials can expire while Obsidian remains active, and external configuration edits are picked up only by a subsequent check or explicit Refresh. The cooldown avoids repeatedly spawning processes on window changes.

Reconsider polling or probe isolation if the native runtime exposes a cheaper, reliable authentication-status subscription or if return-to-app checks prove insufficient.
