import type {
  ProviderExecutionRequest,
  ProviderToolPolicy,
} from '../../../core/execution';
import { buildSystemPrompt } from '../../../core/prompt/mainAgent';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendLinkedContent, appendLinkedContentBody } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import type { CopilotReasoningEffort } from '../models';
import type { CopilotSdkSystemMessage } from '../sdk/CopilotSdkPort';
import {
  COPILOT_ALLOWABLE_BUILTIN_TOOLS,
  COPILOT_READ_ONLY_TOOL_FILTERS,
  COPILOT_UNSUPPORTED_TOOL_FILTERS,
} from './CopilotBuiltinTools';

export interface CopilotToolSelection {
  /**
   * Explicit allow-list. An empty array denies every tool.
   *
   * Stated for every policy, because the port requires it: a session without one asks the
   * CLI for its own ambient defaults, which is the behaviour the whole runtime is built
   * to keep out.
   */
  readonly availableTools: readonly string[];
  readonly excludedTools?: readonly string[];
}

export interface CopilotSystemPromptSettings {
  readonly customPrompt?: string;
  readonly mediaFolder?: string;
  readonly userName?: string;
  readonly vaultPath?: string;
}

/** Every builtin the CLI registers, and nothing an MCP server or custom agent added. */
const COPILOT_EVERY_BUILTIN_FILTER = 'builtin:*';

/**
 * Translates the provider-neutral tool policy into the SDK's tool selection.
 *
 * Every branch names what it allows: `passive` denies every tool, `read-only` names the
 * tools it allows rather than the ones it denies — so a builtin this Copilot release
 * added, a platform-specific shell, or any MCP or custom tool is unavailable instead of
 * permitted — `allow-list` is qualified and validated the same way rather than handing raw
 * names to the CLI, and the policies that restrict nothing say so as the widest pattern
 * the SDK defines for one source rather than by staying silent. No branch ever passes
 * `--allow-all` or an equivalent global bypass, and `unrestricted` still routes through
 * the approval prompt.
 *
 * The two widest policies are the only ones that need a deny-list, because
 * `builtin:*` matches the task and factory families the narrower policies simply never
 * name. Claudian surfaces neither, so a turn that started one would run work the user can
 * neither watch nor stop.
 */
export function encodeToolSelection(policy: ProviderToolPolicy): CopilotToolSelection {
  switch (policy.kind) {
    case 'passive':
      return { availableTools: [] };
    case 'read-only':
      return { availableTools: COPILOT_READ_ONLY_TOOL_FILTERS };
    case 'allow-list':
      return { availableTools: encodeAllowedTools(policy.names) };
    case 'provider-default':
    case 'unrestricted':
      return {
        availableTools: [COPILOT_EVERY_BUILTIN_FILTER],
        excludedTools: COPILOT_UNSUPPORTED_TOOL_FILTERS,
      };
  }
}

/**
 * Narrows an allow-list to the builtins the captured catalog knows, qualified to
 * `builtin:` exactly as the read-only list is.
 *
 * The names arrive in provider-neutral terms, so they are answered from what the CLI
 * offered rather than passed through: a name qualified to another source is not the
 * builtin the caller meant, one the catalog does not know is a tool Claudian can say
 * nothing about, and one from the agent or factory families is excluded from every
 * policy. All three are dropped, so an allow-list that names nothing Copilot offers
 * denies every tool rather than every restriction.
 */
function encodeAllowedTools(names: readonly string[]): readonly string[] {
  const allowed = new Set<string>();
  for (const name of names) {
    const builtin = decodeBuiltinToolName(name);
    if (builtin && COPILOT_ALLOWABLE_BUILTIN_TOOLS.has(builtin)) {
      allowed.add(`builtin:${builtin}`);
    }
  }
  return [...allowed];
}

/** The builtin a name refers to, or null when it names another source or nothing. */
function decodeBuiltinToolName(name: string): string | null {
  const normalized = name.trim();
  const bare = normalized.startsWith(BUILTIN_TOOL_PREFIX)
    ? normalized.slice(BUILTIN_TOOL_PREFIX.length).trim()
    : normalized;
  return bare && !bare.includes(':') ? bare : null;
}

const BUILTIN_TOOL_PREFIX = 'builtin:';

/**
 * Builds the session's system message. An explicit instruction set replaces the CLI's own
 * prompt; the provider-default path appends Claudian's shared main-agent prompt.
 */
export function encodeSystemMessage(
  request: ProviderExecutionRequest,
  settings: CopilotSystemPromptSettings,
): CopilotSdkSystemMessage {
  const instructions = request.configuration.systemInstructions;
  if (instructions.kind === 'explicit') {
    return { content: instructions.instructions, mode: 'replace' };
  }

  return {
    content: buildSystemPrompt(
      {
        customPrompt: settings.customPrompt,
        mediaFolder: settings.mediaFolder,
        userName: settings.userName,
        vaultPath: settings.vaultPath,
      },
      instructions.dynamicSections
        ? { dynamicSections: [...instructions.dynamicSections] }
        : {},
    ),
    mode: 'append',
  };
}

/**
 * Flattens the request's input blocks into the prompt text the CLI receives, followed by
 * the context the turn was sent with.
 *
 * The CLI reads the vault itself, but only the prompt says which note the question is
 * about and what the user had selected when they asked it, so the same context every
 * other provider carries is written in the same shared format.
 */
export function encodePrompt(request: ProviderExecutionRequest): string {
  let prompt = request.input
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  const context = request.context;
  if (context?.linkedContent) {
    prompt = context.linkedContent.content === undefined
      ? appendLinkedContent(prompt, context.linkedContent.path)
      : appendLinkedContentBody(
        prompt,
        context.linkedContent.path,
        context.linkedContent.content,
      );
  }
  if (context?.editorSelection && context.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, context.editorSelection);
  }
  if (context?.browserSelection) {
    prompt = appendBrowserContext(prompt, context.browserSelection);
  }
  if (context?.canvasSelection) {
    prompt = appendCanvasContext(prompt, context.canvasSelection);
  }
  return prompt;
}

/**
 * Names the input a Copilot turn cannot carry, or null when all of it fits.
 *
 * The CLI receives a text prompt and `COPILOT_PROVIDER_CAPABILITIES` advertises no image
 * support, so an attached image reaches nothing. Sending the turn anyway without saying
 * so would answer a question about a picture the model never saw, which reads as a wrong
 * answer rather than a missing capability.
 */
export function describeUnsupportedInput(
  request: ProviderExecutionRequest,
): string | null {
  const images = request.input
    .filter((block): block is Extract<typeof block, { type: 'image' }> => (
      block.type === 'image'
    ))
    .map(block => block.image.name)
    .filter(name => name);
  if (images.length === 0) {
    return null;
  }
  return `Copilot cannot read image attachments, so ${images.join(', ')} `
    + `${images.length === 1 ? 'was' : 'were'} not sent with this message.`;
}

/** Directories the session may reach beyond the vault working directory. */
export function encodeAdditionalDirectories(
  request: ProviderExecutionRequest,
): readonly string[] {
  return uniqueStrings([
    ...(request.context?.externalContextPaths ?? []),
    ...(request.configuration.externalWorkspaceRoots ?? []),
  ]);
}

export function encodeReasoningEffort(
  request: ProviderExecutionRequest,
  isSupported: (effort: string) => effort is CopilotReasoningEffort,
): CopilotReasoningEffort | undefined {
  const reasoning = request.configuration.reasoning?.trim();
  return reasoning && isSupported(reasoning) ? reasoning : undefined;
}

/**
 * The inputs that a live SDK session is bound to. A change requires a new session,
 * because the CLI fixes them when the session is created.
 */
export function encodeSessionIdentity(input: {
  readonly additionalDirectories: readonly string[];
  readonly toolSelection: CopilotToolSelection;
  readonly systemMessage: CopilotSdkSystemMessage;
  readonly workingDirectory: string;
}): string {
  return JSON.stringify({
    additionalDirectories: [...input.additionalDirectories].sort(),
    availableTools: [...input.toolSelection.availableTools].sort(),
    excludedTools: input.toolSelection.excludedTools
      ? [...input.toolSelection.excludedTools].sort()
      : null,
    systemMessage: input.systemMessage,
    workingDirectory: input.workingDirectory,
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}
