//! find 深水区测试（对齐 grep_tests 形制：TempDirGuard + 真实临时目录 fixtures）。
//!
//! 语义锚（v2 收口）：默认 order="bfs"（emit 序 = (depth,父序,名序)，蓝本
//! 对位 eval.c:1512-1526/:627/:979，见 bfswalk.rs）；sort_by_mtime 是 emit
//! 序之后的排序面、offset/max_results 截断口径不变；多模式+`!` 取反、
//! `**/` 前缀与 literal_separator、gitignore 默认 false（bfs 通路为分层链，
//! innermost→outermost + innermost `!` 反白名单）、超时取消即刻空返回、
//! type 过滤、深度界剪枝、截断边界。
//!
//! 既有 9 测改判说明：v1→v2 仅 emit 序变化，本组断言全部经由 names()
//! （字典序对齐）或 ordered()（mtime 全序）——排序输出面不变，故断言
//! 原样保绿；emit 序契约由新增 9 测（bfs 序/边界/mindepth/name 面/
//! symlink 策略/隐藏面/order 双通路/gitignore 链）按新契约钉死。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::bfswalk::{self, BfsKind, SymlinkPolicy, WalkConfig};
use super::find_glob_sync;
use crate::heart::SearchToken;
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

fn symlink(target: &Path, link: &Path) {
	#[cfg(target_family = "unix")]
	std::os::unix::fs::symlink(target, link).expect("create test symlink");
	#[cfg(target_family = "windows")]
	std::os::windows::fs::symlink_file(target, link).expect("create test symlink");
}

/// 显式钉死 mtime（utimensat 级精度，保证 mtime 排序断言的确定性/并列可造）。
fn set_mtime(path: &Path, secs: u64) {
	let file = fs::File::options().write(true).open(path).expect("open file for mtime");
	file.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
		.expect("set file mtime");
}

/// 测试专属 cancel key（同 grep_tests：锁专属位，隔离 heart 全局代际单测
/// 的并发 bump）。
fn test_cancel_key() -> String {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	format!("find-test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
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
		// 会话专属取消 key（测试走生产契约面，TS 每调用发 cancelKey）。
		cancel_key: Some(test_cancel_key()),
		// v2 bfs 对位面（缺省 = bfs 序 + -P 等位）。
		bfs_name: None,
		bfs_icase: None,
		min_depth: None,
		max_depth: None,
		follow: None,
		order: None,
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

/// 结果 → root 相对路径（排序后断言，供跨层级集合断言）。
fn relative_sorted(root: &TempDirGuard, paths: &[String]) -> Vec<String> {
	let mut rel = relative_in_order(root, paths);
	rel.sort();
	rel
}

/// 结果 → root 相对路径（保持给定序，供 bfs emit 全序断言）。
fn relative_in_order(root: &TempDirGuard, paths: &[String]) -> Vec<String> {
	let base = root.path();
	paths
		.iter()
		.map(|path| {
			Path::new(path)
				.strip_prefix(base)
				.unwrap_or(Path::new(path))
				.display()
				.to_string()
		})
		.collect()
}

fn run(opt: GlobOptions) -> Vec<String> {
	find_glob_sync(opt).expect("find_glob_sync must not fail")
}

/// bfswalk 直采：visit 全 face（文件/目录/symlink 都收），返回 (相对路径,
/// depth, kind) 按 visit 顺序。
fn probe(root: &TempDirGuard, config: &WalkConfig) -> Vec<(String, u64, BfsKind)> {
	let mut out: Vec<(String, u64, BfsKind)> = Vec::new();
	bfswalk::bfs_walk(root.path(), config, &mut |entry| {
		let rel = entry
			.path
			.strip_prefix(root.path())
			.unwrap_or(entry.path)
			.display()
			.to_string();
		out.push((rel, entry.depth, entry.kind));
		true
	});
	out
}

fn probe_config(_root: &TempDirGuard, max_depth: Option<u64>, follow: SymlinkPolicy) -> WalkConfig {
	WalkConfig {
		hidden: true,
		gitignore: false,
		follow,
		max_depth,
		min_depth: 0,
		workers: 4,
		token: SearchToken::activate(Some(test_cancel_key()), None),
	}
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
// 6. gitignore 默认 false（GlobTool --no-ignore）+ 显式开启（bfs 分层链）
// ---------------------------------------------------------------------------

#[test]
fn gitignore_off_by_default_and_toggle() {
	let root = TempDirGuard::new();
	// require_git 语义：非 git 目录不应用 .gitignore——fixture 造 .git。
	fs::create_dir_all(root.path().join(".git")).expect("create fixture .git");
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

// ---------------------------------------------------------------------------
// 10. bfs 层障序（v2 默认 emit 序 = (depth,父序,名序)）：浅文件先于深文件、
//     层内父序按名序；"dfs" 显式回退 v1 字典序
// ---------------------------------------------------------------------------

#[test]
fn bfs_layer_order_shallow_before_deep() {
	let root = TempDirGuard::new();
	write_file(root.path().join("z1.txt"), "z\n"); // d1 文件
	write_file(root.path().join("b/f5.txt"), "f5\n"); // d2
	write_file(root.path().join("d1/f4.txt"), "f4\n"); // d2
	write_file(root.path().join("d1/sub/f2.txt"), "f2\n"); // d3

	// 默认 "=bfs"：d1 只有 z1；d2 按（父序: b<d1, 层内名序）b/f5 < d1/f4；
	// d3 = d1/sub/f2；z1 在任何 d2 之前（层障：浅者先出）。
	let result = run(opts(&root, |_| {}));
	assert_eq!(
		relative_in_order(&root, &result),
		["z1.txt", "b/f5.txt", "d1/f4.txt", "d1/sub/f2.txt"],
		"bfs 层序：浅层先于深层；层内 (父序,名序)"
	);

	// 显式 "dfs"：回退 v1 路径（字典序兜底）。
	let opt = opts(&root, |o| o.order = Some("dfs".into()));
	assert_eq!(
		relative_sorted(&root, &run(opt)),
		["b/f5.txt", "d1/f4.txt", "d1/sub/f2.txt", "z1.txt"],
		"dfs = v1 现路径字典序"
	);

	// 非法 order 值按默认 bfs 处理。
	let opt = opts(&root, |o| o.order = Some("nonsense".into()));
	assert_eq!(
		relative_in_order(&root, &run(opt)),
		["z1.txt", "b/f5.txt", "d1/f4.txt", "d1/sub/f2.txt"]
	);
}

// ---------------------------------------------------------------------------
// 11. -maxdepth 边界语义（eval.c:1512-1526）：depth==max 的目录本身输出但
//     不下潜；depth>max 的文件不可达
// ---------------------------------------------------------------------------

#[test]
fn maxdepth_boundary_dir_emitted_but_not_descended() {
	let root = TempDirGuard::new();
	write_file(root.path().join("src/a.txt"), "a\n");
	write_file(root.path().join("src/sub/y.txt"), "y\n"); // depth 3，必沉

	// bfswalk 全 face 直采：边界层目录（src/sub, depth=2=max）在列，
	// 其子项 y.txt 永不 visit。
	let out = probe(&root, &probe_config(&root, Some(2), SymlinkPolicy::P));
	assert_eq!(
		out,
		[
			(String::new(), 0, BfsKind::Dir),
			("src".into(), 1, BfsKind::Dir),
			("src/a.txt".into(), 2, BfsKind::File),
			("src/sub".into(), 2, BfsKind::Dir),
		],
		"边界层目录本身输出、不下潜（y.txt 缺席）"
	);

	// find 面（emit=常规文件）：depth 2 文件在列，depth 3 文件剪除。
	let opt = opts(&root, |o| o.pattern = Some("src/*".into()));
	assert_eq!(relative_sorted(&root, &run(opt)), ["src/a.txt"]);

	// maxdepth=0：只 visit root 本身。
	let out = probe(&root, &probe_config(&root, Some(0), SymlinkPolicy::P));
	assert_eq!(out, [(String::new(), 0, BfsKind::Dir)]);
}

// ---------------------------------------------------------------------------
// 12. -mindepth：depth < min 不出、照常下潜（深层照出，按 bfs 序）
// ---------------------------------------------------------------------------

#[test]
fn mindepth_gates_emit_not_descent() {
	let root = TempDirGuard::new();
	write_file(root.path().join("f1.txt"), "1\n");
	write_file(root.path().join("d/f2.txt"), "2\n");
	write_file(root.path().join("d/e/f3.txt"), "3\n");

	// mindepth=2：f1（d1）不出但 d 下潜，f2/f3 照出（bfs 序）。
	let opt = opts(&root, |o| o.min_depth = Some(2));
	let result = run(opt);
	assert_eq!(
		relative_in_order(&root, &result),
		["d/f2.txt", "d/e/f3.txt"],
		"<min 不出、下潜照常"
	);

	// mindepth 越过全树深度（root=0 起算）→ 空。
	let opt = opts(&root, |o| o.min_depth = Some(9));
	assert!(run(opt).is_empty());
}

// ---------------------------------------------------------------------------
// 13. bfs -name：basename fnmatch 面，不匹配路径中段（eval.c:627）
// ---------------------------------------------------------------------------

#[test]
fn bfs_name_matches_basename_not_path_segments() {
	let root = TempDirGuard::new();
	write_file(root.path().join("ma.rs"), "ma\n");
	write_file(root.path().join("deep/lib.rs"), "lib\n");

	// "deep" 是中间目录路径段：basename 面不应命中任何文件。
	let opt = opts(&root, |o| o.bfs_name = Some("deep".into()));
	assert!(run(opt).is_empty(), "-name 只看 basename，不吃路径中段");

	// basename 面：任意深度命中（fnmatch 通配）。
	let opt = opts(&root, |o| o.bfs_name = Some("lib.rs".into()));
	assert_eq!(relative_sorted(&root, &run(opt)), ["deep/lib.rs"]);

	let opt = opts(&root, |o| o.bfs_name = Some("*.rs".into()));
	assert_eq!(relative_sorted(&root, &run(opt)), ["deep/lib.rs", "ma.rs"]);
}

// ---------------------------------------------------------------------------
// 14. bfs -iname：bfs_name 的大小写不敏感开关
// ---------------------------------------------------------------------------

#[test]
fn bfs_icase_iname() {
	let root = TempDirGuard::new();
	write_file(root.path().join("Readme.TXT"), "doc\n");
	write_file(root.path().join("lib.rs"), "code\n");

	// 敏感（默认）：不命中。
	let opt = opts(&root, |o| o.bfs_name = Some("readme.txt".into()));
	assert!(run(opt).is_empty());

	// icase：命中（-iname）。
	let opt = opts(&root, |o| {
		o.bfs_name = Some("readme.txt".into());
		o.bfs_icase = Some(true);
	});
	assert_eq!(relative_sorted(&root, &run(opt)), ["Readme.TXT"]);
}

// ---------------------------------------------------------------------------
// 15. -P（默认）：symlink 报 type=l、不入深（eval.c:979 / bftw_stat_flags）
// ---------------------------------------------------------------------------

#[test]
fn p_policy_symlink_reported_l_and_not_descended() {
	let root = TempDirGuard::new();
	write_file(root.path().join("real/f.txt"), "f\n");
	symlink(&root.path().join("real"), &root.path().join("link")); // → 目录
	symlink(&root.path().join("real/f.txt"), &root.path().join("filelink")); // → 文件

	// bfswalk 全 face：link/filelink 都报 l；link 的子项不可达。
	let out = probe(&root, &probe_config(&root, None, SymlinkPolicy::P));
	assert_eq!(
		out,
		[
			(String::new(), 0, BfsKind::Dir),
			("filelink".into(), 1, BfsKind::Symlink),
			("link".into(), 1, BfsKind::Symlink),
			("real".into(), 1, BfsKind::Dir),
			("real/f.txt".into(), 2, BfsKind::File),
		],
		"-P：symlink 报 l，不落入目标子树"
	);

	// find 面（emit=常规文件）：只有 real/f.txt（l 不出、目标子树不可达）。
	let result = run(opts(&root, |_| {}));
	assert_eq!(relative_sorted(&root, &result), ["real/f.txt"]);
	assert!(result.iter().all(|path| !path.contains("link")), "link/filelink 面不出");
}

// ---------------------------------------------------------------------------
// 16. -L：跟随 symlink（报目标类型 + 入深）+ inode 访问集环防不死循环
// ---------------------------------------------------------------------------

#[test]
fn l_policy_follows_symlinks_and_cycle_terminates() {
	let root = TempDirGuard::new();
	write_file(root.path().join("realdir/f.txt"), "f\n");
	symlink(&root.path().join("realdir"), &root.path().join("alias")); // alias → realdir
	symlink(&root.path().join("realdir"), &root.path().join("realdir/loop")); // 自环

	// -L：alias（→ 真目录）报 d 且入深：f.txt 经 alias 路径可达；
	// loop（→ 已访问的 realdir）被 inode 访问集挡下（不死循环），
	// realdir 本体因 alias 同 inode 先占队列而去重。
	let opt = opts(&root, |o| o.follow = Some("L".into()));
	let result = run(opt);
	assert_eq!(
		relative_sorted(&root, &result),
		["alias/f.txt"],
		"-L 跟随入深 + 环防去重，且不 hang"
	);
	assert!(!result.iter().any(|path| path.contains("loop") || path.contains("realdir")));

	// bfswalk 全 face 锚：loop 本身被 visit（bfs 语义：环条目照出报型），
	// 但其子树永不展开（无 loop 后代）。
	let out = probe(&root, &probe_config(&root, None, SymlinkPolicy::L));
	assert!(
		out.iter().all(|(path, _, _)| !path.starts_with("alias/loop/") && !path.starts_with("realdir/")),
		"环不能展开：loop 子树不可达、realdir 子树经 alias 去重"
	);
	assert_eq!(
		out.iter().find(|(path, depth, _)| path == "alias" && *depth == 1).map(|(_, _, k)| *k),
		Some(BfsKind::Dir),
		"-L 下 symlink→目录解链后报 d"
	);
}

// ---------------------------------------------------------------------------
// 17. 隐藏面开关（GlobTool --hidden 默认开；关时跳过 `.` 开头条目子树）
// ---------------------------------------------------------------------------

#[test]
fn hidden_toggle_in_bfs_walk() {
	let root = TempDirGuard::new();
	write_file(root.path().join("vis.txt"), "v\n");
	write_file(root.path().join(".dot.txt"), "d\n");
	write_file(root.path().join(".h/f.txt"), "hf\n");

	// 默认 hidden=true：隐藏文件/目录全收。
	let result = run(opts(&root, |_| {}));
	assert_eq!(
		relative_sorted(&root, &result),
		[".dot.txt", ".h/f.txt", "vis.txt"],
		"--hidden 语义：隐藏面默认在列"
	);

	// hidden=false：`.` 开头条目整面剔除（含 .h 子树）。
	let opt = opts(&root, |o| o.hidden = Some(false));
	assert_eq!(relative_sorted(&root, &run(opt)), ["vis.txt"]);
}

// ---------------------------------------------------------------------------
// 18. gitignore 分层链：innermost 优先（子目录 `!` 反白名单压过根规则）
// ---------------------------------------------------------------------------

#[test]
fn gitignore_chain_innermost_whitelist_wins() {
	let root = TempDirGuard::new();
	// require_git 语义：非 git 目录不应用 .gitignore——fixture 造 .git。
	fs::create_dir_all(root.path().join(".git")).expect("create fixture .git");
	write_file(root.path().join(".gitignore"), "*.log\n");
	write_file(root.path().join("sub/.gitignore"), "!keep.log\n");
	write_file(root.path().join("drop.log"), "drop\n");
	write_file(root.path().join("sub/keep.log"), "keep\n");
	write_file(root.path().join("sub/other.log"), "other\n");

	// 链式查询（innermost→outermost）：sub/keep.log 被 sub 的 `!` 反白名单
	// 保出；drop.log/sub-other.log 由根 `*.log` 剔除；.gitignore 本体不受
	// `*.log` 波及。
	let opt = opts(&root, |o| o.gitignore = Some(true));
	assert_eq!(
		relative_sorted(&root, &run(opt)),
		[".gitignore", "sub/.gitignore", "sub/keep.log"]
	);
}
