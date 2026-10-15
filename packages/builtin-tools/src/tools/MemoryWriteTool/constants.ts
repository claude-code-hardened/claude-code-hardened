export const MEMORY_WRITE_TOOL_NAME = 'memory_write'

export const MEMORY_LIST_TOOL_NAME = 'memory_list'

export const MEMORY_READ_TOOL_NAME = 'memory_read'

/** Single memory document size cap (matches multiStore MAX_VALUE_BYTES). */
export const MAX_MEMORY_DOC_BYTES = 1024 * 1024

/** memory_read output cap (matches LocalMemoryRecall FETCH_CAP_BYTES). */
export const MAX_MEMORY_READ_BYTES = 50 * 1024

/** Max docs returned by memory_list (OOM guard, mirrors recall M5 fix). */
export const MAX_LIST_MEMORY_DOCS = 1024
