import { useEffect, useState } from 'react'
import type { PastedContent } from 'src/utils/config.js'
import { TRUNCATION_THRESHOLD, maybeTruncateInput } from './inputPaste.js'

type Props = {
  input: string
  pastedContents: Record<number, PastedContent>
  onInputChange: (input: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (contents: Record<number, PastedContent>) => void
}

export function useMaybeTruncateInput({
  input,
  pastedContents,
  onInputChange,
  setCursorOffset,
  setPastedContents,
}: Props) {
  // Track if we've initialized this specific input value
  const [hasAppliedTruncationToInput, setHasAppliedTruncationToInput] =
    useState(false)

  // 大文本兜底（非粘贴路径，>TRUNCATION_THRESHOLD 事后截断）：粘贴入口
  // 已在 >800 字符 / >2 换行处折叠为官方占位符（inputPaste.ts
  // foldPasteAtEntry），经粘贴进来的文本整段不超过入口阈值 + 占位符，
  // 不会再触发这里的 >10000 截断——兜底保留给 STT insertText、IDE
  // at-mention、历史恢复等直接 setInput 的超长文本，阈值语义让位给折叠。
  useEffect(() => {
    if (hasAppliedTruncationToInput) {
      return
    }

    if (input.length <= TRUNCATION_THRESHOLD) {
      return
    }

    const { newInput, newPastedContents } = maybeTruncateInput(
      input,
      pastedContents,
    )

    onInputChange(newInput)
    setCursorOffset(newInput.length)
    setPastedContents(newPastedContents)
    setHasAppliedTruncationToInput(true)
  }, [
    input,
    hasAppliedTruncationToInput,
    pastedContents,
    onInputChange,
    setPastedContents,
    setCursorOffset,
  ])

  // Reset hasInitializedInput when input is cleared (e.g., after submission)
  useEffect(() => {
    if (input === '') {
      setHasAppliedTruncationToInput(false)
    }
  }, [input])
}
