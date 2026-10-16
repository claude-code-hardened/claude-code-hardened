//! find/glob 模块 — bfs 语义的进程内等位（对齐 GlobTool 消费面
//! `rg --files --glob --sort=modified --no-ignore --hidden` + argv0 find 子集）。
//!
//! 语义锚（v2：默认走 bfswalk 的 breadth-first 层障序）：
//! - **order 双通路**：默认 "bfs" → `bfswalk::bfs_walk`（emit 全序 =
//!   (depth, 父序, 名序)，蓝本对照见 bfswalk.rs 头注）；"dfs" → v1 现路径
//!   （ignore::WalkParallel + 字典序兜底）原样保留；
//! - **排序契约**：bfs 序是**排序前的 emit 序**——sort_by_mtime（oldest-first
//!   加路径 tie 全序）在其后照旧；无 sort 时保留 BFS emit 序（v1 的字典序
//!   兜底仅剩 dfs 通路）；offset/max_results 截断在最后照旧；
//! - pattern：逗号多模式；`!` 前缀取反 = 排除（sanitize::GlobFilter 的
//!   include ∧ ¬exclude；无 include 全收）；归一走 sanitize::build_glob_pattern；
//! - type 过滤：sanitize::resolve_type_filter + matches_type_filter（basename
//!   扩展名/文件名等值，rg --type 语义）；
//! - bfs_name/icase：eval.c:627 `eval_name` 的 basename fnmatch 对位
//!   （root 尾斜杠经 `Path::file_name` 收口），与 GlobFilter 路径面正交；
//! - min_depth：bfs -mindepth 对位（depth < min 不出、照常下潜）；
//! - max_depth：bfs -maxdepth 对位（root=0 起算；depth==max 目录只输出
//!   不下潜；与 include 面推导的 depth_bound 取交；dfs 通路同界走
//!   WalkBuilder.max_depth）；
//! - follow：bfs -P/-L/-H 对位（P 默认；详见 bfswalk.rs；仅 bfs 通路生效，
//!   dfs 通路 WalkParallel follow_links=false 恒等 -P）；
//! - hidden 默认 true、gitignore 默认 false（GlobTool --no-ignore 语义；
//!   bfs 通路的 gitignore 走分层链，dfs 通路维持 walk.rs 原生）；
//! - 深度界：GlobFilter::depth_bound → 通路各自的 max_depth 剪枝
//!   （dfs 用 WalkBuilder max_depth，bfs 用 eval.c:1512-1526 双面语义）；
//! - emit 面 = 常规文件（rg --files 语义）：-P 下 symlink 报 l 不出、
//!   -L 解链为 f 才出（对位 bfs `-type f`）；
//! - 取消/超时：SearchToken 每层/每目录/回排前检查（bfs 通路），取消 →
//!   丢弃前置前缀即刻空返回（对位 v1 visitor Quit 的收敛面）。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use globset::GlobMatcher;
use ignore::WalkState;

use crate::heart::SearchToken;
use crate::sanitize::{self, GlobFilter, TypeFilter};
use crate::types::GlobOptions;

#[path = "bfswalk.rs"]
pub(crate) mod bfswalk;

/// 并行遍历 worker 上限（与 grep.rs MAX_WORKERS 同钳制口径）。
const FIND_MAX_WORKERS: usize = 16;

/// bfs `-i?name` 的 basename fnmatch 判定器（eval.c:627 eval_name 对位；
/// 面限 basename，`*` 跨 `/` 语义 moot）。
struct NameMatcher {
	matcher: GlobMatcher,
}

impl NameMatcher {
	fn new(pattern: &str, icase: bool) -> Result<Self, String> {
		sanitize::compile_pattern(pattern, icase).map(|glob| Self {
			matcher: glob.compile_matcher(),
		})
	}

	fn is_match(&self, name: &str) -> bool {
		self.matcher.is_match(name)
	}
}

/// findGlob 的同步核（对齐 `rg --files --glob --sort=modified --no-ignore --hidden`
/// ⊕ bfs 对位面；order 默认 "bfs" 层障序，"dfs" 保 v1 路径）。
pub fn find_glob_sync(opts: GlobOptions) -> Result<Vec<String>, String> {
	let token = SearchToken::activate(opts.cancel_key.clone(), opts.timeout_ms);
	let root = PathBuf::from(opts.path.clone().unwrap_or_else(|| ".".into()));
	let hidden = opts.hidden.unwrap_or(true);
	// GlobTool 现语义为 --no-ignore → gitignore 默认 false。
	let gitignore = opts.gitignore.unwrap_or(false);
	// 多模式 + `!` 取反 → include ∧ ¬exclude（type 面走 basename 等值，单独过滤）。
	let filter = sanitize::build_glob_filter(opts.pattern.as_deref(), None)?;
	let type_filter = sanitize::resolve_type_filter(opts.r#type.as_deref());
	// -maxdepth 深度界：include 面各模式可达深度的 max（无 include = 不设界）
	// ∧ 用户显式 max_depth（root=0 起算）取交（min）。
	let depth_bound = filter.as_ref().map_or(usize::MAX, GlobFilter::depth_bound);
	let depth_bound = opts
		.max_depth
		.map_or(depth_bound, |d| u64::from(d).min(depth_bound as u64) as usize);
	let max_depth = u64::try_from(depth_bound).unwrap_or(u64::MAX);

	let max_results = opts.max_results.map_or(usize::MAX, |n| n as usize);
	let offset = opts.offset.unwrap_or(0) as usize;
	let sort_by_mtime = opts.sort_by_mtime.unwrap_or(false);

	// v2 bfs 对位面：bfs_name/-iname、min_depth、follow、order（全缺省 =
	// bfs 序 + -P 等位；排序/截断面的旧行为不变）。
	let name_matcher = opts
		.bfs_name
		.as_deref()
		.map(|pattern| NameMatcher::new(pattern, opts.bfs_icase.unwrap_or(false)))
		.transpose()?;
	let min_depth = u64::from(opts.min_depth.unwrap_or(0));
	let follow = bfswalk::SymlinkPolicy::parse(opts.follow.as_deref());
	let order_dfs = opts
		.order
		.as_deref()
		.is_some_and(|value| value.trim().eq_ignore_ascii_case("dfs"));

	let hits = if order_dfs {
		dfs_collect(
			&root,
			hidden,
			gitignore,
			&token,
			filter.as_ref(),
			type_filter.as_ref(),
			depth_bound,
			sort_by_mtime,
			min_depth,
			name_matcher.as_ref(),
		)
	} else {
		bfs_collect(
			&root,
			hidden,
			gitignore,
			&token,
			filter.as_ref(),
			type_filter.as_ref(),
			max_depth,
			sort_by_mtime,
			min_depth,
			follow,
			name_matcher.as_ref(),
		)
	};

	// 取消（显式 searchCancel / timeout）→ 空返回：与 v1 Quit 收敛面一致
	// （timeout=0 契约测试以「取消后不得产出任何结果」钉死 here）。
	let out = if token.cancelled() { Vec::new() } else { hits };
	let out: Vec<String> = out
		.into_iter()
		.map(|(_, path)| path)
		.skip(offset)
		.take(max_results)
		.collect();
	token.deactivate();
	Ok(out)
}

/// bfs 通路（v2 默认）：bfswalk 层障序；emit 面 = 常规文件；sort_by_mtime
/// 在 emit 序之后照旧（无 sort 则保留 BFS 序）。
#[allow(clippy::too_many_arguments)]
fn bfs_collect(
	root: &Path,
	hidden: bool,
	gitignore: bool,
	token: &SearchToken,
	filter: Option<&GlobFilter>,
	type_filter: Option<&TypeFilter>,
	max_depth: u64,
	sort_by_mtime: bool,
	min_depth: u64,
	follow: bfswalk::SymlinkPolicy,
	name_matcher: Option<&NameMatcher>,
) -> Vec<(SystemTime, String)> {
	let threads = std::thread::available_parallelism()
		.map(|n| n.get())
		.unwrap_or(4)
		.min(FIND_MAX_WORKERS);
	let config = bfswalk::WalkConfig {
		hidden,
		gitignore,
		follow,
		// u64::MAX = GlobFilter 不设界的折算值 → None（bfs 无 maxdepth）。
		max_depth: (max_depth != u64::MAX).then_some(max_depth),
		min_depth,
		workers: threads,
		token: token.clone(),
	};
	let mut hits: Vec<(SystemTime, String)> = Vec::new();
	bfswalk::bfs_walk(root, &config, &mut |entry| {
		if token.cancelled() {
			return false;
		}
		let path = entry.path;
		// rg 语义：glob/type 对 root 相对路径匹配（strip 失败召回整路径）。
		let relative = path.strip_prefix(root).unwrap_or(path);
		let relative_str = relative.to_string_lossy();
		if let Some(filter) = filter
			&& !filter.is_match(&relative_str)
			&& !filter.is_match(&path.to_string_lossy())
		{
			return true;
		}
		// emit 面 = 常规文件（rg --files 语义）：-P 下 symlink 报 l 不出；
		// -L 解链为 f 才出（对位 bfs `-type f` eval.c:979）。
		if entry.kind != bfswalk::BfsKind::File {
			return true;
		}
		if let Some(type_filter) = type_filter
			&& !sanitize::matches_type_filter(&relative_str, type_filter)
		{
			return true;
		}
		// bfs -i?name：basename fnmatch（eval.c:627；root 尾斜杠由
		// Path::file_name 收口）。
		if let Some(matcher) = name_matcher {
			let base = path
				.file_name()
				.unwrap_or_else(|| OsStr::new(relative_str.as_ref()))
				.to_string_lossy();
			if !matcher.is_match(&base) {
				return true;
			}
		}
		hits.push((entry.mtime, path.display().to_string()));
		true
	});
	if sort_by_mtime {
		// oldest-first + 路径 tie（全序）；bfs emit 序作为排序前的输入序。
		hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
	}
	hits
}

/// dfs 通路（v1 现路径原样保留，仅增 min_depth/bfs_name 两个 emit 门）。
#[allow(clippy::too_many_arguments)]
fn dfs_collect(
	root: &Path,
	hidden: bool,
	gitignore: bool,
	token: &SearchToken,
	filter: Option<&GlobFilter>,
	type_filter: Option<&TypeFilter>,
	depth_bound: usize,
	sort_by_mtime: bool,
	min_depth: u64,
	name_matcher: Option<&NameMatcher>,
) -> Vec<(SystemTime, String)> {
	let threads = std::thread::available_parallelism()
		.map(|n| n.get())
		.unwrap_or(4)
		.min(FIND_MAX_WORKERS);
	let walker = crate::walk::build_find_walker(
		root.to_path_buf(),
		hidden,
		gitignore,
		threads,
		(depth_bound != usize::MAX).then_some(depth_bound),
	);

	let hits: Mutex<Vec<(SystemTime, String)>> = Mutex::new(Vec::new());
	walker.run(|| {
		Box::new(|entry| {
			if token.cancelled() {
				return WalkState::Quit;
			}
			let Ok(entry) = entry else { return WalkState::Continue };
			if !entry.file_type().is_some_and(|t| t.is_file()) {
				return WalkState::Continue;
			}
			// -mindepth 对位（walkdir 的 root=0 与 bfs depth 同基）。
			if u64::try_from(entry.depth()).unwrap_or(u64::MAX) < min_depth {
				return WalkState::Continue;
			}
			let path = entry.path();
			// rg 语义：glob/type 对 root 相对路径匹配（strip 失败召回整路径）。
			let relative = path.strip_prefix(root).unwrap_or(path);
			let relative_str = relative.to_string_lossy();
			if let Some(filter) = filter
				&& !filter.is_match(&relative_str)
				&& !filter.is_match(&path.to_string_lossy())
			{
				return WalkState::Continue;
			}
			if let Some(type_filter) = type_filter
				&& !sanitize::matches_type_filter(&relative_str, type_filter)
			{
				return WalkState::Continue;
			}
			if let Some(matcher) = name_matcher {
				let base = path
					.file_name()
					.unwrap_or_else(|| OsStr::new(relative_str.as_ref()))
					.to_string_lossy();
				if !matcher.is_match(&base) {
					return WalkState::Continue;
				}
			}
			// mtime 仅排序需要（无 sort 面省一次 stat——并行下 stat 是主导成本）。
			let mtime = if sort_by_mtime {
				entry
					.metadata()
					.ok()
					.and_then(|meta| meta.modified().ok())
					.unwrap_or(SystemTime::UNIX_EPOCH)
			} else {
				SystemTime::UNIX_EPOCH
			};
			// Mutex 中毒恢复面（与 grep.rs PassState 一致）：worker panic 后
			// 既有产物照收（into_inner），不静默丢结果。
			let mut vec = hits.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
			vec.push((mtime, path.display().to_string()));
			WalkState::Continue
		})
	});

	let mut hits = hits.into_inner().unwrap_or_default();
	// sort_by_mtime：oldest-first + 路径 tie（全序）；否则路径字典序（确定序
	// 兜底，v1 dfs 语义原样）。
	if sort_by_mtime {
		hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
	} else {
		hits.sort_by(|a, b| a.1.cmp(&b.1));
	}
	hits
}

#[cfg(test)]
#[path = "find_tests.rs"]
mod find_tests;
