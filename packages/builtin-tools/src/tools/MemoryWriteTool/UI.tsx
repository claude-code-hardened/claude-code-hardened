import * as React from 'react';
import { Text } from '@anthropic/ink';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { OutputLine } from 'src/components/shell/OutputLine.js';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';

// Shared, intentionally minimal renderers for the memory_write /
// memory_list / memory_read trio. Following LocalMemoryRecallTool's UI
// contract: the second `options` parameter matches the Tool interface
// (theme/verbose/commands) even though we don't differentiate on it.

type ProgressMessages = ProgressMessage<ToolProgressData>[];

interface WriteUseInput {
  store?: string;
  path?: string;
  content?: string;
}

interface ReadListUseInput {
  store?: string;
  path?: string;
}

interface WriteOutput {
  outcome?: 'ok' | 'error';
  store?: string;
  path?: string;
  bytes?: number;
  created?: boolean;
  error?: string;
}

interface ListOutput {
  store?: string;
  docs?: { path: string; name: string; type: string; description?: string }[];
  truncated?: boolean;
  error?: string;
}

interface ReadOutput {
  store?: string;
  path?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
}

export function renderToolUseMessage(
  tool: 'write' | 'list' | 'read',
  input: Partial<WriteUseInput & ReadListUseInput>,
  _options: { theme?: unknown; verbose?: boolean; commands?: unknown } = {},
): React.ReactNode {
  void _options;
  const store = input.store ? ` ${input.store}` : '';
  if (tool === 'write') {
    const path = input.path ? ` ${input.path}` : '';
    return `write${store}${path}`;
  }
  if (tool === 'read') {
    const path = input.path ? ` ${input.path}` : '';
    return `read${store}${path}`;
  }
  return `list${store}`;
}

export function renderErrorResult(error: string): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text color="error">Error: {error}</Text>
    </MessageResponse>
  );
}

export function renderMemoryWriteResult(
  output: WriteOutput,
  _progressMessagesForMessage: ProgressMessages,
  _options: { verbose: boolean; theme?: unknown },
): React.ReactNode {
  void _progressMessagesForMessage;
  void _options;
  if (output.error) return renderErrorResult(output.error);
  const status = output.created ? '(new)' : '(overwritten)';
  return (
    <MessageResponse height={1}>
      <Text>
        Wrote {output.bytes ?? 0} bytes to {output.store}/{output.path} {status}
      </Text>
    </MessageResponse>
  );
}

export function renderMemoryListResult(
  output: ListOutput,
  _progressMessagesForMessage: ProgressMessages,
  _options: { verbose: boolean; theme?: unknown },
): React.ReactNode {
  void _progressMessagesForMessage;
  void _options;
  if (output.error) return renderErrorResult(output.error);
  const docs = output.docs ?? [];
  if (docs.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>(No memory documents in {output.store ?? '?'})</Text>
      </MessageResponse>
    );
  }
  const lines = docs.map(d => `${d.path} [${d.type}] ${d.description ?? d.name}`);
  if (output.truncated) lines.push('… (truncated)');
  return (
    <MessageResponse height={Math.min(lines.length, 10)}>
      <Text>{lines.join('\n')}</Text>
    </MessageResponse>
  );
}

export function renderMemoryReadResult(
  output: ReadOutput,
  _progressMessagesForMessage: ProgressMessages,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  void _progressMessagesForMessage;
  if (output.error) return renderErrorResult(output.error);
  // eslint-disable-next-line no-restricted-syntax -- human-facing UI
  return <OutputLine content={output.content ?? ''} verbose={verbose} />;
}

export type { WriteOutput, ListOutput, ReadOutput };
