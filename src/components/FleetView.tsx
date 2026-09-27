import { Box, Text, useInput, useApp } from '../../ink.js';
import { useEffect, useState } from 'react';

/**
 * FleetView —— 官方 `claude agents` 的视图层（1:1 语义还原）
 *
 * 官方证据（binary 2.1.283）：FleetViewWithComposerBack / createFleetViewHost /
 * useAttachFleetOwners；会话 tempo 状态 IDLE_DETAIL / IDLE_NEEDS（blocked）/
 * PRE_BOO(KED) / ABANDONED_WORKER_MS。最小可用版：会话行（short id / name /
 * tempo / blocked needs / cwd）+ 上下键选择 + enter→attach + esc 退出；
 * dispatch（composer）与 teammates 行为后续批。
 */

export interface FleetRow {
  shortId: string;
  name: string;
  kind: string;
  cwd: string;
  tempo: 'running' | 'blocked' | 'idle' | 'booked';
  blockedNeeds?: string;
}

export function FleetView({
  rows,
  onAttach,
}: {
  rows: FleetRow[];
  onAttach?: (row: FleetRow) => void;
}): React.ReactNode {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1));
  }, [rows.length, selected]);

  useInput((input, key) => {
    if (input === 'j' || key.downArrow) {
      setSelected(s => Math.min(rows.length - 1, s + 1));
    } else if (input === 'k' || key.upArrow) {
      setSelected(s => Math.max(0, s - 1));
    } else if (key.return) {
      const row = rows[selected];
      if (row && onAttach) {
        onAttach(row);
        exit();
      }
    } else if (key.escape || input === 'q') {
      exit();
    }
  });

  const tempoLabel: Record<FleetRow['tempo'], { text: string; color: string }> = {
    running: { text: 'running', color: 'success' },
    blocked: { text: 'blocked', color: 'warning' },
    idle: { text: 'idle', color: 'secondaryText' },
    booked: { text: 'booked', color: 'secondaryText' },
  };

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>agents</Text>
        <Text dimColor> No background sessions. Start one with `cch --bg`.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        {' '}
        agents — {rows.length} session{rows.length > 1 ? 's' : ''}
      </Text>
      <Text dimColor> ↑/↓ or j/k to select · enter to attach · esc/q to quit</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) => {
          const tl = tempoLabel[row.tempo] ?? tempoLabel.idle!;
          const sel = i === selected;
          return (
            <Box key={row.shortId} paddingLeft={sel ? 0 : 1}>
              <Text color={sel ? 'suggestion' : undefined} inverse={sel}>{` ${row.shortId} `}</Text>
              <Text> {row.name.slice(0, 24)}</Text>
              <Text
                color={tl.color as keyof Record<string, never> extends never ? never : never}
                dimColor={!sel && row.tempo !== 'blocked'}
              >
                {' '}
                · {tl.text}
                {row.blockedNeeds ? ` — needs ${row.blockedNeeds}` : ''}
              </Text>
              <Text dimColor> · {row.cwd}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** 从 SessionEntry 装配 FleetRow（tempo 推断：status/waitingFor）。 */
export function toFleetRows(
  sessions: Array<{
    sessionId: string;
    kind: string;
    name?: string;
    cwd: string;
    status?: string;
    waitingFor?: string;
  }>,
): FleetRow[] {
  return sessions.map(s => {
    let tempo: FleetRow['tempo'] = 'running';
    if (s.waitingFor) tempo = 'blocked';
    else if (s.status === 'idle') tempo = 'idle';
    return {
      shortId: s.sessionId.slice(0, 8),
      name: s.name ?? s.sessionId,
      kind: s.kind,
      cwd: s.cwd,
      tempo,
      blockedNeeds: s.waitingFor,
    };
  });
}
