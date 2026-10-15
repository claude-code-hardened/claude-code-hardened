import { formatPastedTextRef, getPastedTextRefNumLines } from 'src/history.js'
import type { PastedContent } from 'src/utils/config.js'

// Characters before we truncate. 大文本兜底阈值：仅非粘贴路径会触发
// （粘贴入口已在 PASTE_FOLD_THRESHOLD=800 / >2 换行处折叠，见文件顶部 WHY 注释）
export const TRUNCATION_THRESHOLD = 10000
const PREVIEW_LENGTH = 1000 // Characters to show at start and end

/**
 * 官方 2.1.284 粘贴折叠阈值（cmp-inputbox2 考证；changelog V2.0.102：
 * "a paste over 800 characters or over 2 line breaks"）。
 *
 * WHY 两层阈值：折叠（800 字符 / >2 换行）发生在**粘贴入口**
 * （PromptInput.onTextPaste → foldPasteAtEntry），粘贴正文只进
 * pastedContents，input 里留官方字面量占位符 `[Pasted text #N +M lines]`。
 * 下方 10000 字符的 maybeTruncateMessageForInput / maybeTruncateInput
 * 是**事后截断兜底**（见文件底部 foldPasteAtEntry 注释），服务非粘贴
 * 路径整段 setInput 的场景；粘贴文本入口已折叠，不会再触发 >10000
 * ——兜底保留，阈值语义让位给新折叠。
 */
export const PASTE_FOLD_THRESHOLD = 800
export const PASTE_FOLD_MAX_LINE_BREAKS = 2

type TruncatedMessage = {
  truncatedText: string
  placeholderContent: string
}

/**
 * Determines whether the input text should be truncated. If so, it adds a
 * truncated text placeholder and neturns
 *
 * @param text The input text
 * @param nextPasteId The reference id to use
 * @returns The new text to display and separate placeholder content if applicable.
 */
export function maybeTruncateMessageForInput(
  text: string,
  nextPasteId: number,
): TruncatedMessage {
  // If the text is short enough, return it as-is
  if (text.length <= TRUNCATION_THRESHOLD) {
    return {
      truncatedText: text,
      placeholderContent: '',
    }
  }

  // Calculate how much text to keep from start and end
  const startLength = Math.floor(PREVIEW_LENGTH / 2)
  const endLength = Math.floor(PREVIEW_LENGTH / 2)

  // Extract the portions we'll keep
  const startText = text.slice(0, startLength)
  const endText = text.slice(-endLength)

  // Calculate the number of lines that will be truncated
  const placeholderContent = text.slice(startLength, -endLength)
  const truncatedLines = getPastedTextRefNumLines(placeholderContent)

  // Create a placeholder reference similar to pasted text
  const placeholderId = nextPasteId
  const placeholderRef = formatTruncatedTextRef(placeholderId, truncatedLines)

  // Combine the parts with the placeholder
  const truncatedText = startText + placeholderRef + endText

  return {
    truncatedText,
    placeholderContent,
  }
}

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...Truncated text #${id} +${numLines} lines...]`
}

export function maybeTruncateInput(
  input: string,
  pastedContents: Record<number, PastedContent>,
): { newInput: string; newPastedContents: Record<number, PastedContent> } {
  // Get the next available ID for the truncated content
  const existingIds = Object.keys(pastedContents).map(Number)
  const nextPasteId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1

  // Apply truncation
  const { truncatedText, placeholderContent } = maybeTruncateMessageForInput(
    input,
    nextPasteId,
  )

  if (!placeholderContent) {
    return { newInput: input, newPastedContents: pastedContents }
  }

  return {
    newInput: truncatedText,
    newPastedContents: {
      ...pastedContents,
      [nextPasteId]: {
        id: nextPasteId,
        type: 'text',
        content: placeholderContent,
      },
    },
  }
}

/**
 * 官方 2.1.284 折叠判据：粘贴文本超过 PASTE_FOLD_THRESHOLD 字符，或换行
 * （\r\n|\r|\n，同 getPastedTextRefNumLines 语义）多于
 * PASTE_FOLD_MAX_LINE_BREAKS 个，即在粘贴入口折叠为占位符。
 */
export function shouldFoldPaste(text: string): boolean {
  return (
    text.length > PASTE_FOLD_THRESHOLD ||
    getPastedTextRefNumLines(text) > PASTE_FOLD_MAX_LINE_BREAKS
  )
}

export type FoldedPaste =
  | { folded: false; refText: ''; pastedContent: null }
  | { folded: true; refText: string; pastedContent: PastedContent }

/**
 * 在粘贴入口完成折叠（官方 2.1.284 语义，changelog V2.0.102）。需要折叠时
 * 返回官方字面量占位符 `[Pasted text #${id} +${lines} lines]`（0 换行为
 * `[Pasted text #${id}]`，沿用 formatPastedTextRef），完整原文装进
 * pastedContent，提交时经 expandPastedTextRefs 还原，无损。编号沿用官方
 * 递增语义，pasteId 由调用方（nextPasteIdRef++ / max(existingIds)+1）分配。
 *
 * 兼容：旧 CCH 兜底产物 `[...Truncated text #N +M lines...]` 与新官方格式
 * `[Pasted text #N +M lines]` 两种占位符，下游 parseReferences
 * （src/history.ts）与 Cursor.deleteTokenBefore（src/utils/Cursor.ts）的
 * 正则均已同时匹配两种，互认无需改动。
 */
export function foldPasteAtEntry(text: string, pasteId: number): FoldedPaste {
  if (!shouldFoldPaste(text)) {
    return { folded: false, refText: '', pastedContent: null }
  }
  return {
    folded: true,
    refText: formatPastedTextRef(pasteId, getPastedTextRefNumLines(text)),
    pastedContent: {
      id: pasteId,
      type: 'text',
      content: text,
    },
  }
}
