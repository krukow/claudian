import type { ProviderExecutionEvent } from '../../../core/execution';

/**
 * A provider execution event before its scope is stamped.
 *
 * `Omit` collapses a discriminated union into a single object type, which loses the
 * per-variant payloads, so the omission is distributed over the union members instead.
 */
export type CopilotExecutionEventDraft = ProviderExecutionEvent extends infer TEvent
  ? TEvent extends ProviderExecutionEvent
    ? Omit<TEvent, 'scope'>
    : never
  : never;
