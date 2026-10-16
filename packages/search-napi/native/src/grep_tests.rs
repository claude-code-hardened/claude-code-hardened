//! grep 深水区测试（对齐 omp grep.rs tests :2633-3886 的形制：TempDirGuard
//! + 真实临时目录 fixtures）。
//!
//! 覆盖：context 行采集、offset+max_count 全局聚合、count/-l 语义、
//! NUL 二进制 quit、multiline dotall 首行语义、gitignore 嵌套+取反+关闭、
//! 序贯/窗口/并行三策略一致性、4MiB 前缀窗、超时取消、max_columns、fifo。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{ExecStrategy, grep_search_impl};
use crate::types::{GrepMatch, GrepOptions, GrepOutputMode};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct TempDirGuard(PathBuf);

impl TempDirGuard {
	fn new() -> Self {
		static COUNTER: AtomicU64 = AtomicU64::new(0);
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time is after UNIX_EPOCH")
			.as_nanos();
		let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
		let pid = std::process::id();
		let path = std::env::temp_dir().join(format!("search-napi-grep-test-{pid}-{nanos}-{seq}"));
		fs::create_dir_all(&path).expect("create temp test directory");
		Self(path)
	}

	fn path(&self) -> &Path {
		&self.0
	}
}

impl Drop for TempDirGuard {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

fn write_file(path: impl AsRef<Path>, content: &str) {
	let path = path.as_ref();
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).expect("create parent directories for test file");
	}
	fs::write(path, content).expect("write test file");
}

fn base_opts(pattern: &str, path: &Path) -> GrepOptions {
	GrepOptions {
		pattern: pattern.to_owned(),
		path: Some(path.to_string_lossy().into_owned()),
		glob: None,
		r#type: None,
		ignore_case: None,
		multiline: None,
		hidden: None,
		gitignore: None,
		max_count: None,
		offset: None,
		context_before: None,
		context_after: None,
		max_columns: None,
		mode: None,
		timeout_ms: None,
	}
}

/// GrepOptions 无 Clone（napi object 无 derive），按值消费重建。
fn opts_with(opts: GrepOptions, mutate: impl FnOnce(&mut GrepOptions)) -> GrepOptions {
	let mut opts = opts;
	mutate(&mut opts);
	opts
}

/// GrepMatch 无 Debug/PartialEq：逐字段断言辅助。
fn assert_rows_equal(got: &[GrepMatch], expected: &[(String, u32, &str)]) {
	assert_eq!(got.len(), expected.len(), "row count mismatch");
	for (row, (path, line_number, line)) in got.iter().zip(expected) {
		assert!(row.path.ends_with(path.as_str()), "path {:?} should end with {path:?}", row.path);
		assert_eq!(row.line_number, *line_number, "line_number of {path}");
		assert_eq!(row.line, *line, "line text of {path}");
	}
}

// ---------------------------------------------------------------------------
// 1. context 行采集
// ---------------------------------------------------------------------------

#[test]
fn content_matches_collect_context_lines() {
	let root = TempDirGuard::new();
	write_file(root.path().join("ctx.txt"), "one\ntwo needle\nthree\nfour\nfive needle six\n");
	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.context_before = Some(1);
		o.context_after = Some(1);
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("sequential grep");
	assert_eq!(result.total_matches, 2);
	assert_eq!(result.files_searched, 1);
	assert_eq!(result.matches.len(), 2);
	let first = &result.matches[0];
	assert_eq!(first.line_number, 2);
	assert_eq!(first.line, "two needle");
	assert_eq!(first.before, vec!["one".to_owned()]);
	assert_eq!(first.after, vec!["three".to_owned()]);
	let second = &result.matches[1];
	assert_eq!(second.line_number, 5);
	assert_eq!(second.line, "five needle six");
	assert_eq!(second.before, vec!["four".to_owned()]);
	assert!(second.after.is_empty(), "EOF 后无 after 行");
}

// ---------------------------------------------------------------------------
// 2. offset + max_count 全局聚合（content）
// ---------------------------------------------------------------------------

#[test]
fn offset_and_max_count_aggregate_globally_in_content_mode() {
	let root = TempDirGuard::new();
	write_file(root.path().join("f_a.txt"), "needle 0\nno\nneedle 1\nneedle 2\n");
	write_file(root.path().join("f_b.txt"), "needle 3\nneedle 4\n");
	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.offset = Some(2);
		o.max_count = Some(2);
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("sequential grep");
	// 跳过前 2 个命中（f_a line1/line3），再取 2 个：f_a 第 3 命中 + f_b 第 1 命中。
	assert_rows_equal(
		&result.matches,
		&[
			("f_a.txt".to_owned(), 4, "needle 2"),
			("f_b.txt".to_owned(), 1, "needle 3"),
		],
	);
	assert_eq!(result.total_matches, 5, "total = 全部命中数（裁剪前）");
	assert_eq!(result.files_with_matches, 2);
	assert_eq!(result.files_searched, 2);
	assert!(result.limit_reached, "emitted 触达 max_count");
}

// ---------------------------------------------------------------------------
// 3. count 语义（rg -c：total=Σ，offset 按命中计数跨文件跳）
// ---------------------------------------------------------------------------

#[test]
fn count_mode_semantics_with_offset_and_limit() {
	let root = TempDirGuard::new();
	write_file(root.path().join("a.txt"), "needle\nneedle\nneedle\n");
	write_file(root.path().join("b.txt"), "needle\n");

	// 基线：每文件计数行（path 序），total=Σ。
	let opt = opts_with(base_opts("needle", root.path()), |o| o.mode = Some(GrepOutputMode::Count));
	let result = grep_search_impl(opt, Some(ExecStrategy::Windowed)).expect("count grep");
	assert_eq!(result.matches.len(), 2);
	assert_eq!(result.matches[0].line, "3");
	assert_eq!(result.matches[1].line, "1");
	assert_eq!(result.total_matches, 4);
	assert_eq!(result.files_with_matches, 2);

	// offset=3：a.txt 的计数被全额跳过 → 不出 a 行，只出 b 行。
	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.mode = Some(GrepOutputMode::Count);
		o.offset = Some(3);
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("count skip-file grep");
	assert_eq!(result.matches.len(), 1);
	assert_eq!(result.matches[0].line, "1");
	assert_eq!(result.total_matches, 4);
	assert_eq!(result.files_with_matches, 2, "被 offset 跳过的文件仍计入 files_with_matches");

	// max_count=1：预算耗尽即截断并置 limit_reached。
	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.mode = Some(GrepOutputMode::Count);
		o.max_count = Some(1);
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("count limit grep");
	assert_eq!(result.matches.len(), 1);
	assert!(result.limit_reached);
}

// ---------------------------------------------------------------------------
// 4. filesWithMatches：去重路径序 + offset/max 按文件粒度 + 短路
// ---------------------------------------------------------------------------

#[test]
fn files_with_matches_mode_dedup_sorted_and_limits_by_file() {
	let root = TempDirGuard::new();
	write_file(root.path().join("a.txt"), "needle\nneedle\nneedle\n");
	write_file(root.path().join("b.txt"), "needle\n");
	write_file(root.path().join("c.txt"), "no match\n");

	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.mode = Some(GrepOutputMode::FilesWithMatches)
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::ParallelUnbounded)).expect("fsw grep");
	assert_rows_equal(&result.matches, &[("a.txt".to_owned(), 0, ""), ("b.txt".to_owned(), 0, "")]);
	assert_eq!(result.total_matches, 2);
	assert_eq!(result.files_with_matches, 2);
	assert_eq!(result.files_searched, 3);
	assert!(!result.limit_reached);

	// offset=1 按文件跳过 a.txt（-l 每文件 1 个 match 占位）。
	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.mode = Some(GrepOutputMode::FilesWithMatches);
		o.offset = Some(1);
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::ParallelUnbounded)).expect("fsw offset grep");
	assert_rows_equal(&result.matches, &[("b.txt".to_owned(), 0, "")]);
	assert_eq!(result.files_with_matches, 2, "跳过的文件仍计入 files_with_matches");

	// max_count=1 截断文件行数。
	let opt = opts_with(base_opts("needle", root.path()), |o| {
		o.mode = Some(GrepOutputMode::FilesWithMatches);
		o.max_count = Some(1);
	});
	let result = grep_search_impl(opt, Some(ExecStrategy::Windowed)).expect("fsw limit grep");
	assert_eq!(result.matches.len(), 1);
	assert!(result.limit_reached);
}

// ---------------------------------------------------------------------------
// 5. NUL 二进制 quit（rg BinaryDetection::quit(b'\x00')）
// ---------------------------------------------------------------------------

#[test]
fn binary_file_with_nul_byte_is_skipped() {
	let root = TempDirGuard::new();
	write_file(root.path().join("bin.dat"), "needle\0needle\n");
	write_file(root.path().join("text.txt"), "ok\nneedle\n");
	let result = grep_search_impl(base_opts("needle", root.path()), Some(ExecStrategy::Sequential))
		.expect("binary grep");
	assert_rows_equal(&result.matches, &[("text.txt".to_owned(), 2, "needle")]);
	assert_eq!(result.total_matches, 1);
	assert_eq!(result.files_searched, 2, "二进制文件计入 searched 但无命中");
	assert_eq!(result.files_with_matches, 1);
}

// ---------------------------------------------------------------------------
// 6. multiline dotall：跨行 match 块首行 + 行号取首行
// ---------------------------------------------------------------------------

#[test]
fn multiline_match_reports_first_line_of_block() {
	let root = TempDirGuard::new();
	write_file(root.path().join("ml.txt"), "foo\nmiddle\nbar\nbaz\n");
	let opt = opts_with(base_opts("foo.*bar", root.path()), |o| o.multiline = Some(true));
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("multiline grep");
	assert_eq!(result.total_matches, 1);
	assert_eq!(result.matches.len(), 1);
	let row = &result.matches[0];
	assert_eq!(row.line_number, 1, "行号取匹配块首行");
	assert_eq!(row.line, "foo", "line 文本取匹配块首行");
}

// ---------------------------------------------------------------------------
// 7. gitignore 嵌套 + 取反 + 关闭
// ---------------------------------------------------------------------------

#[test]
fn gitignore_nested_negation_and_disable() {
	let root = TempDirGuard::new();
	write_file(root.path().join(".gitignore"), "*.log\n");
	write_file(root.path().join("keep/.gitignore"), "!keep.log\n");
	write_file(root.path().join("keep/keep.log"), "needle\n");
	write_file(root.path().join("a.log"), "needle\n");
	write_file(root.path().join("plain.txt"), "nothing relevant\n");

	// 默认 gitignore=true：a.log 被根规则忽略，keep.log 被嵌套取反恢复。
	// hidden 默认 true → 两份 .gitignore 也被搜索（rg --hidden 语义）。
	let result = grep_search_impl(base_opts("needle", root.path()), Some(ExecStrategy::Sequential))
		.expect("ignore grep");
	assert_rows_equal(&result.matches, &[("keep/keep.log".to_owned(), 1, "needle")]);
	assert_eq!(
		result.files_searched, 4,
		"keep.log + plain.txt + 两份 .gitignore（hidden 默认收录）"
	);

	// gitignore=false：关闭忽略（GrepTool --no-ignore）。
	let opt = opts_with(base_opts("needle", root.path()), |o| o.gitignore = Some(false));
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("no-ignore grep");
	assert_eq!(result.files_searched, 5);
	assert_eq!(result.matches.len(), 2);
	assert_eq!(result.files_with_matches, 2);
}

// ---------------------------------------------------------------------------
// 8. 序贯 / 窗口 / 并行 三策略一致性
// ---------------------------------------------------------------------------

#[test]
fn sequential_windowed_parallel_agree_on_same_fixtures() {
	let root = TempDirGuard::new();
	for dir in ["src", "src/deep", "tests"] {
		for i in 0..4 {
			write_file(
				root.path().join(format!("{dir}/f{i}.txt")),
				&format!("before\nneedle {dir} {i}\nneedle again {i}\nafter\nno\n"),
			);
		}
	}
	let make_opt = |pattern: &str, with_context: bool| {
		opts_with(base_opts(pattern, root.path()), |o| {
			if with_context {
				o.context_before = Some(1);
				o.context_after = Some(1);
			}
		})
	};
	let run = |pattern: &str, with_context: bool, strategy: ExecStrategy| {
		grep_search_impl(make_opt(pattern, with_context), Some(strategy)).expect("strategy grep")
	};
	let sequential = run("needle.*", true, ExecStrategy::Sequential);
	let windowed = run("needle.*", true, ExecStrategy::Windowed);
	let parallel = run("needle.*", true, ExecStrategy::ParallelUnbounded);

	for result in [&sequential, &windowed, &parallel] {
		assert_eq!(result.total_matches, 24);
		assert_eq!(result.files_with_matches, 12);
		assert_eq!(result.files_searched, 12);
		assert_eq!(result.matches.len(), 24);
	}
	type RowDump = (String, u32, String, Vec<String>, Vec<String>);
	let dump = |rows: &[GrepMatch]| -> Vec<RowDump> {
		rows.iter()
			.map(|row| {
				(row.path.clone(), row.line_number, row.line.clone(), row.before.clone(), row.after.clone())
			})
			.collect()
	};
	assert_eq!(dump(&sequential.matches), dump(&windowed.matches), "windowed vs sequential");
	assert_eq!(dump(&sequential.matches), dump(&parallel.matches), "parallel vs sequential");
}

// ---------------------------------------------------------------------------
// 9. 4MiB 前缀窗：超限文件 pass2 只读前缀
// ---------------------------------------------------------------------------

#[test]
fn oversized_file_reads_prefix_window_only() {
	let root = TempDirGuard::new();
	let mut big = String::from("needle one\n");
	// 前缀 4MiB 覆盖到 filler 内部；needle two 落在 4MiB 之后被窗口截断。
	for _ in 0..70 {
		big.push_str(&"A".repeat(65_536));
		big.push('\n');
	}
	big.push_str("needle two\n");
	assert!(big.len() as u64 > super::MAX_FILE_BYTES);
	write_file(root.path().join("big.bin"), &big);
	write_file(root.path().join("small.txt"), "needle small\n");

	let result = grep_search_impl(base_opts("needle", root.path()), Some(ExecStrategy::Sequential))
		.expect("oversized grep");
	assert_eq!(result.matches.len(), 2, "needle small（normal 组先行）+ needle one（oversized 组前缀窗内）");
	assert!(result.matches[0].path.ends_with("small.txt"));
	assert!(result.matches[1].path.ends_with("big.bin"), "超限组缀尾：normal 结果先于 oversized");
	assert_eq!(result.matches[1].line_number, 1);
	assert_eq!(result.matches[1].line, "needle one");
	assert_eq!(result.total_matches, 2);
	assert_eq!(result.files_searched, 2, "超限文件 pass2 前缀搜索计入 searched");
	assert_eq!(result.skipped_oversized, 0, "前缀读取成功不计 skipped_oversized");
}

// ---------------------------------------------------------------------------
// 10. 超时取消：中途停止（0ms deadline 即刻全局取消）
// ---------------------------------------------------------------------------

#[test]
fn timeout_cancels_search_immediately() {
	let root = TempDirGuard::new();
	for i in 0..8 {
		write_file(root.path().join(format!("f{i}.txt")), "needle\n");
	}
	let opt = opts_with(base_opts("needle", root.path()), |o| o.timeout_ms = Some(0));
	let result = grep_search_impl(opt, Some(ExecStrategy::Windowed)).expect("timed out grep");
	assert!(result.matches.is_empty());
	assert_eq!(result.files_searched, 0, "取消后不再搜索任何文件");
	assert_eq!(result.total_matches, 0);
}

// ---------------------------------------------------------------------------
// 11. max_columns 截断（字符边界安全）
// ---------------------------------------------------------------------------

#[test]
fn max_columns_truncates_long_lines() {
	let root = TempDirGuard::new();
	write_file(root.path().join("long.txt"), "abcdefghij\nabc\n");
	let opt = opts_with(base_opts("abcdefghij|abc", root.path()), |o| o.max_columns = Some(5));
	let result = grep_search_impl(opt, Some(ExecStrategy::Sequential)).expect("max_columns grep");
	assert_eq!(result.matches.len(), 2);
	let long_row = &result.matches[0];
	assert_eq!(long_row.line, "ab...", "max-3 字符 + 省略号");
	assert_eq!(long_row.truncated, Some(true));
	let short_row = &result.matches[1];
	assert_eq!(short_row.line, "abc");
	assert_eq!(short_row.truncated, None);
}

// ---------------------------------------------------------------------------
// 12. fifo 跳过（unix mkfifo，不阻塞不崩溃）
// ---------------------------------------------------------------------------

#[test]
fn fifo_entries_are_skipped_without_blocking() {
	let root = TempDirGuard::new();
	let fifo = root.path().join("pipe.fifo");
	let status = Command::new("mkfifo").arg(&fifo).status().expect("spawn mkfifo");
	assert!(status.success(), "mkfifo failed");
	write_file(root.path().join("ok.txt"), "needle\n");

	let result = grep_search_impl(base_opts("needle", root.path()), Some(ExecStrategy::ParallelUnbounded))
		.expect("fifo grep must not block");
	assert_rows_equal(&result.matches, &[("ok.txt".to_owned(), 1, "needle")]);
	assert_eq!(result.files_searched, 1, "fifo 非 regular file，不进候选");
}

// ---------------------------------------------------------------------------
// Windows 路径归一（当前仅在 cfg(windows) 下跑；linux 空占位）
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[test]
fn windows_path_normalization() {
	// 反斜杠分隔与 drive 字母路径在 Windows 侧由 CI 覆盖；此处占位保证
	// cfg(windows) 编译面成立。
}
