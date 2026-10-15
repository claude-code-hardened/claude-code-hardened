/**
 * PR attribution trailer builder — intentionally a no-op stub.
 *
 * ⚠ 官方语义待考，防止误造提交信息行为：buildPRTrailers 的输出会拼进 PR
 * 描述并经 squash-merge 进入 git 提交信息（用户可见行为）。官方 chunk
 * （docs/reverse-284/decompiled/0054-chunk-dxsxk16b/
 * module-004-uncategorized.js:923）只确认 attribution module state 里有
 * `armedTrailerFiles: new Map` 字段，但 trailer 的具体文本格式、字段顺序与
 * 拼装规则在全部反编译语料中均不可得，无法 1:1 对齐。按"宁可少做不可做错"
 * 规约保持返回 []；恢复实现前不得臆造 trailer 内容。
 *
 * Caller: getEnhancedPRAttribution() in src/utils/attribution.ts (dynamic
 * import, COMMIT_ATTRIBUTION-gated, internal-model-repos only) — the
 * `trailers.join('\n')` append degrades to the un-trailered summary when
 * this returns [].
 */
import type { AttributionData, AttributionState } from './commitAttribution.js'

export const buildPRTrailers: (
  attributionData: AttributionData,
  attribution: AttributionState,
) => string[] = () => []
