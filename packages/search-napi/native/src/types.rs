//! napi 类型面（全量手写约定：napi #[napi(object)] → TS 结构体）。

use napi_derive::napi;

/// 输出模式（对齐 rg -l/-c/默认 + omp GrepOutputMode）。
#[napi(string_enum)]
pub enum GrepOutputMode {
	Content,
	FilesWithMatches,
	Count,
}

/// grepSearch options — 对齐 omp GrepOptions（v1 无流式回调）。
#[napi(object)]
pub struct GrepOptions {
	pub pattern: String,
	pub path: Option<String>,
	pub glob: Option<String>,
	// [M1 编译解阻] napi-derive 3.6.x 字段面仅支持 ts_type（ts_arg_type 只在
	// 函数参数面生效）；生成 d.ts 文本不变。
	#[napi(ts_type = "string | null | undefined")]
	pub r#type: Option<String>,
	pub ignore_case: Option<bool>,
	pub multiline: Option<bool>,
	/// 默认 true（对齐 GrepTool --hidden）
	pub hidden: Option<bool>,
	/// 默认 true
	pub gitignore: Option<bool>,
	pub max_count: Option<u32>,
	pub offset: Option<u32>,
	pub context_before: Option<u32>,
	pub context_after: Option<u32>,
	pub max_columns: Option<u32>,
	pub mode: Option<GrepOutputMode>,
	/// 默认 20_000ms；searchCancel() 或到时中止
	pub timeout_ms: Option<u32>,
}

/// 单条命中（TS 渲染层消费；before/after 为上下文行）。
#[napi(object)]
pub struct GrepMatch {
	pub path: String,
	pub line_number: u32,
	/// count 模式下为匹配数、其余模式为共享正文
	pub line: String,
	pub before: Vec<String>,
	pub after: Vec<String>,
	/// 该行被 max_columns 截断
	pub truncated: Option<bool>,
}

#[napi(object)]
pub struct GrepResult {
	pub matches: Vec<GrepMatch>,
	pub total_matches: u32,
	pub files_with_matches: u32,
	pub files_searched: u32,
	/// 结果被 max_count 截断
	pub limit_reached: bool,
	/// 因超限只读前缀的文件数（两遍扫描 pass2 计入）
	pub skipped_oversized: u32,
}

/// findGlob options — 对齐 `rg --files --glob --sort=modified --no-ignore --hidden`。
#[napi(object)]
pub struct GlobOptions {
	pub pattern: Option<String>,
	pub path: Option<String>,
	pub r#type: Option<String>,
	/// 默认 true（GlobTool --hidden）
	pub hidden: Option<bool>,
	/// GlobTool 现语义为 --no-ignore → 默认 false
	pub gitignore: Option<bool>,
	pub sort_by_mtime: Option<bool>,
	pub max_results: Option<u32>,
	pub offset: Option<u32>,
	pub timeout_ms: Option<u32>,
}
