//! find 深水区测试（对齐 grep_tests 形制：TempDirGuard + 真实临时目录 fixtures）。
//!
//! 语义锚（v1 收口）：mtime oldest-first + offset/max_results 精确截断、
//! 多模式+`!` 取反、`**/` 前缀与 literal_separator、gitignore 默认 false、
//! 超时取消即刻空返回、type 过滤、深度界剪枝、截断边界。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::find_glob_sync;
use crate::types::GlobOptions;

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
		let path = std::env::temp_dir().join(format!("search-napi-find-test-{pid}-{nanos}-{seq}"));
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

/// 显式钉死 mtime（utimensat 级精度，保证 mtime 排序断言的确定性/并列可造）。
fn set_mtime(path: &Path, secs: u64) {
	let file = fs::File::options().write(true).open(path).expect("open file for mtime");
	file.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
		.expect("set file mtime");
}

fn base_opts() -> GlobOptions {
	GlobOptions {
		pattern: None,
		path: None,
		r#type: None,
		hidden: None,
		gitignore: None,
		sort_by_mtime: None,
		max_results: None,
		offset: None,
		timeout_ms: None,
	}
}

fn opts(root: &TempDirGuard, mutate: impl FnOnce(&mut GlobOptions)) -> GlobOptions {
	let mut opt = base_opts();
	opt.path = Some(root.path().to_string_lossy().into_owned());
	mutate(&mut opt);
	opt
}

/// 结果末段名（按返回序，供 mtime 排序等**有序**断言）。
fn ordered(paths: &[String]) -> Vec<String> {
	paths
		.iter()
		.map(|path| path.rsplit('/').next().unwrap_or(path).to_owned())
		.collect()
}

/// 结果末段名（字典序对齐后断言，供无序集合断言面）。
fn names(mut paths: Vec<String>) -> Vec<String> {
	paths.sort();
	paths
		.iter()
		.map(|path| path.rsplit('/').next().unwrap_or(path).to_owned())
		.collect()
}

fn run(opt: GlobOptions) -> Vec<String> {
	find_glob_sync(opt).expect("find_glob_sync must not fail")
}

// ---------------------------------------------------------------------------
// 1. mtime oldest-first + max_results/offset 精确（先全收排序后 skip/take）
// ---------------------------------------------------------------------------

#[test]
fn mtime_oldest_first_with_offset_and_max_results() {
	let root = TempDirGuard::new();
	for i in 1..=6 {
		let path = root.path().join(format!("f{i}.txt"));
		write_file(&path, "x\n");
		set_mtime(&path, 1000 + i as u64 * 10);
	}
	// 全量：f1（最旧）→ f6（最新）。
	let result = run(opts(&root, |o| o.sort_by_mtime = Some(true)));
	assert_eq!(
		ordered(&result),
		["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"],
		"oldest-first 全序"
	);

	// offset=1 skip 最旧的 f1，max_results=2 截断 → f2, f3。
	let opt = opts(&root, |o| {
		o.sort_by_mtime = Some(true);
		o.offset = Some(1);
		o.max_results = Some(2);
	});
	assert_eq!(ordered(&run(opt)), ["f2.txt", "f3.txt"]);
}

// ---------------------------------------------------------------------------
// 2. mtime 并列 tie=路径字典序（稳定全序）
// ---------------------------------------------------------------------------

#[test]
fn mtime_tie_breaks_lexicographic_by_path() {
	let root = TempDirGuard::new();
	for (name, secs) in [("b.txt", 777), ("a.txt", 777), ("x.txt", 100)] {
		let path = root.path().join(name);
		write_file(&path, "tie\n");
		set_mtime(&path, secs);
	}
	let result = run(opts(&root, |o| o.sort_by_mtime = Some(true)));
	assert_eq!(ordered(&result), ["x.txt", "a.txt", "b.txt"], "最旧先行；mtime 并列按路径字典序");
}

// ---------------------------------------------------------------------------
// 3. 多模式 + `!` 取反（include ∧ ¬exclude）
// ---------------------------------------------------------------------------

#[test]
fn multi_pattern_with_negation() {
	let root = TempDirGuard::new();
	write_file(root.path().join("app.rs"), "code\n");
	write_file(root.path().join("test_app.rs"), "test\n");
	write_file(root.path().join("notes.txt"), "doc\n");
	write_file(root.path().join("node_modules/x.rs"), "dep\n");

	let opt = opts(&root, |o| o.pattern = Some("*.rs,!test_*.rs,!node_modules".into()));
	assert_eq!(names(run(opt)), ["app.rs"], "include 命中再被 `!` 剔除");
}

// ---------------------------------------------------------------------------
// 4. 全排除表达式 = 默认全收（无 include ⇒ 收一切）
// ---------------------------------------------------------------------------

#[test]
fn exclude_only_expr_means_default_include() {
	let root = TempDirGuard::new();
	write_file(root.path().join("lib.rs"), "code\n");
	write_file(root.path().join("lib.ts"), "ts\n");
	write_file(root.path().join("deep/lib.ts"), "deep\n");

	let opt = opts(&root, |o| o.pattern = Some("!*.ts".into()));
	let result = run(opt);
	assert_eq!(names(result.clone()), ["lib.rs"], "只取反 .ts，其余默认全收");
	assert!(result.iter().all(|path| !path.ends_with("lib.ts")));
}

// ---------------------------------------------------------------------------
// 5. `**/` 自动前缀 + literal_separator（`*` 不跨 `/`）
// ---------------------------------------------------------------------------

#[test]
fn double_star_prefix_and_literal_separator() {
	let root = TempDirGuard::new();
	write_file(root.path().join("lib.rs"), "root\n");
	write_file(root.path().join("deep/nested/lib.rs"), "deep\n");
	write_file(root.path().join("src/a.ts"), "ts\n");
	write_file(root.path().join("src/deep/b.ts"), "nested\n");

	// 无分隔符裸名 → rg basename-anywhere 语义（`**/lib.rs`）。
	let opt = opts(&root, |o| o.pattern = Some("lib.rs".into()));
	assert_eq!(names(run(opt)), ["lib.rs", "lib.rs"], "裸模式按 **/ 前缀在任意深度命中");

	// 带路径段模式不补前缀：`src/*.ts` 不下沉 src/deep。
	let opt = opts(&root, |o| o.pattern = Some("src/*.ts".into()));
	assert_eq!(names(run(opt)), ["a.ts"]);
}

// ---------------------------------------------------------------------------
// 6. gitignore 默认 false（GlobTool --no-ignore）+ 显式开启
// ---------------------------------------------------------------------------

#[test]
fn gitignore_off_by_default_and_toggle() {
	let root = TempDirGuard::new();
	write_file(root.path().join(".gitignore"), "*.log\n");
	write_file(root.path().join("ignored.log"), "needle\n");
	write_file(root.path().join("plain.txt"), "keep\n");

	// 默认 gitignore=false：忽略规则不参与（hidden 默认 true 连 .gitignore 也列）。
	let result = run(opts(&root, |_| {}));
	assert_eq!(
		names(result),
		[".gitignore", "ignored.log", "plain.txt"],
		"--no-ignore 语义：被忽略文件也在列"
	);

	// 显式 gitignore=true：*.log 被剔除。
	let opt = opts(&root, |o| o.gitignore = Some(true));
	assert_eq!(names(run(opt)), [".gitignore", "plain.txt"]);
}

// ---------------------------------------------------------------------------
// 7. type 过滤（已知扩展名/文件名面 + 未知 type Custom 等值）
// ---------------------------------------------------------------------------

#[test]
fn type_filter_matches_basename_and_extension() {
	let root = TempDirGuard::new();
	write_file(root.path().join("src/lib.rs"), "rs\n");
	write_file(root.path().join("src/main.py"), "py\n");
	write_file(root.path().join("Dockerfile"), "docker\n");
	write_file(root.path().join("Dockerfile.dev"), "docker variant\n");
	write_file(root.path().join("app.odin"), "odin\n");

	let rs = opts(&root, |o| o.r#type = Some("rs".into()));
	assert_eq!(names(run(rs)), ["lib.rs"]);
	let docker = opts(&root, |o| o.r#type = Some("docker".into()));
	assert_eq!(names(run(docker)), ["Dockerfile"], "文件名面 type 按 basename 等值");
	let odin = opts(&root, |o| o.r#type = Some(".odin".into()));
	assert_eq!(names(run(odin)), ["app.odin"], "未知 type 归一扩展名等值");
}

// ---------------------------------------------------------------------------
// 8. 深度界剪枝（bfs -maxdepth 等位）
// ---------------------------------------------------------------------------

#[test]
fn depth_bound_limits_traversal() {
	let root = TempDirGuard::new();
	write_file(root.path().join("a.txt"), "root\n");
	write_file(root.path().join("src/a.txt"), "shallow\n");
	write_file(root.path().join("src/deep/b.txt"), "deep\n");

	// `src/*.txt` 字面 2 段 → 深度界 2：src/deep/b.txt（3 层）剪枝。
	let opt = opts(&root, |o| o.pattern = Some("src/*.txt".into()));
	assert_eq!(names(run(opt)), ["a.txt"]);
}

// ---------------------------------------------------------------------------
// 9. 超时取消即刻返回 + 截断边界（offset 出界 / max_results=0）
// ---------------------------------------------------------------------------

#[test]
fn timeout_and_truncation_edges() {
	let root = TempDirGuard::new();
	write_file(root.path().join("f1.txt"), "a\n");
	write_file(root.path().join("f2.txt"), "b\n");

	// 0ms deadline：token 即刻取消 → 空结果、不 hang、可早返回。
	let opt = opts(&root, |o| o.timeout_ms = Some(0));
	assert!(run(opt).is_empty(), "取消后不得产出任何结果");

	// max_results=0 → 空；offset 越界 → 空。
	let opt = opts(&root, |o| o.max_results = Some(0));
	assert!(run(opt).is_empty());
	let opt = opts(&root, |o| o.offset = Some(99));
	assert!(run(opt).is_empty());
}
