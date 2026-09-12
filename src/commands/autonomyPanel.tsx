import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@anthropic/ink';
import { Dialog } from '@anthropic/ink';
import { useRegisterOverlay } from '../context/overlayContext.js';
import type { LocalJSXCommandOnDone } from '../types/command.js';
import { getAutonomyCommandText, getAutonomyDeepSectionText, getAutonomyStatusText } from '../cli/handlers/autonomy.js';
import { listAutonomyFlows, type AutonomyFlowRecord } from '../utils/autonomyFlows.js';
import { t } from '../i18n/index.js';

type AutonomyAction = {
  label: string;
  description: string;
  run: () => Promise<string>;
};

const BASE_AUTONOMY_PANEL_ACTION_COUNT = 14;
const ACTION_LABEL_COLUMN_WIDTH = 24;

export function getAutonomyPanelBaseActionCountForTests(): number {
  return BASE_AUTONOMY_PANEL_ACTION_COUNT;
}

function AutonomyPanel({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  useRegisterOverlay('autonomy-panel');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [flows, setFlows] = useState<AutonomyFlowRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listAutonomyFlows().then(items => {
      if (!cancelled) setFlows(items.slice(0, 5));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const actions = useMemo<AutonomyAction[]>(() => {
    const base: AutonomyAction[] = [
      {
        label: t('Overview'),
        description: t('Show run and flow counts plus the latest automatic activity'),
        run: () => getAutonomyStatusText(),
      },
      {
        label: t('Full deep status'),
        description: t('Print every local autonomy surface in one diagnostic report'),
        run: () => getAutonomyStatusText({ deep: true }),
      },
      {
        label: t('Auto mode'),
        description: t('Check whether auto permission mode is available and why'),
        run: () => getAutonomyDeepSectionText('auto-mode'),
      },
      {
        label: t('Runs summary'),
        description: t('Show queued/running/completed/failed run totals and latest run'),
        run: () => getAutonomyDeepSectionText('runs'),
      },
      {
        label: t('Recent runs'),
        description: t('List recent autonomy run IDs, triggers, statuses, and prompts'),
        run: () => getAutonomyCommandText('runs 10'),
      },
      {
        label: t('Flows summary'),
        description: t('Show managed flow totals across queued/running/waiting states'),
        run: () => getAutonomyDeepSectionText('flows'),
      },
      {
        label: t('Recent flows'),
        description: t('List recent managed flow IDs, status, current step, and goal'),
        run: () => getAutonomyCommandText('flows 10'),
      },
      {
        label: t('Cron'),
        description: t('Show scheduled autonomy jobs, durability, recurrence, and next run'),
        run: () => getAutonomyDeepSectionText('cron'),
      },
      {
        label: t('Workflow runs'),
        description: t('Show persisted WorkflowTool runs and their current workflow step'),
        run: () => getAutonomyDeepSectionText('workflow-runs'),
      },
      {
        label: t('Teams'),
        description: t('Show Agent Teams, teammate backends, activity, and open tasks'),
        run: () => getAutonomyDeepSectionText('teams'),
      },
      {
        label: t('Pipes'),
        description: t('Show UDS/named-pipe and LAN registry for terminal messaging'),
        run: () => getAutonomyDeepSectionText('pipes'),
      },
      {
        label: t('Runtime'),
        description: t('Show daemon state and live background or interactive sessions'),
        run: () => getAutonomyDeepSectionText('runtime'),
      },
      {
        label: t('Remote Control'),
        description: t('Show bridge mode, base URL, token presence, and entitlement note'),
        run: () => getAutonomyDeepSectionText('remote-control'),
      },
      {
        label: t('RemoteTrigger'),
        description: t('Show recent remote trigger audit records, failures, and latest call'),
        run: () => getAutonomyDeepSectionText('remote-trigger'),
      },
    ];

    const flowActions = flows.flatMap<AutonomyAction>(flow => {
      const shortId = flow.flowId.slice(0, 8);
      const items: AutonomyAction[] = [
        {
          label: t('Flow {{id}}', { id: shortId }),
          description: t('{{status}}: {{goal}}', { status: flow.status, goal: flow.goal }),
          run: () => getAutonomyCommandText(`flow ${flow.flowId}`),
        },
      ];
      if (flow.status === 'waiting') {
        items.push({
          label: t('Resume {{id}}', { id: shortId }),
          description: flow.currentStep
            ? t('Resume waiting step: {{step}}', { step: flow.currentStep })
            : t('Resume waiting flow'),
          run: () =>
            getAutonomyCommandText(`flow resume ${flow.flowId}`, {
              enqueueInMemory: true,
            }),
        });
      }
      if (
        flow.status === 'queued' ||
        flow.status === 'running' ||
        flow.status === 'waiting' ||
        flow.status === 'blocked'
      ) {
        items.push({
          label: t('Cancel {{id}}', { id: shortId }),
          description: t('Cancel {{status}} flow', { status: flow.status }),
          run: () =>
            getAutonomyCommandText(`flow cancel ${flow.flowId}`, {
              removeQueuedInMemory: true,
            }),
        });
      }
      return items;
    });

    return [...base, ...flowActions];
  }, [flows]);

  const selectCurrent = () => {
    const action = actions[selectedIndex];
    if (!action) return;
    void action.run().then(result => {
      onDone(result, { display: 'system' });
    });
  };

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex(index => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(index => Math.min(actions.length - 1, index + 1));
      return;
    }
    if (key.return) {
      selectCurrent();
    }
  });

  return (
    <Dialog
      title={t('Autonomy')}
      subtitle={t('{{count}} actions', { count: actions.length })}
      onCancel={() => onDone(t('Autonomy panel dismissed'), { display: 'system' })}
      color="background"
      hideInputGuide
    >
      <Box flexDirection="column">
        {actions.map((action, index) => (
          <Box key={`${action.label}-${index}`} flexDirection="row">
            <Text>{`${index === selectedIndex ? '›' : ' '} ${action.label}`.padEnd(ACTION_LABEL_COLUMN_WIDTH)}</Text>
            <Text dimColor>{action.description}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>{t('↑/↓ select · Enter run · Esc close')}</Text>
        </Box>
      </Box>
    </Dialog>
  );
}

export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  const trimmed = args?.trim() ?? '';
  if (trimmed) {
    const result = await getAutonomyCommandText(trimmed, {
      enqueueInMemory: true,
      removeQueuedInMemory: true,
    });
    onDone(result, { display: 'system' });
    return null;
  }

  return <AutonomyPanel onDone={onDone} />;
}
