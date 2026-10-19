import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text, type TextProps } from '@anthropic/ink';
import { extractTag } from '../../utils/messages.js';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

function getStatusColor(status: string | null): TextProps['color'] {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'killed':
      return 'warning';
    default:
      return 'text';
  }
}

// CCH #52/#50/#46 静默面：官方复活通知（userResumeNotice→passive）在
// CCH 里随信使文本携带 passive 标记（构造处 resumeAgent.ts 写入属性），
// 渲染面判定到即静默不弹提示 —— 消息本体照常投递给模型。
const PASSIVE_MARKER = '<task-notification passive="true">';

export function UserAgentNotificationMessage({ addMargin, param: { text } }: Props): React.ReactNode {
  if (text.includes(PASSIVE_MARKER)) return null;
  const summary = extractTag(text, 'summary');
  if (!summary) return null;

  const status = extractTag(text, 'status');
  const color = getStatusColor(status);

  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color={color}>{BLACK_CIRCLE}</Text> {summary}
      </Text>
    </Box>
  );
}
