import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
import { resolveCopilotHomeDirectory } from '../runtime/CopilotRuntimeEnvironment';

export class CopilotHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CopilotHistoryError';
  }
}

export class CopilotHistoryStore {
  async load(sessionId: string, vaultPath: string): Promise<ChatMessage[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new CopilotHistoryError('Invalid Copilot session reference.');
    }

    const home = resolveCopilotHomeDirectory(vaultPath);
    const transcriptPath = path.join(home, 'session-state', sessionId, 'events.jsonl');
    let content: string;
    try {
      const resolvedPath = await fs.realpath(transcriptPath);
      if (!isPathWithinRoot(resolvedPath, home)) {
        throw new CopilotHistoryError('Copilot history is outside this vault\'s session store.');
      }
      content = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      if (error instanceof CopilotHistoryError) throw error;
      throw new CopilotHistoryError(
        'Could not read this chat\'s local Copilot history.',
        { cause: error },
      );
    }
    return parseHistory(content, sessionId);
  }
}

function parseHistory(content: string, sessionId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const tools = new Map<string, ToolCallInfo>();
  let assistant: (ChatMessage & { contentBlocks: ContentBlock[]; toolCalls: ToolCallInfo[] }) | null = null;
  let pendingReasoning: { event: HistoryEvent; text: string } | null = null;
  let hasSessionStart = false;

  const getAssistant = (event: HistoryEvent) => {
    if (!assistant) {
      assistant = {
        id: event.id,
        role: 'assistant',
        content: '',
        timestamp: event.timestamp,
        contentBlocks: [],
        toolCalls: [],
      };
      messages.push(assistant);
    }
    return assistant;
  };
  const flushReasoning = (event: HistoryEvent, aggregate?: string) => {
    const text = aggregate || pendingReasoning?.text;
    if (text) getAssistant(event).contentBlocks.push({ type: 'thinking', content: text });
    pendingReasoning = null;
  };
  const addTool = (
    event: HistoryEvent,
    id: string,
    name: string,
    args: unknown,
  ): void => {
    const existing = tools.get(id);
    if (existing) return;
    const tool: ToolCallInfo = {
      id,
      name,
      input: isRecord(args) ? args : {},
      providerPayload: { rawName: name, rawInput: args },
      status: 'error',
      result: 'Tool execution did not complete.',
    };
    tools.set(id, tool);
    const message = getAssistant(event);
    message.toolCalls.push(tool);
    message.contentBlocks.push({ type: 'tool_use', toolId: id });
  };

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const event = parseEvent(line, index + 1);
    const { data } = event;
    if (!hasSessionStart) {
      if (event.type !== 'session.start' || data.sessionId !== sessionId) {
        throw new CopilotHistoryError('Copilot history does not match the selected session.');
      }
      hasSessionStart = true;
    }
    if (event.hidden) continue;

    switch (event.type) {
      case 'user.message': {
        const source = typeof data.source === 'string' ? data.source : '';
        if (source.startsWith('skill-') || source.startsWith('agent-') || data.isAutopilotContinuation) break;
        flushReasoning(event);
        assistant = null;
        messages.push({
          id: event.id,
          role: 'user',
          content: requireString(data, 'content'),
          timestamp: event.timestamp,
          userMessageId: typeof data.messageId === 'string' ? data.messageId : event.id,
        });
        break;
      }
      case 'assistant.reasoning':
        getAssistant(event);
        pendingReasoning ??= { event, text: '' };
        pendingReasoning.text += requireString(data, 'content');
        break;
      case 'assistant.message': {
        flushReasoning(event, readReasoningText(data));
        const message = getAssistant(event);
        message.assistantMessageId ??= requireString(data, 'messageId');
        const text = requireString(data, 'content');
        if (text) {
          message.content += text;
          message.contentBlocks.push({ type: 'text', content: text });
        }
        if (data.toolRequests !== undefined) {
          if (!Array.isArray(data.toolRequests)) {
            throw new CopilotHistoryError('Invalid Copilot tool requests.');
          }
          for (const request of data.toolRequests) {
            if (!isRecord(request)) throw new CopilotHistoryError('Invalid Copilot tool request.');
            addTool(event, requireString(request, 'toolCallId'), requireString(request, 'name'), request.arguments);
          }
        }
        break;
      }
      case 'tool.execution_start':
        flushReasoning(event);
        addTool(event, requireString(data, 'toolCallId'), requireString(data, 'toolName'), data.arguments);
        break;
      case 'tool.execution_complete': {
        const tool = tools.get(requireString(data, 'toolCallId'));
        if (!tool) break;
        if (typeof data.success !== 'boolean') {
          throw new CopilotHistoryError('Invalid Copilot tool completion.');
        }
        const result = isRecord(data.result) ? data.result : {};
        const error = isRecord(data.error) ? data.error : {};
        tool.status = data.success ? 'completed' : 'error';
        tool.result = readString(result.detailedContent)
          ?? readString(result.content)
          ?? readString(error.message)
          ?? '';
        tool.providerPayload = { ...tool.providerPayload, rawOutput: data };
        break;
      }
      case 'assistant.turn_end':
      case 'abort':
        flushReasoning(event);
        break;
    }
  }
  if (!hasSessionStart) {
    throw new CopilotHistoryError('Copilot history has no session header.');
  }
  if (pendingReasoning) flushReasoning(pendingReasoning.event);
  return messages;
}

interface HistoryEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
  hidden: boolean;
}

function parseEvent(line: string, lineNumber: number): HistoryEvent {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch (error) {
    throw new CopilotHistoryError(`Invalid Copilot history at line ${lineNumber}.`, { cause: error });
  }
  if (!isRecord(event) || !isRecord(event.data)) {
    throw new CopilotHistoryError(`Invalid Copilot history event at line ${lineNumber}.`);
  }
  const timestamp = Date.parse(requireString(event, 'timestamp'));
  if (!Number.isFinite(timestamp)) {
    throw new CopilotHistoryError(`Invalid Copilot history timestamp at line ${lineNumber}.`);
  }
  return {
    id: requireString(event, 'id'),
    type: requireString(event, 'type'),
    data: event.data,
    timestamp,
    hidden: Boolean(event.agentId || event.ephemeral || event.data.parentToolCallId),
  };
}

function readReasoningText(data: Record<string, unknown>): string {
  if (typeof data.reasoningText === 'string' && data.reasoningText) return data.reasoningText;
  const reasoning = isRecord(data.reasoningBlocks) ? data.reasoningBlocks : null;
  if (!Array.isArray(reasoning?.blocks)) return '';
  const text: string[] = [];
  for (const block of reasoning.blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      text.push(block.thinking);
    } else if (block.type === 'reasoning' && Array.isArray(block.summary)) {
      for (const summary of block.summary) {
        if (isRecord(summary) && typeof summary.text === 'string') text.push(summary.text);
      }
    }
  }
  return text.join('\n\n');
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new CopilotHistoryError(`Invalid Copilot history field: ${key}.`);
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
