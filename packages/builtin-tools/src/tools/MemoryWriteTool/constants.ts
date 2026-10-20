export const MEMORY_WRITE_TOOL_NAME = 'memory_write'

export const MEMORY_LIST_TOOL_NAME = 'memory_list'

export const MEMORY_READ_TOOL_NAME = 'memory_read'

/**
 * Single memory document size cap — official 2.8.4 对位（reverse-284
 * _ALL.js）：`var d5e=102400` / `var RIt=d5e`，write 侧
 * `Pe(e){…let n=Buffer.byteLength(e,"utf8");if(n>at) return {outcome:
 * "refused",…}`（at=RIt=102400），read 侧 too_large 同一上限；服务端错误
 * 文案映射表亦有 "content must be at most 102400 bytes" → content_too_large。
 * （旧值 1MiB 抄的是 multiStore MAX_VALUE_BYTES，非官方 memory 工具面。）
 */
export const MAX_MEMORY_DOC_BYTES = 102_400

/** memory_read output cap (matches LocalMemoryRecall FETCH_CAP_BYTES). */
export const MAX_MEMORY_READ_BYTES = 50 * 1024

/** Max docs returned by memory_list (OOM guard, mirrors recall M5 fix). */
export const MAX_LIST_MEMORY_DOCS = 1024
