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
	/// 默认 20_000ms；searchCancel(cancel_key) 或到时中止
	pub timeout_ms: Option<u32>,
	/// 会话专属取消 key（CancelRegistry）：searchCancel(cancel_key) 只杀本
	/// 会话，并发搜索互不踩踏；缺省 = v1 全局代际语义。
	pub cancel_key: Option<String>,
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
	/// 超过 4MiB 阈值的文件数（新语义：仍全量流式搜索，仅作旗标计数）
	pub skipped_oversized: u32,
	/// 管道被取消（searchCancel / timeout）：true = 残表，TS 渲染层据此
	/// 转为与 rg 支路超时一致的错误面（不静默回残表）。
	pub cancelled: bool,
}

/// findGlob options — 对齐 `rg --files --glob --sort=modified --no-ignore --hidden`
/// ⊕ bfs 对位面（v2 新增五字段全为 Option，缺省 = 旧行为或新默认序）。
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
	/// bfs -name 语义面：basename fnmatch（与 GlobFilter 的路径 glob 面正交）。
	pub bfs_name: Option<String>,
	/// bfs -iname：bfs_name 大小写不敏感。
	pub bfs_icase: Option<bool>,
	/// bfs -mindepth（root=0 起算；depth < min 不出、照常下潜）。
	pub min_depth: Option<u32>,
	/// 符号链策略："P"（默认，从不跟随，symlink 报 l）|"L"（全跟随+环防）|
	/// "H"（仅根路径本身跟随）。非法值按 "P"。
	pub follow: Option<String>,
	/// 输出序："bfs"（默认；emit 序 = (depth,父序,名序)，sort_by_mtime 在其后
	/// 照旧）|"dfs"（v1 现路径：WalkParallel + 字典序兜底）。非法值按 "bfs"。
	pub order: Option<String>,
	/// 会话专属取消 key（CancelRegistry，同 GrepOptions.cancel_key）。
	pub cancel_key: Option<String>,
}
