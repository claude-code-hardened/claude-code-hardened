import { resolve as resolvePath } from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Text } from '@anthropic/ink';
import { logEvent } from '../services/analytics/index.js';
import { getCwd } from '../utils/cwd.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js';
import { highlightMatch } from '../utils/highlightMatch.js';
import { relativePath } from '../utils/permissions/filesystem.js';
import { readFileInRange } from '../utils/readFileInRange.js';
import { attachSearchCancel, loadSearchNative } from '../../packages/search-napi/src/index';
import { FuzzyPicker, LoadingState } from '@anthropic/ink';

type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};

type Match = {
  file: string;
  line: number;
  text: string;
};

const VISIBLE_RESULTS = 12;
const DEBOUNCE_MS = 100;
const PREVIEW_CONTEXT_LINES = 4;
// The native pipeline has no per-file match cap (the retired rg -m was
// per-file); MAX_TOTAL_MATCHES bounds the parsed array instead.
const MAX_TOTAL_MATCHES = 500;

/**
 * Global Search dialog (ctrl+shift+f / cmd+shift+f).
 * Debounced native search across the workspace.
 */
export function GlobalSearchDialog({ onDone, onInsert }: Props): React.ReactNode {
  useRegisterOverlay('global-search');
  const { columns, rows } = useTerminalSize();
  const previewOnRight = columns >= 140;
  // Chrome (title + search + matchLabel + hints + pane border + gaps) eats
  // ~14 rows. Shrink the list on short terminals so the dialog doesn't clip.
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14));

  const [matches, setMatches] = useState<Match[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<Match | undefined>(undefined);
  const [preview, setPreview] = useState<{
    file: string;
    line: number;
    content: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Load context lines around the focused match. AbortController prevents
  // holding ↓ from piling up reads.
  useEffect(() => {
    if (!focused) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const absolute = resolvePath(getCwd(), focused.file);
    const start = Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1);
    void readFileInRange(absolute, start, PREVIEW_CONTEXT_LINES * 2 + 1, undefined, controller.signal)
      .then(r => {
        if (controller.signal.aborted) return;
        setPreview({
          file: focused.file,
          line: focused.line,
          content: r.content,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPreview({
          file: focused.file,
          line: focused.line,
          content: '(preview unavailable)',
        });
      });
    return () => controller.abort();
  }, [focused]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    abortRef.current?.abort();

    if (!q.trim()) {
      setMatches(m => (m.length ? [] : m));
      setIsSearching(false);
      setTruncated(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsSearching(true);
    setTruncated(false);
    // Client-filter existing results while the native search runs — keeps
    // something on screen instead of flashing blank. Fresh results are
    // merged in (deduped by file:line) rather than replaced, so the count
    // stays monotonic within a query. Narrowing (new query extends old):
    // filter is exact — any line that matched the old fixed-string literal
    // contains the new one iff its text includes the new query lowered.
    const queryLower = q.toLowerCase();
    setMatches(m => {
      const filtered = m.filter(match => match.text.toLowerCase().includes(queryLower));
      return filtered.length === m.length ? m : filtered;
    });

    timeoutRef.current = setTimeout(
      (query, controller, setMatches, setTruncated, setIsSearching) => {
        const runSearch = async (): Promise<void> => {
          const mod = loadSearchNative();
          if (!mod) {
            setMatches([]);
            setIsSearching(false);
            return;
          }
          const cwd = getCwd();
          let collected = 0;
          // -F fixed-string semantics: escape regex metacharacters — the
          // native engine compiles the pattern as a regex.
          const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const cancelKey = `${Date.now()}-${Math.random()}`;
          const cancel = attachSearchCancel(mod, controller.signal, cancelKey);
          try {
            const result = await mod.grepSearch({
              pattern,
              path: cwd,
              ignoreCase: true, // retired rg path: -i
              hidden: true,
              gitignore: true,
              maxColumns: 500, // retired rg path: --max-columns 500
              mode: 'Content', // retired rg path: -n --no-heading
              maxCount: MAX_TOTAL_MATCHES,
              timeoutMs: 20_000,
              cancelKey,
            });
            if (controller.signal.aborted) return;
            const parsed: Match[] = [];
            for (const match of result.matches) {
              const rel = relativePath(cwd, match.path);
              parsed.push({
                file: rel.startsWith('..') ? match.path : rel,
                line: match.lineNumber,
                text: match.truncated === true ? '[Omitted long matching line]' : match.line,
              });
              if (parsed.length >= MAX_TOTAL_MATCHES) break;
            }
            collected = parsed.length;
            if (collected > 0) {
              setMatches(prev => {
                // Merge+dedupe instead of replace: prev may hold client-
                // filtered results that are valid matches for this query.
                const seen = new Set(prev.map(matchKey));
                const fresh = parsed.filter(p => !seen.has(matchKey(p)));
                if (!fresh.length) return prev;
                const next = prev.concat(fresh);
                return next.length > MAX_TOTAL_MATCHES ? next.slice(0, MAX_TOTAL_MATCHES) : next;
              });
            }
            // cap flows through maxCount → limitReached (or our own slice)
            setTruncated(result.limitReached === true || collected >= MAX_TOTAL_MATCHES);
          } catch {
            // Engine error (bad regex after escaping is impossible, aborted
            // session, …) — treat as zero matches for this keystroke.
          } finally {
            cancel();
            if (controller.signal.aborted) return;
            // Zero matches — clear stale results so "No matches" renders
            // instead of the previous query's list.
            if (collected === 0) setMatches(m => (m.length ? [] : m));
            setIsSearching(false);
          }
        };
        void runSearch();
      },
      DEBOUNCE_MS,
      q,
      controller,
      setMatches,
      setTruncated,
      setIsSearching,
    );
  };

  const listWidth = previewOnRight ? Math.floor((columns - 10) * 0.5) : columns - 8;
  const maxPathWidth = Math.max(20, Math.floor(listWidth * 0.4));
  const maxTextWidth = Math.max(20, listWidth - maxPathWidth - 4);
  const previewWidth = previewOnRight ? Math.max(40, columns - listWidth - 14) : columns - 6;

  const handleOpen = (m: Match) => {
    const opened = openFileInExternalEditor(resolvePath(getCwd(), m.file), m.line);
    logEvent('tengu_global_search_select', {
      result_count: matches.length,
      opened_editor: opened,
    });
    onDone();
  };

  const handleInsert = (m: Match, mention: boolean) => {
    onInsert(mention ? `@${m.file}#L${m.line} ` : `${m.file}:${m.line} `);
    logEvent('tengu_global_search_insert', {
      result_count: matches.length,
      mention,
    });
    onDone();
  };

  // Always pass a non-empty string so the line is reserved — prevents the
  // searchBox from bouncing when the count appears/disappears.
  const matchLabel =
    matches.length > 0 ? `${matches.length}${truncated ? '+' : ''} matches${isSearching ? '…' : ''}` : ' ';

  return (
    <FuzzyPicker
      title="Global Search"
      placeholder="Type to search…"
      items={matches}
      getKey={matchKey}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={m => setFocused(m)}
      onSelect={handleOpen}
      onTab={{ action: 'mention', handler: m => handleInsert(m, true) }}
      onShiftTab={{
        action: 'insert path',
        handler: m => handleInsert(m, false),
      }}
      onCancel={onDone}
      emptyMessage={q => (isSearching ? 'Searching…' : q ? 'No matches' : 'Type to search…')}
      matchLabel={matchLabel}
      selectAction="open in editor"
      renderItem={(m, isFocused) => (
        <Text color={isFocused ? 'suggestion' : undefined}>
          <Text dimColor>
            {truncatePathMiddle(m.file, maxPathWidth)}:{m.line}
          </Text>{' '}
          {highlightMatch(truncateToWidth(m.text.trimStart(), maxTextWidth), query)}
        </Text>
      )}
      renderPreview={m =>
        preview?.file === m.file && preview.line === m.line ? (
          <>
            <Text dimColor>
              {truncatePathMiddle(m.file, previewWidth)}:{m.line}
            </Text>
            {preview.content.split('\n').map((line, i) => (
              <Text key={i}>{highlightMatch(truncateToWidth(line, previewWidth), query)}</Text>
            ))}
          </>
        ) : (
          <LoadingState message="Loading…" dimColor />
        )
      }
    />
  );
}

function matchKey(m: Match): string {
  return `${m.file}:${m.line}`;
}
