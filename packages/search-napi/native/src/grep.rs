//! grep 模块 — rg 基座进程内管道（深水区完整版）。
//!
//! 移植母本 omp crates/pi-natives/src/grep.rs（对位语义注释保留）：
//! - 两遍 4MiB 窗口：pass1 按候选整读，超限文件 pass2 只读前缀窗口
//!   （read_file_bytes/read_file_prefix + process_candidates 的 size-hint 预分区）；
//! - 序贯-并行自适应（omp grep_sync_with_matcher :2288 分派）：无全局预算 →
//!   ignore::WalkParallel 融合 walk+search 全并行；带 max_count（content 模式）
//!   → ≤64 或单核序贯（:1612）/ 否则 512 窗口分批并行（:1733）；
//! - 结果按路径序聚合，全局 offset/max_count 裁剪（aggregate_parallel_results :1919）；
//! - rg 语义：-c 每文件计数行（total=Σ）、-l 去重路径序、--offset 跳过前 N 个
//!   match 再计 max_count（count 模式按文件计数跳过、-l 按文件跳过）。

use std::cell::RefCell;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};

use crate::heart::SearchToken;
use crate::sanitize::{GlobFilter, build_glob_filter};
use crate::types::{GrepMatch, GrepOptions, GrepOutputMode, GrepResult};

/// 超限文件只读前缀大小（对齐 omp MAX_FILE_BYTES=4MiB）。
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 全局 max_count 序贯分支阈值（omp ORDERED_STREAMING_STOP_MAX_COUNT）。
const SEQ_STOP_MAX_COUNT: u64 = 64;
/// 窗口批大小（omp GREP_STREAM_WINDOW）。
const GREP_WINDOW: usize = 512;
/// 候选数并行阈值（pi-walker should_parallelize 默认 256）。
const PARALLEL_FILES_THRESHOLD: usize = 256;
/// 并行 worker 上限（available_parallelism 钳制，避免小树线程风暴）。
const MAX_WORKERS: usize = 16;

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
}

/// per-file 预算变换（omp per_file_params :1151）：content → 全局 max+offset
/// 为单文件采集上限；count → 不限（计满整个文件）；filesWithMatches → 1
/// （命中即短路，rg -l 语义）。offset 归零：全局裁剪只在聚合层应用。
fn per_file_params(params: SearchParams) -> SearchParams {
	let file_limit = match params.mode {
		Mode::Content => params.max_count.map(|max| max.saturating_add(params.offset)),
		Mode::Count => None,
		Mode::FilesWithMatches => Some(1),
	};
	SearchParams { max_count: file_limit, offset: 0, ..params }
}

/// 全局提前停止预算（omp streaming_stop_after :1168）：仅 content 模式且
/// offset==0 时可按已采集命中数停止；offset>0 必须全量搜索+聚合裁剪。
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
	/// 该文件全部命中数（rg -c 语义；含预算触发后的溢出 1 次，对位 omp）。
	match_count: u64,
	/// 采集上限内的命中数（全局 emitted 预算累计用）。
	collected: u64,
	limit_reached: bool,
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
}

fn clamp_u32(value: u64) -> u32 {
	value.min(u32::MAX as u64) as u32
}

/// 匹配块首行提取 + 行尾归一（-U 多行 match 的 line 截断语义：取首行，
/// 行号取首行——searcher 报告的即匹配起始行号）。
fn sink_line_text(bytes: &[u8]) -> String {
	let end = bytes.iter().position(|&b| b == b'\n').unwrap_or(bytes.len());
	let text = std::str::from_utf8(&bytes[..end])
		.map_or_else(|_| String::from_utf8_lossy(&bytes[..end]).into_owned(), str::to_owned);
	text.trim_end().to_owned()
}

/// max_columns 截断（字符边界安全；omp truncate_line 的 chars 语义面）。
fn truncate_line(line: String, max_columns: Option<usize>) -> (String, bool) {
	match max_columns {
		Some(max) if line.chars().count() > max => {
			let head: String = line.chars().take(max.saturating_sub(3)).collect();
			(format!("{head}..."), true)
		},
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
// Sink 采集器（对位 omp MatchCollector）
// ---------------------------------------------------------------------------

struct FileCollector {
	/// 本文件采集预算（per-file 变换后的 max_count）。
	max_count: Option<u64>,
	/// 单文件路径直接复用全局 offset（目录路径经 per_file_params 归零）。
	offset: u64,
	collected: u64,
	match_count: u64,
	limit_reached: bool,
	collect_content: bool,
	max_columns: Option<usize>,
	matches: Vec<CollectedMatch>,
	pending_before: Vec<String>,
	token: SearchToken,
}

impl FileCollector {
	fn for_params(params: SearchParams, token: SearchToken) -> Self {
		Self {
			max_count: params.max_count,
			offset: params.offset,
			collected: 0,
			match_count: 0,
			limit_reached: false,
			collect_content: params.mode == Mode::Content,
			max_columns: params.max_columns,
			matches: Vec::new(),
			pending_before: Vec::new(),
			token,
		}
	}

	fn into_result(self) -> SearchOutcome {
		SearchOutcome {
			matches: self.matches,
			match_count: self.match_count,
			collected: self.collected,
			limit_reached: self.limit_reached,
		}
	}
}

impl Sink for FileCollector {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
		self.match_count += 1;
		if self.limit_reached || self.token.cancelled() {
			return Ok(false);
		}
		// offset 窗口前的命中跳过且不占预算（对位 omp skipped 计数）。
		if self.collected < self.offset {
			self.pending_before.clear();
			return Ok(true);
		}
		if self.collect_content {
			let (line, truncated) = truncate_line(sink_line_text(mat.bytes()), self.max_columns);
			self.matches.push(CollectedMatch {
				line_number: mat.line_number().unwrap_or(0),
				line,
				before: std::mem::take(&mut self.pending_before),
				after: Vec::new(),
				truncated,
			});
		} else {
			self.pending_before.clear();
		}
		self.collected += 1;
		if let Some(max) = self.max_count {
			if self.collected >= max {
				self.limit_reached = true;
			}
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, Self::Error> {
		if !self.collect_content {
			return Ok(true);
		}
		let (line, _) = truncate_line(sink_line_text(ctx.bytes()), self.max_columns);
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
// 两遍 4MiB 窗口读取（omp read_file_bytes :767 / read_file_prefix :1366）
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum ReadPolicy {
	/// pass1：整读；超限文件延迟到 pass2。
	Full,
	/// pass2：只读前 4MiB 前缀窗口。
	Prefix,
}

enum ReadFile {
	Read,
	Oversized,
	Skipped,
}

/// pass1 整读（读前 stat 重核：超限 → Oversized，走 pass2 前缀窗）。
fn read_file_bytes(path: &Path, buffer: &mut Vec<u8>) -> io::Result<ReadFile> {
	let meta = std::fs::metadata(path)?;
	if !meta.is_file() {
		return Ok(ReadFile::Skipped);
	}
	let len = meta.len();
	if len > MAX_FILE_BYTES {
		return Ok(ReadFile::Oversized);
	}
	let file = File::open(path)?;
	buffer.clear();
	buffer.reserve(len as usize + 1);
	file.take(MAX_FILE_BYTES).read_to_end(buffer)?;
	Ok(ReadFile::Read)
}

/// pass2：只读前 4MiB 前缀（超限文件窗口语义；NUL 二进制仍由 searcher quit）。
fn read_file_prefix(path: &Path, buffer: &mut Vec<u8>) -> io::Result<ReadFile> {
	let meta = std::fs::metadata(path)?;
	if !meta.is_file() {
		return Ok(ReadFile::Skipped);
	}
	let len = meta.len();
	if len == 0 {
		buffer.clear();
		return Ok(ReadFile::Read);
	}
	let file = File::open(path)?;
	let window = len.min(MAX_FILE_BYTES);
	buffer.clear();
	buffer.reserve(window as usize + 1);
	file.take(window).read_to_end(buffer)?;
	Ok(ReadFile::Read)
}

// ---------------------------------------------------------------------------
// 候选采集 / glob 过滤
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Candidate {
	path: PathBuf,
	/// walk 期 stat 的大小提示（None = 未知），供超限预分区。
	size: Option<u64>,
}

/// rg 语义：glob 对 root 相对路径匹配（strip 失败则退化整路径）。
/// 过滤器为 sanitize::GlobFilter（include ∧ ¬exclude 完整语义，含 type 面合成）。
fn glob_accepts(globs: Option<&GlobFilter>, root: &Path, path: &Path) -> bool {
	let Some(globs) = globs else { return true; };
	let relative = path.strip_prefix(root).unwrap_or(path);
	globs.is_match(relative.to_string_lossy().as_ref())
		|| globs.is_match(path.to_string_lossy().as_ref())
}

/// 候选预采集（排序保证聚合确定性；token 取消即刻截断）。
fn collect_candidates(
	root: &Path,
	globs: Option<&GlobFilter>,
	hidden: bool,
	gitignore: bool,
	token: SearchToken,
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
		let size = entry.metadata().ok().map(|meta| meta.len());
		candidates.push(Candidate { path: path.to_path_buf(), size });
	}
	candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	candidates
}

// ---------------------------------------------------------------------------
// 两遍扫描（omp search_one_file :1393 / handle_file :1442 / run_pass :1500
// / process_candidates :1550）
// ---------------------------------------------------------------------------

enum FileOutcome {
	Searched(SearchOutcome),
	Defer,
	SkippedOversized,
	Skipped,
}

fn search_one_file(
	worker: &mut SearchWorker,
	matcher: &RegexMatcher,
	path: &Path,
	file_params: SearchParams,
	policy: ReadPolicy,
	token: SearchToken,
) -> FileOutcome {
	let read = match policy {
		ReadPolicy::Full => read_file_bytes(path, &mut worker.buffer),
		ReadPolicy::Prefix => read_file_prefix(path, &mut worker.buffer),
	};
	match read {
		Ok(ReadFile::Read) => {},
		Ok(ReadFile::Oversized) => return FileOutcome::Defer,
		Ok(ReadFile::Skipped) => {
			return match policy {
				ReadPolicy::Prefix => FileOutcome::SkippedOversized,
				ReadPolicy::Full => FileOutcome::Skipped,
			};
		},
		Err(_) => return FileOutcome::Skipped,
	}
	// filesWithMatches：is_match 快路径（rg -l 短路；per-file offset 恒 0，
	// 单文件路径不走本函数）。
	let outcome = if file_params.mode == Mode::FilesWithMatches && file_params.offset == 0 {
		let matched = matcher.is_match(&worker.buffer).unwrap_or(false);
		SearchOutcome {
			matches: Vec::new(),
			match_count: u64::from(matched),
			collected: u64::from(matched),
			limit_reached: false,
		}
	} else {
		run_search_slice(&mut worker.searcher, matcher, &worker.buffer, file_params, token)
			.unwrap_or_else(|_| SearchOutcome::zero())
	};
	FileOutcome::Searched(outcome)
}

/// 共享两遍聚合状态：results 为已搜索文件，deferred 为超限延迟名单，
/// 计数器跨两遍累加（对位 omp PassState）。
struct PassState {
	results: Mutex<Vec<FileSearchResult>>,
	deferred: Mutex<Vec<Candidate>>,
	files_searched: AtomicU64,
	skipped_oversized: AtomicU64,
	emitted: AtomicU64,
}

impl PassState {
	fn new() -> Self {
		Self {
			results: Mutex::new(Vec::new()),
			deferred: Mutex::new(Vec::new()),
			files_searched: AtomicU64::new(0),
			skipped_oversized: AtomicU64::new(0),
			emitted: AtomicU64::new(0),
		}
	}

	fn lock_results(&self) -> std::sync::MutexGuard<'_, Vec<FileSearchResult>> {
		self.results.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	fn lock_deferred(&self) -> std::sync::MutexGuard<'_, Vec<Candidate>> {
		self.deferred.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	fn take_results(&self) -> Vec<FileSearchResult> {
		std::mem::take(&mut *self.lock_results())
	}

	fn take_deferred(&self) -> Vec<Candidate> {
		std::mem::take(&mut *self.lock_deferred())
	}
}

/// 搜索单文件并折入共享状态（对位 omp handle_file：预算/cancel 先行短路）。
#[allow(clippy::too_many_arguments)]
fn handle_file(
	candidate: &Candidate,
	worker: &mut SearchWorker,
	matcher: &RegexMatcher,
	file_params: SearchParams,
	policy: ReadPolicy,
	emit_budget: Option<u64>,
	state: &PassState,
	token: SearchToken,
) {
	if token.cancelled() {
		return;
	}
	if let Some(stop) = emit_budget {
		if state.emitted.load(Ordering::Relaxed) >= stop {
			return;
		}
	}
	match search_one_file(worker, matcher, &candidate.path, file_params, policy, token) {
		FileOutcome::Defer => state.lock_deferred().push(candidate.clone()),
		FileOutcome::SkippedOversized => {
			state.skipped_oversized.fetch_add(1, Ordering::Relaxed);
		},
		FileOutcome::Skipped => {},
		FileOutcome::Searched(outcome) => {
			state.files_searched.fetch_add(1, Ordering::Relaxed);
			if outcome.match_count > 0 {
				if emit_budget.is_some() {
					state.emitted.fetch_add(outcome.collected, Ordering::Relaxed);
				}
				state.lock_results().push(FileSearchResult {
					path: candidate.path.clone(),
					matches: outcome.matches,
					match_count: outcome.match_count,
					collected: outcome.collected,
					limit_reached: outcome.limit_reached,
				});
			}
		},
	}
}

fn sort_results(results: &mut [FileSearchResult]) {
	results.sort_unstable_by(|a, b| a.path.cmp(&b.path));
}

/// 一遍扫描：候选列表 → 并行分块或序贯循环 → 路径序结果。
#[allow(clippy::too_many_arguments)]
fn run_pass(
	candidates: &[Candidate],
	matcher: &RegexMatcher,
	file_params: SearchParams,
	policy: ReadPolicy,
	parallel_allowed: bool,
	emit_budget: Option<u64>,
	state: &PassState,
	token: SearchToken,
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
							policy,
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
			if let Some(stop) = emit_budget {
				if state.emitted.load(Ordering::Relaxed) >= stop {
					break;
				}
			}
			handle_file(candidate, &mut worker, matcher, file_params, policy, emit_budget, state, token);
		}
	}
	let mut results = state.take_results();
	sort_results(&mut results);
	results
}

/// 两遍扫描主体：size-hint 预分区超限文件，pass1 整读，pass2 只在预算未满足时
/// 读前缀窗（超限结果组缀尾：normal 组先于 oversized 组，组内路径序）。
fn process_candidates(
	candidates: Vec<Candidate>,
	matcher: &RegexMatcher,
	params: SearchParams,
	parallel_allowed: bool,
	emit_budget: Option<u64>,
	state: &PassState,
	token: SearchToken,
) -> Vec<FileSearchResult> {
	let file_params = per_file_params(params);
	let (normal, oversized_hinted): (Vec<Candidate>, Vec<Candidate>) = candidates
		.into_iter()
		.partition(|candidate| match candidate.size {
			Some(size) => size <= MAX_FILE_BYTES,
			None => true,
		});
	if !oversized_hinted.is_empty() {
		state.lock_deferred().extend(oversized_hinted);
	}
	let mut results =
		run_pass(&normal, matcher, file_params, ReadPolicy::Full, parallel_allowed, emit_budget, state, token);
	let deferred = state.take_deferred();
	let limit_satisfied =
		emit_budget.is_some_and(|stop| state.emitted.load(Ordering::Relaxed) >= stop);
	if !deferred.is_empty() && !limit_satisfied {
		let oversized =
			run_pass(&deferred, matcher, file_params, ReadPolicy::Prefix, parallel_allowed, emit_budget, state, token);
		results.extend(oversized);
	}
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

/// 序贯分支：候选全量预采集后两遍扫描（单 Searcher，预算即停）。
#[allow(clippy::too_many_arguments)]
fn run_sequential(
	root: &Path,
	globs: Option<&GlobFilter>,
	matcher: &RegexMatcher,
	params: SearchParams,
	hidden: bool,
	gitignore: bool,
	state: &PassState,
	token: SearchToken,
) -> Vec<FileSearchResult> {
	let candidates = collect_candidates(root, globs, hidden, gitignore, token);
	let emit_budget = stop_after_matches(params);
	process_candidates(candidates, matcher, params, false, emit_budget, state, token)
}

/// 窗口分支：候选全量预采集（路径序），512 一窗并行搜索，预算满足即停；
/// 超限文件最后序贯走前缀窗（对位 omp run_windowed_streaming_grep :1733）。
#[allow(clippy::too_many_arguments)]
fn run_windowed(
	root: &Path,
	globs: Option<&GlobFilter>,
	matcher: &RegexMatcher,
	params: SearchParams,
	hidden: bool,
	gitignore: bool,
	emit_stop: u64,
	state: &PassState,
	token: SearchToken,
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
	let mut deferred = state.take_deferred();
	if !deferred.is_empty() && state.emitted.load(Ordering::Relaxed) < emit_stop {
		sort_candidates(&mut deferred);
		let oversized = run_pass(
			&deferred,
			matcher,
			file_params,
			ReadPolicy::Prefix,
			false,
			Some(emit_stop),
			state,
			token,
		);
		results.extend(oversized);
	}
	results
}

fn sort_candidates(candidates: &mut [Candidate]) {
	candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
}

/// 一窗冲刷：窗口按路径序并行整读搜索，采集计数累入全局 emitted。
fn flush_window(
	window: &mut Vec<Candidate>,
	results: &mut Vec<FileSearchResult>,
	matcher: &RegexMatcher,
	file_params: SearchParams,
	state: &PassState,
	token: SearchToken,
) {
	if window.is_empty() {
		return;
	}
	sort_candidates(window);
	let window_results =
		run_pass(window, matcher, file_params, ReadPolicy::Full, true, None, state, token);
	let emitted =
		window_results.iter().fold(0u64, |acc, result| acc.saturating_add(result.collected));
	state.emitted.fetch_add(emitted, Ordering::Relaxed);
	results.extend(window_results);
	window.clear();
}

type VisitEntry = Result<ignore::DirEntry, ignore::Error>;

/// 融合 walk+search 的 per-thread visitor（thread_local Searcher 复用，
/// 超限文件 defer 出去留给 pass2 前缀窗）。
#[allow(clippy::too_many_arguments)]
fn fused_visitor<'s>(
	root: &'s Path,
	globs: Option<&'s GlobFilter>,
	matcher: &'s RegexMatcher,
	file_params: SearchParams,
	state: &'s PassState,
	token: SearchToken,
) -> Box<dyn FnMut(VisitEntry) -> ignore::WalkState + Send + 's> {
	Box::new(move |entry: VisitEntry| -> ignore::WalkState {
		let Ok(entry) = entry else { return ignore::WalkState::Continue };
		if entry.depth() == 0 || token.cancelled() {
			return ignore::WalkState::Continue;
		}
		if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
			return ignore::WalkState::Continue;
		}
		let path = entry.path();
		if !glob_accepts(globs, root, path) {
			return ignore::WalkState::Continue;
		}
		let candidate = Candidate { path: path.to_path_buf(), size: entry.metadata().ok().map(|meta| meta.len()) };
		with_parallel_worker(file_params, |worker| {
			handle_file(&candidate, worker, matcher, file_params, ReadPolicy::Full, None, state, token);
		});
		ignore::WalkState::Continue
	})
}

/// 无界分支：ignore::WalkParallel 全并行融合（omp run_parallel_streaming_grep），
/// 结束后超限 defer 名单按路径序走 pass2 前缀窗。
#[allow(clippy::too_many_arguments)]
fn run_unbounded_parallel(
	root: &Path,
	globs: Option<&GlobFilter>,
	matcher: &RegexMatcher,
	params: SearchParams,
	hidden: bool,
	gitignore: bool,
	state: &PassState,
	token: SearchToken,
) -> Vec<FileSearchResult> {
	let file_params = per_file_params(params);
	let walker =
		crate::walk::build_walk_parallel(root.to_path_buf(), hidden, gitignore, worker_threads());
	walker.run(|| fused_visitor(root, globs, matcher, file_params, state, token));
	let mut results = state.take_results();
	sort_results(&mut results);
	let mut deferred = state.take_deferred();
	if !deferred.is_empty() {
		sort_candidates(&mut deferred);
		let oversized =
			run_pass(&deferred, matcher, file_params, ReadPolicy::Prefix, true, None, state, token);
		results.extend(oversized);
	}
	results
}

// ---------------------------------------------------------------------------
// 全局聚合（omp aggregate_parallel_results :1919 逐分支对位）
// ---------------------------------------------------------------------------

fn aggregate_results(
	results: Vec<FileSearchResult>,
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

	for result in results {
		if result.match_count == 0 {
			continue;
		}
		let file_match_start = total_matches;
		let file_match_count = result.match_count;
		files_with_matches = files_with_matches.saturating_add(1);
		total_matches = total_matches.saturating_add(file_match_count);
		let path = result.path.to_string_lossy().into_owned();
		match params.mode {
			Mode::Content => {
				for m in result.matches {
					if offset_skipped < params.offset {
						offset_skipped += 1;
						continue;
					}
					if let Some(max) = params.max_count {
						if emitted >= max {
							limit_reached = true;
							break;
						}
					}
					rows.push(to_row(path.clone(), m));
					emitted += 1;
				}
				if result.limit_reached && offset_skipped >= params.offset {
					limit_reached = true;
				}
			},
			Mode::Count => {
				// rg --offset：按命中序跳计数——本文件被跳过的计数额 =
				// offset − 之前文件累计（饱和钳到本文件计数）。
				let skipped_in_file =
					params.offset.saturating_sub(file_match_start).min(file_match_count);
				let available = file_match_count.saturating_sub(skipped_in_file);
				if available == 0 {
					continue;
				}
				if let Some(max) = params.max_count {
					if emitted >= max {
						limit_reached = true;
						continue;
					}
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
				if let Some(max) = params.max_count {
					if emitted >= max {
						limit_reached = true;
						continue;
					}
				}
				rows.push(file_row(&path));
				emitted += 1;
			},
		}
	}

	if let Some(max) = params.max_count {
		if emitted >= max {
			limit_reached = true;
		}
	}
	if params.max_count == Some(0) {
		limit_reached = files_with_matches > 0;
	}

	GrepResult {
		matches: rows,
		total_matches: clamp_u32(total_matches),
		files_with_matches,
		files_searched: clamp_u32(files_searched),
		limit_reached,
		skipped_oversized: clamp_u32(skipped_oversized),
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
	}
}

fn grep_single_file(path: &Path, matcher: &RegexMatcher, params: SearchParams, token: SearchToken) -> GrepResult {
	let meta = match std::fs::metadata(path) {
		Ok(meta) => meta,
		Err(_) => return empty_result(0, 0),
	};
	if !meta.is_file() {
		return empty_result(0, 0);
	}
	let mut buffer = Vec::new();
	match read_file_bytes(path, &mut buffer) {
		Ok(ReadFile::Read) => {
			let bytes = std::mem::take(&mut buffer);
			grep_single_file_bytes(&bytes, path, matcher, params, token, 0)
		},
		Ok(ReadFile::Oversized) => match read_file_prefix(path, &mut buffer) {
			Ok(ReadFile::Read) => {
				let bytes = std::mem::take(&mut buffer);
				grep_single_file_bytes(&bytes, path, matcher, params, token, 1)
			},
			_ => empty_result(0, 1),
		},
		_ => empty_result(0, 0),
	}
}

fn grep_single_file_bytes(
	bytes: &[u8],
	path: &Path,
	matcher: &RegexMatcher,
	params: SearchParams,
	token: SearchToken,
	skipped_oversized: u32,
) -> GrepResult {
	// -l 快路径（无 offset/max 才安全；有则走 searcher 保留语义）。
	if params.mode == Mode::FilesWithMatches && params.max_count.is_none() && params.offset == 0 {
		if !matcher.is_match(bytes).unwrap_or(false) {
			return empty_result(1, skipped_oversized);
		}
		let path_str = path.to_string_lossy().into_owned();
		return GrepResult {
			matches: vec![file_row(&path_str)],
			total_matches: 1,
			files_with_matches: 1,
			files_searched: 1,
			limit_reached: false,
			skipped_oversized,
		};
	}
	let mut searcher = build_searcher(params);
	let outcome = run_search_slice(&mut searcher, matcher, bytes, params, token)
		.unwrap_or_else(|_| SearchOutcome::zero());
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
	GrepResult {
		matches,
		total_matches: clamp_u32(outcome.match_count),
		files_with_matches: 1,
		files_searched: 1,
		limit_reached,
		skipped_oversized,
	}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

fn run_search_slice(
	searcher: &mut Searcher,
	matcher: &RegexMatcher,
	bytes: &[u8],
	params: SearchParams,
	token: SearchToken,
) -> io::Result<SearchOutcome> {
	let mut collector = FileCollector::for_params(params, token);
	searcher.search_slice(matcher, bytes, &mut collector)?;
	Ok(collector.into_result())
}

fn build_matcher(opts: &GrepOptions) -> Result<RegexMatcher, String> {
	let multiline = opts.multiline.unwrap_or(false);
	RegexMatcherBuilder::new()
		.case_insensitive(opts.ignore_case.unwrap_or(false))
		.multi_line(multiline)
		.dot_matches_new_line(multiline)
		.build(&opts.pattern)
		.map_err(|err| format!("invalid pattern: {err}"))
}

/// 同步核（v1 聚合版；`#[napi(async_task)]` 转接由 lib.rs 迭代再加）。
pub fn grep_search_sync(opts: GrepOptions) -> Result<GrepResult, String> {
	grep_search_impl(opts, None)
}

/// 测试钩子：forced 可强制执行策略以对比序贯/窗口/并行一致性。
pub fn grep_search_impl(
	opts: GrepOptions,
	forced: Option<ExecStrategy>,
) -> Result<GrepResult, String> {
	let matcher = build_matcher(&opts)?;
	let globs = build_glob_filter(opts.glob.as_deref(), opts.r#type.as_deref())?;
	let root = PathBuf::from(opts.path.clone().unwrap_or_else(|| ".".into()));
	let params = SearchParams {
		mode: parse_mode(opts.mode.as_ref()),
		max_count: opts.max_count.map(u64::from),
		offset: u64::from(opts.offset.unwrap_or(0)),
		context_before: opts.context_before.unwrap_or(0) as usize,
		context_after: opts.context_after.unwrap_or(0) as usize,
		max_columns: opts.max_columns.map(|v| v as usize),
		multiline: opts.multiline.unwrap_or(false),
	};
	let hidden = opts.hidden.unwrap_or(true);
	let gitignore = opts.gitignore.unwrap_or(true);
	let token = SearchToken::activate(opts.timeout_ms);

	let result = if root.is_file() {
		grep_single_file(&root, &matcher, params, token)
	} else {
		let workers = worker_threads();
		let strategy = forced.unwrap_or_else(|| choose_strategy(params, workers));
		let state = PassState::new();
		let results = match strategy {
			ExecStrategy::Sequential => {
				run_sequential(&root, globs.as_ref(), &matcher, params, hidden, gitignore, &state, token)
			},
			ExecStrategy::Windowed => {
				let stop = stop_after_matches(params).unwrap_or(u64::MAX);
				run_windowed(&root, globs.as_ref(), &matcher, params, hidden, gitignore, stop, &state, token)
			},
			ExecStrategy::ParallelUnbounded => {
				run_unbounded_parallel(&root, globs.as_ref(), &matcher, params, hidden, gitignore, &state, token)
			},
		};
		let files_searched = state.files_searched.load(Ordering::Relaxed);
		let skipped_oversized = state.skipped_oversized.load(Ordering::Relaxed);
		aggregate_results(results, params, files_searched, skipped_oversized)
	};
	token.deactivate();
	Ok(result)
}
