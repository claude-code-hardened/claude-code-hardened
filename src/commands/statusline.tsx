import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { Command } from '../commands.js';
import { AGENT_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/AgentTool/constants.js';
import { t } from '../i18n/index.js';

const statusline = {
  type: 'prompt',
  description: t("Set up Claude Code's status line UI"),
  contentLength: 0, // Dynamic content
  aliases: [],
  name: 'statusline',
  progressMessage: t('setting up statusLine'),
  allowedTools: [AGENT_TOOL_NAME, 'Read(~/**)', 'Edit(~/.claude/settings.json)'],
  source: 'builtin',
  disableNonInteractive: true,
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim() || 'Configure my statusLine from my shell PS1 configuration';
    return [
      {
        type: 'text',
        text: `Create an ${AGENT_TOOL_NAME} with subagent_type "statusline-setup" and the prompt "${prompt}"`,
      },
    ];
  },
} satisfies Command;

export default statusline;
