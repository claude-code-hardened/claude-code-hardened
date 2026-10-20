//! grep 模块 — rg 基座进程内管道（深水区完整版）。
//!
//! 移植母本 omp crates/pi-natives/src/grep.rs（对位语义按 v2 收口注释保留）：
//! - **单遍流式搜索**（v2：两遍 4MiB 前缀窗废除——前缀窗丢 4MiB 之后的
//!   命中）：每文件 `Searcher::search_file` 流式搜索全文件；4MiB 阈值
//!   仅作溢出旗标（`take(MAX+1)` 读数溢出判定，零 metadata stat，
//!   probe buffer 即 ≤4MiB 文件的搜索数据——与旧 read_file_bytes 同一
//!   读取量，超限文件丢弃探针后全文件流式）；
//! - 序贯-并行自适应（omp grep_sync_with_matcher :2288 分派）：无全局预算 →
//!   ignore::WalkParallel 融合 walk+search 全并行；带 max_count（content 模式）
//!   → ≤64 或单核序贯（:1612）/ 否则 512 窗口分批并行（:1733）；
//! - 结果按路径序聚合，全局 offset/max_count 裁剪（aggregate_parallel_results :1919）；
//! - rg 语义：-c 每文件计数行（total=Σ）、-l 去重路径序、--offset 跳过前 N 个
//!   match 再计 max_count（count 模式按文件计数跳过、-l 按文件跳过）；
//! - **matcher 降级链**（omp build_matcher :1109 四级对位）：Rust regex 构建
//!   失败（lookaround/backreference 语法面）→ PCRE2（JIT 按 CCH_PCRE2_JIT
//!   env）→ 括号修复 heuristic（unclosed/unopened group 的裸括号转义重试）
//!   → 字面量 fallback（regex::escape 整体取字面义，不废整搜）。

use std::borrow::Cow;
use std::cell::RefCell;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};

use grep_matcher::{Match, Matcher, NoCaptures, NoError};
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};

use crate::heart::SearchToken;
use crate::sanitize::{GlobFilter, build_glob_filter};
use crate::types::{BinaryMatchNotice, GrepMatch, GrepOptions, GrepOutputMode, GrepResult};

/// 超限旗标阈值（对齐 omp MAX_FILE_BYTES=4MiB；新语义仅计数，不再截窗）。
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// rg 14.1.1 原文案（printer/standard.rs:1331）：max_columns 超限上下文行。
/// （命中行的对应文案 `[Omitted long matching line]` 由 TS 渲染层按
/// truncated 位输出 — search-napi/src/index.ts OMITTED_LONG_MATCHING_LINE。）
const OMITTED_LONG_CONTEXT_LINE: &str = "[Omitted long context line]";

/// 全局 max_count 序贯分支阈值（omp ORDERED_STREAMING_STOP_MAX_COUNT）。
const SEQ_STOP_MAX_COUNT: u64 = 64;
/// 窗口批大小（omp GREP_STREAM_WINDOW）。
const GREP_WINDOW: usize = 512;
/// 候选数并行阈值（pi-walker should_parallelize 默认 256）。
const PARALLEL_FILES_THRESHOLD: usize = 256;
/// 并行 worker 上限（available_parallelism 钳制，避免小树线程风暴）。
const MAX_WORKERS: usize = 16;

/// PCRE2 JIT 开关（omp OMP_PCRE2_JIT 对位，pi-builtins grep.rs:33-46）：
/// `1` 强开、`0`/`false` 强关；缺省除 darwin 外全开（PCRE2 SLJIT 可执行
/// 内存分配器在 macOS 编译 pattern 可崩溃）。进程期读一次 env。
static PCRE2_JIT_ENABLED: LazyLock<bool> = LazyLock::new(|| {
	pcre2_jit_enabled(std::env::var("CCH_PCRE2_JIT").ok().as_deref())
});

/// CCH_PCRE2_JIT 值判定（omp pcre2_jit_enabled 原形对位）。
fn pcre2_jit_enabled(setting: Option<&str>) -> bool {
	match setting {
		Some(value) if !value.is_empty() => {
			value != "0" && !value.eq_ignore_ascii_case("false")
		},
		_ => !cfg!(target_os = "macos"),
	}
}

#[cfg(test)]
#[path = "grep_tests.rs"]
mod grep_tests;

// ---------------------------------------------------------------------------
// 参数面
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
	Content,
	Count,
	FilesWithMatches,
}

fn parse_mode(mode: Option<&GrepOutputMode>) -> Mode {
	match mode {
		Some(GrepOutputMode::Count) => Mode::Count,
		Some(GrepOutputMode::FilesWithMatches) => Mode::FilesWithMatches,
		_ => Mode::Content,
	}
}

/// 搜索参数面（对位 omp SearchParams；保存全局 offset/max_count）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct SearchParams {
	mode: Mode,
	max_count: Option<u64>,
	offset: u64,
	context_before: usize,
	context_after: usize,
	max_columns: Option<usize>,
	multiline: bool,
	/// ugrep -o：content 只出匹配段、count 按段计数；context 同传时调用方
	/// 强制置 0（互斥契约）。
	only_matching: bool,
	/// ugrep -L：match_count==0 的文件进名单（FSW 模式互斥，入口报错）。
	files_without_match: bool,
	/// ugrep -I：探针前 8KiB 见 NUL（无 BOM）→ 整文件跳过。
	binary_skip: bool,
}

/// per-file 预算变换（omp per_file_params :1151）：content → 全局 max+offset
/// 为单文件采集上限；count → 全局 max（rg `-c -mN` 每文件计数封顶 N，计数满
/// 即 Ok(false) 停读）；filesWithMatches → 1（命中即短路，rg -l 语义）。
/// offset 归零：全局裁剪只在聚合层应用。
fn per_file_params(params: SearchParams) -> SearchParams {
	let file_limit = match params.mode {
		Mode::Content => params.max_count.map(|max| max.saturating_add(params.offset)),
		Mode::Count => params.max_count,
		Mode::FilesWithMatches => Some(1),
	};
	SearchParams { max_count: file_limit, offset: 0, ..params }
}

/// 全局提前停止预算（omp streaming_stop_after :1168）：仅 content 模式且
/// offset==0 时可按已采集命中行数停止；offset>0 必须全量搜索+聚合裁剪。
fn stop_after_matches(params: SearchParams) -> Option<u64> {
	if params.mode != Mode::Content || params.offset != 0 {
		return None;
	}
	params.max_count.filter(|max| *max > 0).map(|max| max.saturating_add(params.offset))
}

// ---------------------------------------------------------------------------
// 结果面
// ---------------------------------------------------------------------------

struct CollectedMatch {
	line_number: u64,
	line: String,
	before: Vec<String>,
	after: Vec<String>,
	truncated: bool,
}

#[derive(Default)]
struct SearchOutcome {
	matches: Vec<CollectedMatch>,
	/// 该文件全部命中数（rg -c 语义；multiline -U 按 match 块计 1）。
	match_count: u64,
	/// 采集上限内的命中行数（content 模式 multiline 块按行数计；全局
	/// emitted 预算累计用）。
	collected: u64,
	limit_reached: bool,
	/// BinaryDetection::quit 命中偏移（无则 None，聚合层转 binary_notices）。
	binary_offset: Option<u64>,
}

impl SearchOutcome {
	fn zero() -> Self {
		Self::default()
	}
}

struct FileSearchResult {
	path: PathBuf,
	matches: Vec<CollectedMatch>,
	match_count: u64,
	collected: u64,
	limit_reached: bool,
	binary_offset: Option<u64>,
}

fn clamp_u32(value: u64) -> u32 {
	value.min(u32::MAX as u64) as u32
}

/// 单行/上下文行文本提取 + 行尾归一（CRLF 尾部随 trim_end 收口）。
fn sink_line_text(bytes: &[u8]) -> String {
	let end = bytes.iter().position(|&b| b == b'\n').unwrap_or(bytes.len());
	let text = std::str::from_utf8(&bytes[..end])
		.map_or_else(|_| String::from_utf8_lossy(&bytes[..end]).into_owned(), str::to_owned);
	text.trim_end().to_owned()
}

/// -o 匹配段文本提取：只收口段尾的 \n/\r（行内段无终结符原样保留；
/// multiline -U 段可跨行——内部换行照 rg -o -U 逐字进段，只有段尾终结
/// 符被剥）。与 sink_line_text 不同：不在首个 \n 处截断。
fn sink_segment_text(bytes: &[u8]) -> String {
	let mut end = bytes.len();
	if bytes.last() == Some(&b'\n') {
		end -= 1;
		if end > 0 && bytes[end - 1] == b'\r' {
			end -= 1;
		}
	}
	let text = std::str::from_utf8(&bytes[..end])
		.map_or_else(|_| String::from_utf8_lossy(&bytes[..end]).into_owned(), str::to_owned);
	text.to_owned()
}

/// rg `--encoding auto` 的 BOM 嗅探面（encoding_rs for_bom：UTF-16LE/BE/
/// UTF-8）。searcher 默认 `bom_sniffing(true)` 已对 search_slice/search_file
/// 自动转码 + 剥 BOM（grep-searcher searcher/mod.rs:179,201,825-826）；本
/// 判定为两处服务：① 绕开 -l 快路径的裸字节 is_match（不转码），② 给
/// binary_skip 的 NUL 预读提供文本面豁免（UTF-16 ASCII 每 2 字节一个
/// NUL——编码工件，不是二进制）。
fn bom_encoding(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
	encoding_rs::Encoding::for_bom(bytes).map(|(encoding, _)| encoding)
}

/// binary_skip 的 NUL 预读窗（前 8KiB 内见 NUL = 二进制；与 ug -I 的
/// skip-file 判定同粒度）。
const BINARY_SKIP_PROBE_BYTES: usize = 8 * 1024;

/// 原始字节 NUL 判定（binary_skip 通路专用：仅对无 BOM 文件调用）。
fn window_has_nul(bytes: &[u8]) -> bool {
	let window = &bytes[..bytes.len().min(BINARY_SKIP_PROBE_BYTES)];
	window.contains(&0)
}

/// multiline 块逐行拆分（rg -U 打印面：searcher 的 multiline sink 以
/// `lines::locate` 提供整行界（glue.rs:223），split \n + 尾换行丢弃 =
/// 块内每行一个输出行，行号随首行行号连续加计；旧行为只取块首行）。
fn sink_block_lines(bytes: &[u8]) -> Vec<String> {
	let trimmed =
		if bytes.last() == Some(&b'\n') { &bytes[..bytes.len() - 1] } else { bytes };
	trimmed.split(|&b| b == b'\n').map(sink_line_text).collect()
}

/// max_columns 截断（rg 语义 printer/standard.rs:1562）：判定 = 字节长
/// `line.len() > m`（ chars 口径废除），命中行整行替换为占位文案。命中行
/// 保留原文并置 truncated 位（TS 渲染层输出 `[Omitted long matching line]`，
/// 文案 byte 级等于 rg）；上下文行在此处直接替换为 rg 占位文案（返回值）。
fn truncate_line(line: String, max_columns: Option<usize>) -> (String, bool) {
	match max_columns {
		Some(max) if line.len() > max => (line, true),
		_ => (line, false),
	}
}

fn count_row(path: &str, count: u64) -> GrepMatch {
	GrepMatch {
		path: path.to_owned(),
		line_number: 0,
		line: count.to_string(),
		before: vec![],
		after: vec![],
		truncated: None,
	}
}

fn file_row(path: &str) -> GrepMatch {
	GrepMatch {
		path: path.to_owned(),
		line_number: 0,
		line: String::new(),
		before: vec![],
		after: vec![],
		truncated: None,
	}
}

fn to_row(path: String, m: CollectedMatch) -> GrepMatch {
	GrepMatch {
		path,
		line_number: clamp_u32(m.line_number),
		line: m.line,
		before: m.before,
		after: m.after,
		truncated: m.truncated.then_some(true),
	}
}

// ---------------------------------------------------------------------------
// Sink 采集器（对位 omp MatchCollector；预算 Ok(false) 剪枝 = rg -m 语义）
// ---------------------------------------------------------------------------

struct FileCollector<'m, M: Matcher> {
	/// 行内条目所属 matcher（仅 only_matching 的 -o 逐段提取消费）。
	matcher: &'m M,
	/// 本文件采集预算（per-file 变换后的 max_count）。
	max_count: Option<u64>,
	/// 单文件路径直接复用全局 offset（目录路径经 per_file_params 归零）。
	offset: u64,
	collected: u64,
	match_count: u64,
	limit_reached: bool,
	collect_content: bool,
	only_matching: bool,
	max_columns: Option<usize>,
	matches: Vec<CollectedMatch>,
	pending_before: Vec<String>,
	/// BinaryDetection::quit(b'\0') 命中的首字节偏移（官方 binary_offset 面；
	/// 同文件二次 quit 不覆盖首个——rg 的 end.binary_offset 语义）。
	binary_offset: Option<u64>,
	token: SearchToken,
}

impl<'m, M: Matcher> FileCollector<'m, M> {
	fn for_params(
		params: SearchParams,
		matcher: &'m M,
		token: &SearchToken,
	) -> Self {
		Self {
			matcher,
			max_count: params.max_count,
			offset: params.offset,
			collected: 0,
			match_count: 0,
			limit_reached: false,
			collect_content: params.mode == Mode::Content,
			only_matching: params.only_matching,
			max_columns: params.max_columns,
			matches: Vec::new(),
			pending_before: Vec::new(),
			binary_offset: None,
			token: token.clone(),
		}
	}

	fn into_result(self) -> SearchOutcome {
		SearchOutcome {
			matches: self.matches,
			match_count: self.match_count,
			collected: self.collected,
			limit_reached: self.limit_reached,
			binary_offset: self.binary_offset,
		}
	}

}

impl<M: Matcher> Sink for FileCollector<'_, M> {
	type Error = io::Error;

	fn binary_data(
		&mut self,
		_searcher: &Searcher,
		binary_byte_offset: u64,
	) -> Result<bool, Self::Error> {
		// BinaryDetection::quit(0) 对位：记录首个 quit 偏移（quit 模式下
		// searcher 随即终止本文件）；官方 uOn 的提示行即此值
		// （_ALL.js:9463）。
		if self.binary_offset.is_none() {
			self.binary_offset = Some(binary_byte_offset);
		}
		Ok(true)
	}

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
		if self.limit_reached || self.token.cancelled() {
			// 预算/取消剪枝：Ok(false) = searcher 停读（rg -m 自然语义；
			// 超预算事件不计数——rg -c -m2 对 3 命中文件计 2）（count 模式
			// 计数满即停，rg -c -mN 每文件计数封顶由此生效）。
			return Ok(false);
		}
		// ugrep -o / rg -o 对位面：逐段记账（content 逐段出行、总量保持
		// 行记面；count 按段计数——rg 实证 `-c -o a` 计匹配段数而非行数）。
		// 预算粒度 = 输出行（head_limit/offset 的工具面契约即渲染行切片），
		// 逐段消费；context 与 -o 互斥（入口已强制 context 置 0）。
		if self.only_matching {
			let first_line_number = mat.line_number().unwrap_or(0);
			let bytes = mat.bytes();
			let mut spans: Vec<(usize, usize)> = Vec::new();
			let _ = self
				.matcher
				.find_iter(bytes, |m| {
					spans.push((m.start(), m.end()));
					true
				});
			for (start, end) in spans {
				if self.collect_content {
					// content 的 total = 段数面（每段记账一次，与 count 行
					// 同基；budget 门在 collected，读者照 rg -m 停读）。
					self.match_count += 1;
				}
				if self.collected < self.offset {
					self.collected += 1;
					continue;
				}
				if self.collect_content {
					if self.max_count.is_some_and(|max| self.collected >= max) {
						self.limit_reached = true;
						return Ok(false);
					}
					let (line, truncated) =
						truncate_line(sink_segment_text(&bytes[start..end]), self.max_columns);
					let before = std::mem::take(&mut self.pending_before);
					self.matches.push(CollectedMatch {
						line_number: first_line_number,
						line,
						before,
						after: Vec::new(),
						truncated,
					});
					self.collected += 1;
				} else {
					// count：按段计数（match_count + collected 同步推进；
					// rg `-c` 的每文件计数封顶语义由 max 门收口）。
					if self.max_count.is_some_and(|max| self.match_count >= max) {
						self.limit_reached = true;
						return Ok(false);
					}
					self.match_count += 1;
					self.collected += 1;
				}
			}
			return Ok(true);
		}
		self.match_count += 1;
		// offset 窗口前的命中跳过（对位 omp skipped 计数）：预算按命中
		// 推进——（旧实现零推进会让单文件 + offset 死跳丢光全部命中）。
		if self.collected < self.offset {
			self.pending_before.clear();
			self.collected += 1;
			return Ok(true);
		}
		if self.collect_content {
			// rg -U 打印面：块内逐行输出（每行一个 match 行、行号连续）。
			// 行预算内逐行采集，预算耗尽置位（块可被截尾）。
			let first_line_number = mat.line_number().unwrap_or(0);
			for (i, text) in sink_block_lines(mat.bytes()).into_iter().enumerate() {
				if self.max_count.is_some_and(|max| self.collected >= max) {
					self.limit_reached = true;
					break;
				}
				let (line, truncated) = truncate_line(text, self.max_columns);
				let before = if i == 0 {
					std::mem::take(&mut self.pending_before)
				} else {
					Vec::new()
				};
				self.matches.push(CollectedMatch {
					line_number: first_line_number.saturating_add(i as u64),
					line,
					before,
					after: Vec::new(),
					truncated,
				});
				self.collected += 1;
			}
			if self.max_count.is_some_and(|max| self.collected >= max) {
				self.limit_reached = true;
			}
		} else {
			self.pending_before.clear();
			self.collected += 1;
			if let Some(max) = self.max_count
				&& self.collected >= max
			{
				self.limit_reached = true;
			}
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, Self::Error> {
		if !self.collect_content {
			return Ok(true);
		}
		// 上下文行 max_columns 超限 → rg 占位文案（standard.rs:1331）：
		// 文本由 TS 渲染层原样输出，byte 级等于 rg 的 context 溢出面。
		let (line, overflow) = truncate_line(sink_line_text(ctx.bytes()), self.max_columns);
		let line = if overflow { OMITTED_LONG_CONTEXT_LINE.to_owned() } else { line };
		match ctx.kind() {
			SinkContextKind::Before => self.pending_before.push(line),
			SinkContextKind::After => {
				if let Some(last) = self.matches.last_mut() {
					last.after.push(line);
				}
			},
			SinkContextKind::Other => {},
		}
		Ok(true)
	}
}

// ---------------------------------------------------------------------------
// Searcher / worker（thread_local 逐线程缓存，对位 omp :708-725）
// ---------------------------------------------------------------------------

fn build_searcher(params: SearchParams) -> Searcher {
	// context 仅在 content 模式打开；行号恒开（rows 需要）。
	let (before, after) = if params.mode == Mode::Content {
		(params.context_before, params.context_after)
	} else {
		(0, 0)
	};
	SearcherBuilder::new()
		.binary_detection(BinaryDetection::quit(b'\x00'))
		.line_number(true)
		.multi_line(params.multiline)
		.before_context(before)
		.after_context(after)
		.build()
}

struct SearchWorker {
	searcher: Searcher,
	/// 探针预读缓冲（take(MAX+1)；≤4MiB 文件该缓冲即整文件搜索数据）。
	buffer: Vec<u8>,
}

impl SearchWorker {
	fn new(params: SearchParams) -> Self {
		Self { searcher: build_searcher(params), buffer: Vec::new() }
	}
}

thread_local! {
	static PARALLEL_GREP_WORKER: RefCell<Option<(SearchParams, SearchWorker)>> = const { RefCell::new(None) };
}

fn with_parallel_worker<T>(params: SearchParams, search: impl FnOnce(&mut SearchWorker) -> T) -> T {
	PARALLEL_GREP_WORKER.with(|cell| {
		let mut cached = cell.borrow_mut();
		if !matches!(cached.as_ref(), Some((cached_params, _)) if *cached_params == params) {
			*cached = Some((params, SearchWorker::new(params)));
		}
		let (_, worker) = cached.as_mut().expect("parallel grep worker initialized");
		search(worker)
	})
}

fn worker_threads() -> usize {
	std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, MAX_WORKERS)
}

// ---------------------------------------------------------------------------
// 单文件流式/切片搜索核（take(MAX+1) 探针 = 溢出判定 + ≤4MiB 文件数据源）
// ---------------------------------------------------------------------------

fn run_search_slice<M: Matcher + Sync>(
	searcher: &mut Searcher,
	matcher: &M,
	bytes: &[u8],
	params: SearchParams,
	token: &SearchToken,
) -> io::Result<SearchOutcome> {
	let mut collector = FileCollector::for_params(params, matcher, token);
	searcher.search_slice(matcher, bytes, &mut collector)?;
	Ok(collector.into_result())
}

/// 命中采集 outcome：-l 快路径（is_match 短路，rg -l 语义），其余走
/// searcher 切片搜索（collect_content 按模式面）。
fn slice_outcome<M: Matcher + Sync>(
	searcher: &mut Searcher,
	matcher: &M,
	bytes: &[u8],
	file_params: SearchParams,
	token: &SearchToken,
) -> SearchOutcome {
	// filesWithMatches：is_match 快路径（per-file offset 恒 0；整文件在手
	// 才安全——超限文件的截断前缀不算整文件，必须走全文件流式）。BOM 文件
	// 豁免快路径：裸字节 is_match 不转码（UTF-16/UTF-8-BOM 会漏报），退回
	// searcher 的 encoding auto 通路（bom_sniffing + strip → rg 对齐）。
	if file_params.mode == Mode::FilesWithMatches
		&& file_params.offset == 0
		&& bom_encoding(bytes).is_none()
	{
		let matched = matcher.is_match(bytes).unwrap_or(false);
		return SearchOutcome {
			matches: Vec::new(),
			match_count: u64::from(matched),
			collected: u64::from(matched),
			limit_reached: false,
			// -l 快路径不跑 searcher：无 quit 探测面（与 rg -l 不打二进制
			// 提示的外显一致——TS 层只在 Content 模式渲染提示）。
			binary_offset: None,
		};
	}
	run_search_slice(searcher, matcher, bytes, file_params, token)
		.unwrap_or_else(|_| SearchOutcome::zero())
}

// ---------------------------------------------------------------------------
// 候选采集 / glob 过滤
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Candidate {
	path: PathBuf,
	// （v2：size-hint 预分区随两遍扫描废除——walk 期零 metadata stat，
	// 超限分类收口在 search_one_file 的 take(MAX+1) 读数探针。）
}

/// rg 语义：glob 对 root 相对路径匹配（strip 失败则退化整路径）。
/// 过滤器为 sanitize::GlobFilter（include ∧ ¬exclude 完整语义，含 type 面合成）。
fn glob_accepts(globs: Option<&GlobFilter>, root: &Path, path: &Path) -> bool {
	let Some(globs) = globs else { return true; };
	let relative = path.strip_prefix(root).unwrap_or(path);
	globs.is_match(relative.to_string_lossy().as_ref())
		|| globs.is_match(path.to_string_lossy().as_ref())
}

/// 候选预采集（排序保证聚合确定性；token 取消即刻截断；零 metadata stat）。
fn collect_candidates(
	root: &Path,
	globs: Option<&GlobFilter>,
	hidden: bool,
	gitignore: bool,
	token: &SearchToken,
) -> Vec<Candidate> {
	let walker = crate::walk::build_walker(root.to_path_buf(), hidden, gitignore);
	let mut candidates = Vec::new();
	for entry in walker {
		let Ok(entry) = entry else { continue };
		if token.cancelled() {
			break;
		}
		if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
			continue;
		}
		let path = entry.path();
		if !glob_accepts(globs, root, path) {
			continue;
		}
		candidates.push(Candidate { path: path.to_path_buf() });
	}
	candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	candidates
}

// ---------------------------------------------------------------------------
// 单遍扫描（omp handle_file :1442 / run_pass :1500 / process_candidates :1550
// 的流式收口）
// ---------------------------------------------------------------------------

enum FileOutcome {
	Searched {
		outcome: SearchOutcome,
		/// >4MiB 溢出旗标（仍全量搜索；计入 skipped_oversized）。
		oversized: bool,
	},
	Skipped,
}

/// 单文件搜索：take(MAX+1) 探针读（溢出判定 + ≤4MiB 文件数据），
/// 超限文件 seek 回 0 全文件流式（searcher.search_file）。
fn search_one_file<M: Matcher + Sync>(
	worker: &mut SearchWorker,
	matcher: &M,
	path: &Path,
	file_params: SearchParams,
	token: &SearchToken,
) -> FileOutcome {
	let mut file = match File::open(path) {
		Ok(file) => file,
		Err(_) => return FileOutcome::Skipped,
	};
	// 探针预读：读满 MAX+1 即 >4MiB（零 metadata stat）。
	worker.buffer.clear();
	let read = match (&file).take(MAX_FILE_BYTES + 1).read_to_end(&mut worker.buffer) {
		Ok(read) => read,
		Err(_) => return FileOutcome::Skipped,
	};
	// ugrep -I（binary_skip）对位：探针前 8KiB 见 NUL（无 BOM）→ 整文件
	// 跳过、继续下一文件（quit 语义的"命中前置行保留"差面收口）。
	// 取舍：>8KiB 处才见 NUL 的文件仍走 searcher 的 quit 检测（同默认
	// 面）；BOM 文件豁免（UTF-16 的 NUL 是编码工件，转码后交回 searcher）。
	if file_params.binary_skip
		&& bom_encoding(&worker.buffer).is_none()
		&& window_has_nul(&worker.buffer)
	{
		return FileOutcome::Skipped;
	}
	if read as u64 > MAX_FILE_BYTES {
		// 超限：探针丢弃，流式全文件（前缀窗丢命中面废除；行号原生连续；
		// buffer 复用预算为后续 ≤4MiB 文件保留容量）。流式分支的 BOM 嗅探
		// 由 searcher 自带（DecodeReaderBytes bom_sniffing，mod.rs:322-328），
		// 无需手工 seek 前缀重建 Searcher。
		worker.buffer.clear();
		if file.seek(SeekFrom::Start(0)).is_err() {
			return FileOutcome::Skipped;
		}
		let mut collector = FileCollector::for_params(file_params, matcher, token);
		if worker.searcher.search_file(matcher, &file, &mut collector).is_err() {
			return FileOutcome::Skipped;
		}
		return FileOutcome::Searched { outcome: collector.into_result(), oversized: true };
	}
	let (searcher, buffer) = (&mut worker.searcher, &worker.buffer);
	let outcome = slice_outcome(searcher, matcher, buffer, file_params, token);
	FileOutcome::Searched { outcome, oversized: false }
}

/// 共享单遍聚合状态（对位 omp PassState 的单遍化）。
struct PassState {
	results: Mutex<Vec<FileSearchResult>>,
	/// BinaryDetection::quit 命中、但未入选输出（match_count==0 且非 -L 反选）
	/// 的文件：官方 uOn 的提示数据在 end.binary_offset（_ALL.js:9463），
	/// 是否渲染由 TS 层按“该文件有产出行”（S.length>0）落定，这里只报数据。
	binary_quit: Mutex<Vec<BinaryMatchNotice>>,
	files_searched: AtomicU64,
	skipped_oversized: AtomicU64,
	emitted: AtomicU64,
}

impl PassState {
	fn new() -> Self {
		Self {
			results: Mutex::new(Vec::new()),
			binary_quit: Mutex::new(Vec::new()),
			files_searched: AtomicU64::new(0),
			skipped_oversized: AtomicU64::new(0),
			emitted: AtomicU64::new(0),
		}
	}

	fn lock_results(&self) -> std::sync::MutexGuard<'_, Vec<FileSearchResult>> {
		self.results.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	fn take_results(&self) -> Vec<FileSearchResult> {
		std::mem::take(&mut *self.lock_results())
	}
}

/// 搜索单文件并折入共享状态（对位 omp handle_file：预算/cancel 先行短路）。
#[allow(clippy::too_many_arguments)]
fn handle_file<M: Matcher + Sync>(
	candidate: &Candidate,
	worker: &mut SearchWorker,
	matcher: &M,
	file_params: SearchParams,
	emit_budget: Option<u64>,
	state: &PassState,
	token: &SearchToken,
) {
	if token.cancelled() {
		return;
	}
	if let Some(stop) = emit_budget
		&& state.emitted.load(Ordering::Relaxed) >= stop
	{
		return;
	}
	match search_one_file(worker, matcher, &candidate.path, file_params, token) {
		FileOutcome::Skipped => {},
		FileOutcome::Searched { outcome, oversized } => {
			state.files_searched.fetch_add(1, Ordering::Relaxed);
			if oversized {
				state.skipped_oversized.fetch_add(1, Ordering::Relaxed);
			}
			// ugrep -L（files_without_match）取反面：count 模式下
			// match_count==0 的文件进名单（content 模式取反无产出面不收；
			// FSW 模式互斥已在入口报错）。offset/emitted 预算面照旧。
			let inverted = file_params.files_without_match && file_params.mode != Mode::Content;
			let wanted = if inverted { outcome.match_count == 0 } else { outcome.match_count > 0 };
			if wanted {
				if emit_budget.is_some() {
					state.emitted.fetch_add(outcome.collected, Ordering::Relaxed);
				}
				state.lock_results().push(FileSearchResult {
					path: candidate.path.clone(),
					matches: outcome.matches,
					match_count: outcome.match_count,
					collected: outcome.collected,
					limit_reached: outcome.limit_reached,
					binary_offset: outcome.binary_offset,
				});
			} else if let Some(offset) = outcome.binary_offset {
				// quit 文件未入选输出（rg quit 面先于首个 match 采集）：偏移仍须
				// 上报（官方 end.binary_offset 数据面）；入选文件走 FileSearchResult
				// 携带，聚合层统一收集，两条路互斥不重复。
				state.binary_quit.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(
					BinaryMatchNotice {
						path: candidate.path.to_string_lossy().into_owned(),
						offset: u32::try_from(offset).unwrap_or(u32::MAX),
					},
				);
			}
		},
	}
}

fn sort_results(results: &mut [FileSearchResult]) {
	results.sort_unstable_by(|a, b| a.path.cmp(&b.path));
}

/// 一遍扫描：候选列表 → 并行分块（≥256 且多核）或序贯循环 → 路径序结果。
#[allow(clippy::too_many_arguments)]
fn run_pass<M: Matcher + Sync>(
	candidates: &[Candidate],
	matcher: &M,
	file_params: SearchParams,
	parallel_allowed: bool,
	emit_budget: Option<u64>,
	state: &PassState,
	token: &SearchToken,
) -> Vec<FileSearchResult> {
	if parallel_allowed && worker_threads() > 1 && candidates.len() >= PARALLEL_FILES_THRESHOLD {
		let chunk_size = candidates.len().div_ceil(worker_threads());
		std::thread::scope(|scope| {
			for chunk in candidates.chunks(chunk_size) {
				scope.spawn(move || {
					let mut worker = SearchWorker::new(file_params);
					for candidate in chunk {
						if token.cancelled() {
							break;
						}
						handle_file(
							candidate,
							&mut worker,
							matcher,
							file_params,
							emit_budget,
							state,
							token,
						);
					}
				});
			}
		});
	} else {
		let mut worker = SearchWorker::new(file_params);
		for candidate in candidates {
			if token.cancelled() {
				break;
			}
			if let Some(stop) = emit_budget
				&& state.emitted.load(Ordering::Relaxed) >= stop
			{
				break;
			}
			handle_file(candidate, &mut worker, matcher, file_params, emit_budget, state, token);
		}
	}
	let mut results = state.take_results();
	sort_results(&mut results);
	results
}

// ---------------------------------------------------------------------------
// 执行策略（omp run_streaming_grep :1830 三分支 + run_parallel_streaming :1646）
// ---------------------------------------------------------------------------

/// 执行策略（测试可强制指定以对比序贯/并行/窗口一致性）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExecStrategy {
	Sequential,
	Windowed,
	ParallelUnbounded,
}

fn choose_strategy(params: SearchParams, workers: usize) -> ExecStrategy {
	match stop_after_matches(params) {
		None => {
			if workers > 1 {
				ExecStrategy::ParallelUnbounded
			} else {
				ExecStrategy::Sequential
			}
		},
		Some(stop) if stop <= SEQ_STOP_MAX_COUNT || workers <= 1 => ExecStrategy::Sequential,
		Some(_) => ExecStrategy::Windowed,
	}
}

/// 序贯分支：候选全量预采集后单遍扫描（单 Searcher，预算即停）。
#[allow(clippy::too_many_arguments)]
fn run_sequential<M: Matcher + Sync>(
	root: &Path,
	globs: Option<&GlobFilter>,
	matcher: &M,
	params: SearchParams,
	hidden: bool,
	gitignore: bool,
	state: &PassState,
	token: &SearchToken,
) -> Vec<FileSearchResult> {
	let candidates = collect_candidates(root, globs, hidden, gitignore, token);
	let emit_budget = stop_after_matches(params);
	run_pass(
		&candidates,
		matcher,
		per_file_params(params),
		false,
		emit_budget,
		state,
		token,
	)
}

/// 窗口分支：候选全量预采集（路径序），512 一窗并行搜索，预算满足即停
/// （对位 omp run_windowed_streaming_grep :1733；超限文件在同窗内流式搜索，
/// 不再延迟到 pass2 前缀窗）。
#[allow(clippy::too_many_arguments)]
fn run_windowed<M: Matcher + Sync>(
	root: &Path,
	globs: Option<&GlobFilter>,
	matcher: &M,
	params: SearchParams,
	hidden: bool,
	gitignore: bool,
	emit_stop: u64,
	state: &PassState,
	token: &SearchToken,
) -> Vec<FileSearchResult> {
	let file_params = per_file_params(params);
	let candidates = collect_candidates(root, globs, hidden, gitignore, token);
	let mut results: Vec<FileSearchResult> = Vec::new();
	let mut window: Vec<Candidate> = Vec::with_capacity(GREP_WINDOW);
	for candidate in candidates {
		if token.cancelled() {
			break;
		}
		window.push(candidate);
		if window.len() >= GREP_WINDOW {
			flush_window(&mut window, &mut results, matcher, file_params, state, token);
			if state.emitted.load(Ordering::Relaxed) >= emit_stop {
				break;
			}
		}
	}
	if state.emitted.load(Ordering::Relaxed) < emit_stop {
		flush_window(&mut window, &mut results, matcher, file_params, state, token);
	}
	results
}

fn sort_candidates(candidates: &mut [Candidate]) {
	candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
}

/// 一窗冲刷：窗口按路径序并行整搜，采集计数累入全局 emitted。
fn flush_window<M: Matcher + Sync>(
	window: &mut Vec<Candidate>,
	results: &mut Vec<FileSearchResult>,
	matcher: &M,
	file_params: SearchParams,
	state: &PassState,
	token: &SearchToken,
) {
	if window.is_empty() {
		return;
	}
	sort_candidates(window);
	let window_results =
		run_pass(window, matcher, file_params, true, None, state, token);
	let emitted =
		window_results.iter().fold(0u64, |acc, result| acc.saturating_add(result.collected));
	state.emitted.fetch_add(emitted, Ordering::Relaxed);
	results.extend(window_results);
	window.clear();
}

type VisitEntry = Result<ignore::DirEntry, ignore::Error>;

/// 融合 walk+search 的 per-thread visitor（thread_local Searcher 复用；
/// 取消返回 Quit——与 find 通路收敛面一致，不再继续 walk）。
#[allow(clippy::too_many_arguments)]
fn fused_visitor<'s, M: Matcher + Sync>(
	root: &'s Path,
	globs: Option<&'s GlobFilter>,
	matcher: &'s M,
	file_params: SearchParams,
	state: &'s PassState,
	token: &'s SearchToken,
) -> Box<dyn FnMut(VisitEntry) -> ignore::WalkState + Send + 's> {
	Box::new(move |entry: VisitEntry| -> ignore::WalkState {
		let Ok(entry) = entry else { return ignore::WalkState::Continue };
		if entry.depth() == 0 {
			return ignore::WalkState::Continue;
		}
		if token.cancelled() {
			return ignore::WalkState::Quit;
		}
		if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
			return ignore::WalkState::Continue;
		}
		let path = entry.path();
		if !glob_accepts(globs, root, path) {
			return ignore::WalkState::Continue;
		}
		let candidate = Candidate { path: path.to_path_buf() };
		with_parallel_worker(file_params, |worker| {
			handle_file(&candidate, worker, matcher, file_params, None, state, token);
		});
		ignore::WalkState::Continue
	})
}

/// 无界分支：ignore::WalkParallel 全并行融合（omp run_parallel_streaming_grep）。
#[allow(clippy::too_many_arguments)]
fn run_unbounded_parallel<M: Matcher + Sync>(
	root: &Path,
	globs: Option<&GlobFilter>,
	matcher: &M,
	params: SearchParams,
	hidden: bool,
	gitignore: bool,
	state: &PassState,
	token: &SearchToken,
) -> Vec<FileSearchResult> {
	let file_params = per_file_params(params);
	let walker =
		crate::walk::build_walk_parallel(root.to_path_buf(), hidden, gitignore, worker_threads());
	walker.run(|| fused_visitor(root, globs, matcher, file_params, state, token));
	let mut results = state.take_results();
	sort_results(&mut results);
	results
}

// ---------------------------------------------------------------------------
// 全局聚合（omp aggregate_parallel_results :1919 逐分支对位）
// ---------------------------------------------------------------------------

fn aggregate_results(
	results: Vec<FileSearchResult>,
	quit_only_notices: Vec<BinaryMatchNotice>,
	params: SearchParams,
	files_searched: u64,
	skipped_oversized: u64,
) -> GrepResult {
	let mut rows: Vec<GrepMatch> = Vec::new();
	let mut total_matches = 0u64;
	let mut files_with_matches = 0u32;
	let mut offset_skipped = 0u64;
	let mut emitted = 0u64;
	let mut limit_reached = false;
	// ugrep -L 取反面（handle_file 同口径：content 不收 0 命中文件、FSW
	// 入口报错；此处只服务 count 模式的 0 命中名单）。
	let inverted = params.files_without_match && params.mode != Mode::Content;
	// -L 名单的 offset 计数窗基线（0 命中无计数可累计 → 名单文件序自进位，
	// 与 -l 的每文件 1 占位同基面）。
	let mut inverted_file_base = 0u64;

	// 官方 uOn 的 end.binary_offset 面（_ALL.js:9463）：quit 文件的提示行
	// 数据源。rg 的提示只在产出行存在时追加（S.length>0）——此处数据面按
	// “文件入选输出”收集，Content/顺序渲染条件由 TS 层落实。
	let mut binary_notices: Vec<BinaryMatchNotice> = Vec::new();

	for result in results {
		if !inverted && result.match_count == 0 {
			continue;
		}
		if inverted && result.match_count != 0 {
			continue;
		}
		let file_match_start = total_matches;
		let file_match_count = result.match_count;
		files_with_matches = files_with_matches.saturating_add(1);
		total_matches = total_matches.saturating_add(file_match_count);
		let path = result.path.to_string_lossy().into_owned();
		if let Some(offset) = result.binary_offset {
			// u32 饱和钳位（u64 未实现 FromNapiValue；>4GiB 偏移现实不可达）。
				binary_notices.push(BinaryMatchNotice {
					path: path.clone(),
					offset: u32::try_from(offset).unwrap_or(u32::MAX),
				});
		}
		match params.mode {
			Mode::Content => {
				for m in result.matches {
					if offset_skipped < params.offset {
						offset_skipped += 1;
						continue;
					}
					if let Some(max) = params.max_count
						&& emitted >= max
					{
						limit_reached = true;
						break;
					}
					rows.push(to_row(path.clone(), m));
					emitted += 1;
				}
				if result.limit_reached && offset_skipped >= params.offset {
					limit_reached = true;
				}
			},
			Mode::Count => {
				// -L 名单行：每文件占 1 行预算（-l/-L 文件名单粒度）。rg
				// --offset：按命中序跳计数——本文件被跳过的计数额 =
				// offset − 之前文件累计（饱和钳到本文件计数）。
				let offset_base =
					if inverted { inverted_file_base } else { file_match_start };
				let selected_count = if inverted { 1 } else { file_match_count };
				inverted_file_base = inverted_file_base.saturating_add(u64::from(inverted));
				let skipped_in_file =
					params.offset.saturating_sub(offset_base).min(selected_count);
				let available = selected_count.saturating_sub(skipped_in_file);
				if available == 0 {
					continue;
				}
				if let Some(max) = params.max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				let remaining = match params.max_count {
					Some(max) => max.saturating_sub(emitted),
					None => available,
				};
				if remaining == 0 {
					limit_reached = true;
					continue;
				}
				rows.push(count_row(&path, file_match_count));
				let selected = available.min(remaining);
				emitted = emitted.saturating_add(selected);
				if selected < available {
					limit_reached = true;
				}
			},
			Mode::FilesWithMatches => {
				// -l：offset/max 均按文件粒度（每文件 1 个 match 占位）。
				if offset_skipped < params.offset {
					offset_skipped += 1;
					continue;
				}
				if let Some(max) = params.max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				rows.push(file_row(&path));
				emitted += 1;
			},
		}
	}

	if let Some(max) = params.max_count
		&& emitted >= max
	{
		limit_reached = true;
	}
	if params.max_count == Some(0) {
		limit_reached = files_with_matches > 0;
	}

	// quit 未入选文件（rg quit 先于 hit 采集）的偏移并入提示面（入选文件已
	// 携带于 results；两路互斥）。TS 渲染层按“该文件有产出行”决定是否打印。
	binary_notices.extend(quit_only_notices);

	GrepResult {
		matches: rows,
		total_matches: clamp_u32(total_matches),
		files_with_matches,
		files_searched: clamp_u32(files_searched),
		limit_reached,
		skipped_oversized: clamp_u32(skipped_oversized),
		cancelled: false,
		binary_notices,
	}
}

// ---------------------------------------------------------------------------
// 单文件路径（omp grep_sync_with_matcher is_file 分支 :2145-2286）
// ---------------------------------------------------------------------------

fn empty_result(files_searched: u32, skipped_oversized: u32) -> GrepResult {
	GrepResult {
		matches: vec![],
		total_matches: 0,
		files_with_matches: 0,
		files_searched,
		limit_reached: false,
		skipped_oversized,
		cancelled: false,
		binary_notices: vec![],
	}
}

fn grep_single_file<M: Matcher + Sync>(
	path: &Path,
	matcher: &M,
	params: SearchParams,
	token: &SearchToken,
) -> GrepResult {
	// 单文件入口保留一次 is_file 门（fifo/目录防阻面；流式管线本身零
	// metadata stat）。
	match std::fs::metadata(path) {
		Ok(meta) if meta.is_file() => {},
		_ => return empty_result(0, 0),
	}
	let mut file = match File::open(path) {
		Ok(file) => file,
		Err(_) => return empty_result(0, 0),
	};
	// take(MAX+1) 探针读（与目录路径同一溢出判定；不再经 4MiB 前缀窗丢命中）。
	let mut buffer = Vec::new();
	let read = match (&file).take(MAX_FILE_BYTES + 1).read_to_end(&mut buffer) {
		Ok(read) => read,
		Err(_) => return empty_result(0, 0),
	};
	let oversized = read as u64 > MAX_FILE_BYTES;
	let skipped_oversized = u32::from(oversized);
	// ugrep -I（binary_skip）单文件同面：探针前 8KiB 见 NUL（无 BOM）→
	// 空返回（与目录路径 search_one_file 同粒度）。
	if params.binary_skip && bom_encoding(&buffer).is_none() && window_has_nul(&buffer) {
		return empty_result(0, 0);
	}
	// -l 快路径（无 offset/max 才安全且超限时 buffer 只是截断前缀 → 走流式）。
	// BOM 文件豁免（同 slice_outcome）：裸字节 is_match 不转码会漏报。
	if params.mode == Mode::FilesWithMatches
		&& params.offset == 0
		&& params.max_count.is_none()
		&& !oversized
		&& bom_encoding(&buffer).is_none()
	{
		if !matcher.is_match(&buffer).unwrap_or(false) {
			return empty_result(1, skipped_oversized);
		}
		let path_str = path.to_string_lossy().into_owned();
		return GrepResult {
			// -l 快路径无 quit 探测（同 slice_outcome FSW 面）。
			binary_notices: vec![],
			matches: vec![file_row(&path_str)],
			total_matches: 1,
			files_with_matches: 1,
			files_searched: 1,
			limit_reached: false,
			skipped_oversized,
			cancelled: false,
		};
	}
	let outcome = if oversized {
		// 超限：流式全文件（seek 回 0、探针丢弃；行号原生连续）。
		let mut searcher = build_searcher(params);
		if file.seek(SeekFrom::Start(0)).is_err() {
			return empty_result(1, skipped_oversized);
		}
		let mut collector = FileCollector::for_params(params, matcher, token);
		match searcher.search_file(matcher, &file, &mut collector) {
			Ok(()) => collector.into_result(),
			Err(_) => SearchOutcome::zero(),
		}
	} else {
		let mut searcher = build_searcher(params);
		run_search_slice(&mut searcher, matcher, &buffer, params, token)
			.unwrap_or_else(|_| SearchOutcome::zero())
	};
	// -L（files_without_match）单文件对位：count 模式名单反选——0 命中出
	// count 0 名单行，有命中文件不在名单（与 aggregate 同口径）；content
	// 取反无产出面照旧空表。
	if params.files_without_match && params.mode == Mode::Count {
		if outcome.match_count != 0 {
			return empty_result(1, skipped_oversized);
		}
		let path_str = path.to_string_lossy().into_owned();
		return GrepResult {
			binary_notices: vec![],
			matches: vec![count_row(&path_str, 0)],
			total_matches: 0,
			files_with_matches: 1,
			files_searched: 1,
			limit_reached: false,
			skipped_oversized,
			cancelled: false,
		};
	}
	if outcome.match_count == 0 {
		return empty_result(1, skipped_oversized);
	}
	let path_str = path.to_string_lossy().into_owned();
	let mut matches = Vec::new();
	match params.mode {
		Mode::Content => {
			for m in outcome.matches {
				matches.push(to_row(path_str.clone(), m));
			}
		},
		Mode::Count => matches.push(count_row(&path_str, outcome.match_count)),
		Mode::FilesWithMatches => matches.push(file_row(&path_str)),
	}
	let limit_reached =
		outcome.limit_reached || params.max_count.is_some_and(|max| outcome.collected >= max);
	let binary_notices = outcome
		.binary_offset
		.map(|offset| {
			vec![BinaryMatchNotice {
				path: path_str.clone(),
				offset: u32::try_from(offset).unwrap_or(u32::MAX),
			}]
		})
		.unwrap_or_default();
	GrepResult {
		matches,
		total_matches: clamp_u32(outcome.match_count),
		files_with_matches: 1,
		files_searched: 1,
		limit_reached,
		skipped_oversized,
		cancelled: false,
		binary_notices,
	}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// matcher 降级链（omp build_matcher :1094-1143 四级对位）
// ---------------------------------------------------------------------------

/// 双引擎编译产物（pi-builtins grep.rs CompiledMatcher 对位）：Rust regex
/// 没有 lookaround/backreference 语法面；PCRE2 降级引擎接住（热路径按
/// variant 单态化，Matcher impl 统一管线消费面）。
enum CompiledMatcher {
	Rust(RegexMatcher),
	Pcre(PcreMatcher),
}

/// 双引擎统一错误面（Matcher::Error 关联类型；Rust 侧 find_at 恒成功——
/// grep-regex 的 Error = NoError）。
#[derive(Debug)]
enum CompiledMatcherError {
	Rust(NoError),
	Pcre(grep_pcre2::Error),
}

impl std::fmt::Display for CompiledMatcherError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Rust(err) => err.fmt(f),
			Self::Pcre(err) => err.fmt(f),
		}
	}
}

impl Matcher for CompiledMatcher {
	type Captures = NoCaptures;
	type Error = CompiledMatcherError;

	fn find_at(
		&self,
		haystack: &[u8],
		at: usize,
	) -> Result<Option<Match>, Self::Error> {
		match self {
			Self::Rust(matcher) => {
				matcher.find_at(haystack, at).map_err(CompiledMatcherError::Rust)
			},
			Self::Pcre(matcher) => {
				matcher.find_at(haystack, at).map_err(CompiledMatcherError::Pcre)
			},
		}
	}

	fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
		Ok(NoCaptures::new())
	}
}

// ---------------------------------------------------------------------------
// Regex brace sanitization（omp grep.rs :895-1044 原形对位）
// ---------------------------------------------------------------------------

/// `bytes[start]`（必为 `{`）起的重复量词是否合法：`{N}`/`{N,}`/`{N,M}`
/// （十进制数字面）。合法返回闭 `}` 的字节位。
const fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let len = bytes.len();
	let mut i = start + 1;
	// Must start with at least one digit.
	if i >= len || !bytes[i].is_ascii_digit() {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i >= len {
		return None;
	}
	if bytes[i] == b'}' {
		return Some(i);
	}
	if bytes[i] != b',' {
		return None;
	}
	i += 1;
	if i >= len {
		return None;
	}
	// After comma: optional digits then `}`.
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i < len && bytes[i] == b'}' {
		return Some(i);
	}
	None
}

/// `\p{...}`/`\x{...}` 类转义大括号面的闭 `}` 字节位。
const fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut i = start + 1;
	while i < bytes.len() {
		if bytes[i] == b'}' {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// 转义不构成合法重复量词的 `{`/`}`（omp sanitize_braces 原形）：形如
/// `${platform}` / `a{b}` 的大括号永远不会是合法 regex 语法，改写成
/// `\{`/`\}` 语义不变，只免除难懂的报错面（模板字符串字面量传入场景）。
fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
		return Cow::Borrowed(pattern);
	}

	let len = bytes.len();
	let mut result = String::with_capacity(len + 8);
	let mut modified = false;
	let mut i = 0;

	while i < len {
		// 转义段原样透传（`\` + 后随字符）。
		if bytes[i] == b'\\' && i + 1 < len {
			result.push('\\');
			i += 1;
			// Safety: index is in bounds (checked above).
			let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			// `\p{Greek}`/`\x{41}` 等转义大括号整段跳过（只转义裸大括号）。
			if matches!(ch, 'p' | 'P' | 'x' | 'u') && i < len && bytes[i] == b'{' {
				if let Some(end) = find_braced_escape_end(bytes, i) {
					result.push_str(&pattern[i..=end]);
					i = end + 1;
				} else {
					result.push_str(&pattern[i..]);
					i = len;
				}
			}
			continue;
		}

		if bytes[i] == b'{' {
			if let Some(end) = find_valid_repetition(bytes, i) {
				result.push_str(&pattern[i..=end]);
				i = end + 1;
				continue;
			}
			result.push_str("\\{");
			i += 1;
			modified = true;
			continue;
		}

		if bytes[i] == b'}' {
			result.push_str("\\}");
			i += 1;
			modified = true;
			continue;
		}

		let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified { Cow::Owned(result) } else { Cow::Borrowed(pattern) }
}

/// 裸括号转义（omp escape_unescaped_parentheses 原形）：只在 regex 引擎
/// 已报 group 语法错误后调用——`fetchProvider(` 这类字面量片段把尾 `(` 当
/// 捕获组开头；把未转义的 `(`/`)` 补转义（已转义段与既有组语法保留），
/// 其余 regex 部分继续生效。
fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'(') && !bytes.contains(&b')') {
		return Cow::Borrowed(pattern);
	}

	let mut result = String::with_capacity(pattern.len() + 4);
	let mut modified = false;
	let mut i = 0;

	while i < bytes.len() {
		if bytes[i] == b'\\' && i + 1 < bytes.len() {
			result.push('\\');
			i += 1;
			let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			continue;
		}

		let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
		if matches!(ch, '(' | ')') {
			result.push('\\');
			modified = true;
		}
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified { Cow::Owned(result) } else { Cow::Borrowed(pattern) }
}

fn build_regex_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<RegexMatcher, grep_regex::Error> {
	RegexMatcherBuilder::new()
		.case_insensitive(ignore_case)
		.multi_line(multiline)
		.dot_matches_new_line(multiline)
		.build(pattern)
}

/// PCRE2 降级引擎构建（omp build_pcre_matcher :1094 对位）：caseless/
/// multiline 对齐 Rust 侧；utf+ucp 打开 Unicode 面；JIT 可用与否按
/// CCH_PCRE2_JIT（macOS 缺省关——见 PCRE2_JIT_ENABLED）。
fn build_pcre_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<PcreMatcher, grep_pcre2::Error> {
	PcreMatcherBuilder::new()
		.caseless(ignore_case)
		.multi_line(multiline)
		.utf(true)
		.ucp(true)
		.jit_if_available(*PCRE2_JIT_ENABLED)
		.build(pattern)
}

/// 降级链（omp build_matcher :1109-1143 逐级对位）：
/// ① Rust regex（主引擎）→ ② PCRE2（lookaround/backreference 语法面）
/// → ③ 括号修复 heuristic（unclosed/unopened group 的裸括号转义重试，
/// 两引擎各一次）→ ④ 字面量 fallback（regex::escape，双引擎拒收时保
/// 证搜索可用而非整搜报废）。
fn build_fallback_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<CompiledMatcher, String> {
	let sanitized = sanitize_braces(pattern);
	let err = match build_regex_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => return Ok(CompiledMatcher::Rust(matcher)),
		Err(err) => err,
	};

	// PCRE2 supports features the Rust regex engine deliberately omits, such
	// as lookaround and backreferences.
	if let Ok(matcher) = build_pcre_matcher(sanitized.as_ref(), ignore_case, multiline) {
		return Ok(CompiledMatcher::Pcre(matcher));
	}

	// Targeted retry: a stray `(`/`)` in an otherwise valid regex (e.g.
	// `fetchProvider(`) — escape the parentheses but keep the rest of the regex
	// working.
	let message = err.to_string();
	if message.contains("unclosed group") || message.contains("unopened group") {
		let escaped = escape_unescaped_parentheses(sanitized.as_ref());
		if escaped.as_ref() != sanitized.as_ref() {
			if let Ok(matcher) = build_regex_matcher(escaped.as_ref(), ignore_case, multiline) {
				return Ok(CompiledMatcher::Rust(matcher));
			}
			if let Ok(matcher) = build_pcre_matcher(escaped.as_ref(), ignore_case, multiline) {
				return Ok(CompiledMatcher::Pcre(matcher));
			}
		}
	}

	// Final fallback: both engines rejected the pattern, so match it literally
	// instead of failing the whole search.
	build_regex_matcher(&regex::escape(pattern), ignore_case, multiline)
		.map(CompiledMatcher::Rust)
		.map_err(|_| message)
}

/// 入口 matcher 面（invalid pattern 报错文案保持 v1 面不变）。
fn build_matcher(opts: &GrepOptions) -> Result<CompiledMatcher, String> {
	let ignore_case = opts.ignore_case.unwrap_or(false);
	let multiline = opts.multiline.unwrap_or(false);
	build_fallback_matcher(&opts.pattern, ignore_case, multiline)
		.map_err(|err| format!("invalid pattern: {err}"))
}

/// 同步核（测试钩子 forced 可强制执行策略以对比序贯/窗口/并行一致性）。
pub fn grep_search_sync(opts: GrepOptions) -> Result<GrepResult, String> {
	grep_search_impl(opts, None)
}

pub fn grep_search_impl(
	opts: GrepOptions,
	forced: Option<ExecStrategy>,
) -> Result<GrepResult, String> {
	let matcher = build_matcher(&opts)?;
	let globs = build_glob_filter(opts.glob.as_deref(), opts.r#type.as_deref())?;
	let root = PathBuf::from(opts.path.clone().unwrap_or_else(|| ".".into()));
	// ugrep 对位互斥契约：-L 与 filesWithMatches 模式同传报错（types.rs
	// "mutually exclusive" 面）；-o 与 context 同传仅 -o 生效（context
	// 强制置 0）。
	let files_without_match = opts.files_without_match.unwrap_or(false);
	if files_without_match
		&& matches!(opts.mode.as_ref(), Some(GrepOutputMode::FilesWithMatches))
	{
		return Err(
			"mutually exclusive: files_without_match and files_with_matches mode".to_owned(),
		);
	}
	let only_matching = opts.only_matching.unwrap_or(false);
	let mut params = SearchParams {
		mode: parse_mode(opts.mode.as_ref()),
		max_count: opts.max_count.map(u64::from),
		offset: u64::from(opts.offset.unwrap_or(0)),
		context_before: opts.context_before.unwrap_or(0) as usize,
		context_after: opts.context_after.unwrap_or(0) as usize,
		max_columns: opts.max_columns.map(|v| v as usize),
		multiline: opts.multiline.unwrap_or(false),
		only_matching,
		files_without_match,
		binary_skip: opts.binary_skip.unwrap_or(false),
	};
	if only_matching {
		// -o 的 context 互斥收口（调用方语义：同传时仅 -o 生效）。
		params.context_before = 0;
		params.context_after = 0;
	}
	let hidden = opts.hidden.unwrap_or(true);
	let gitignore = opts.gitignore.unwrap_or(true);
	let token = SearchToken::activate(opts.cancel_key, opts.timeout_ms);

	let mut result = if root.is_file() {
		grep_single_file(&root, &matcher, params, &token)
	} else {
		let workers = worker_threads();
		let strategy = forced.unwrap_or_else(|| choose_strategy(params, workers));
		let state = PassState::new();
		let results = match strategy {
			ExecStrategy::Sequential => {
				run_sequential(&root, globs.as_ref(), &matcher, params, hidden, gitignore, &state, &token)
			},
			ExecStrategy::Windowed => {
				let stop = stop_after_matches(params).unwrap_or(u64::MAX);
				run_windowed(&root, globs.as_ref(), &matcher, params, hidden, gitignore, stop, &state, &token)
			},
			ExecStrategy::ParallelUnbounded => {
				run_unbounded_parallel(&root, globs.as_ref(), &matcher, params, hidden, gitignore, &state, &token)
			},
		};
		let files_searched = state.files_searched.load(Ordering::Relaxed);
		let skipped_oversized = state.skipped_oversized.load(Ordering::Relaxed);
		let quit_only_notices = std::mem::take(
			&mut *state.binary_quit.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
		);
		aggregate_results(results, quit_only_notices, params, files_searched, skipped_oversized)
	};
	// 统一取消出口：管道任意取消点（searchCancel(key)/全局代际/timeout）
	// 回填 cancelled —— TS 面据此转错误面，不静默回残表。
	result.cancelled = token.cancelled();
	token.deactivate();
	Ok(result)
}