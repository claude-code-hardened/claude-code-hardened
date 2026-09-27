import React, { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { t } from '../../i18n/index.js';
import { validateManifest } from '../../utils/plugins/validatePlugin.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join } from 'path';

/**
 * claude plugin eval — plugin evaluation harness (官方 GA 表面)。
 *
 * 与 validate（结构校验）互补：eval 报告插件的行为面——工具/命令/skills
 * 清单、manifest 声明与磁盘实际内容的一致性、skills 的上下文成本估算
 * （/skill-doctor 语义：usage and context-cost report）。
 */

type EvalRow = {
  name: string;
  kind: 'command' | 'skill' | 'tool';
  present: boolean;
  approxTokens: number;
};

type Props = {
  onComplete: (result: string) => void;
  path?: string;
  initMode?: boolean;
};

function countDirTokens(dir: string | undefined): number {
  if (!dir || !existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const st = statSync(p);
      if (st.isFile() && (f.endsWith('.md') || f.endsWith('.json'))) {
        // 粗估：4 chars ≈ 1 token
        total += Math.ceil(readFileSync(p, 'utf8').length / 4);
      }
    }
  } catch {
    // unreadable dir counts as 0
  }
  return total;
}

export function EvalPlugin({ onComplete, path, initMode }: Props): React.ReactNode {
  const [rows, setRows] = useState<EvalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!path) {
        setError(t('Usage: /plugin eval <plugin-path>'));
        return;
      }
      if (initMode) {
        // 官方 eval init：生成评估 harness 的清单清单（.claude-plugin/eval.json）
        try {
          const evalDir = join(path, '.claude-plugin');
          if (!existsSync(evalDir)) {
            mkdirSync(evalDir, { recursive: true, mode: 0o755 });
          }
          const initFile = join(evalDir, 'eval.json');
          if (!existsSync(initFile)) {
            writeFileSync(
              initFile,
              JSON.stringify(
                {
                  version: 1,
                  description:
                    'Plugin evaluation harness — add cases and re-run /plugin eval',
                  cases: [] as Array<{ name: string; input: string; expect: string }>,
                },
                null,
                2,
              ),
            );
          }
          setError(t('Eval init done — cases file at .claude-plugin/eval.json'));
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      try {
        const result = await validateManifest(path);
        if (!result.success) {
          setRows([]);
          setError(
            t('Manifest invalid — run /plugin validate first') +
              (result.errors.length ? `: ${result.errors.map(e => e.message).join('; ')}` : ''),
          );
          return;
        }
        // manifest 内容从磁盘读取（ValidationResult 不含 manifest 本体）
        const manifestPath = join(path, '.claude-plugin', 'plugin.json');
        const manifest = JSON.parse(
          readFileSync(existsSync(manifestPath) ? manifestPath : join(path, 'plugin.json'), 'utf8'),
        ) as {
          tools?: Array<{ name?: string; source?: string }>;
          commands?: Array<{ name?: string; source?: string }>;
          skills?: Array<{ name?: string; source?: string }>;
        };
        const rows: EvalRow[] = [];
        for (const kind of ['command', 'skill', 'tool'] as const) {
          const declared = (manifest[`${kind}s` as const] ?? []) as Array<{
            name?: string;
            source?: string;
          }>;
          for (const item of declared) {
            const name = item.name ?? item.source ?? '(unnamed)';
            const src = item.source ?? '';
            const abs = src ? join(path, src) : join(path, `${kind}s`, `${name}.md`);
            const present =
              existsSync(abs) ||
              existsSync(abs.replace(/\.md$/, '')) ||
              existsSync(join(path, `${kind}s`, name, 'SKILL.md'));
            const approxTokens = present ? countDirTokens(present && statSync(abs).isDirectory() ? abs : undefined) : 0;
            rows.push({ name, kind, present, approxTokens });
          }
        }
        setRows(rows);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [path, initMode]);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="error">{error}</Text>
        <Box marginTop={1}>
          <Text dimColor>{t('Press enter to continue')}</Text>
        </Box>
      </Box>
    );
  }

  if (!rows) {
    return (
      <Box flexDirection="column">
        <Text>{t('Evaluating plugin…')}</Text>
      </Box>
    );
  }

  const totalTokens = rows.reduce((a, r) => a + r.approxTokens, 0);
  const missing = rows.filter(r => !r.present);

  return (
    <Box flexDirection="column">
      <Text bold>
        {t('Plugin evaluation')} — {path}
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>{t('No tools/commands/skills declared in manifest')}</Text>
      ) : (
        rows.map(r => (
          <Box key={`${r.kind}:${r.name}`}>
            <Text color={r.present ? undefined : 'error'}>
              {r.present ? '✓' : '✗'} [{r.kind}] {r.name}
              {r.approxTokens > 0 ? ` (~${r.approxTokens} tok)` : ''}
              {r.present ? '' : ` — ${t('declared but missing on disk')}`}
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1} flexDirection="column">
        <Text>
          {t('Context cost')}: ~{totalTokens} tok ({t('declared surface')}: {rows.length}, {t('missing')}:{' '}
          {missing.length})
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{t('Press enter to continue')}</Text>
      </Box>
    </Box>
  );
}
