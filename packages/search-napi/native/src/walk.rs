//! 遍历层 — ignore::Walk 序贯 + ignore::WalkParallel 并行双面（bfs 语义的进程内等位）。
//!
//! grep 侧消费矩阵：
//! - 候选预采集 → `build_walker`（路径可排序，供两遍扫描/序贯/窗口模式）；
//! - 融合 walk+search 全并行 → `build_walk_parallel`（thread_local Searcher 缓存）。

use std::path::PathBuf;

/// 统一构建序贯遍历器：hidden/gitignore 两开关（对齐 GrepTool --hidden 与
/// GlobTool --no-ignore 两个既有语义面）。
pub fn build_walker(
	root: PathBuf,
	hidden: bool,
	gitignore: bool,
) -> ignore::Walk {
	build_walker_depth(root, hidden, gitignore, None)
}

/// 同 [`build_walker`]，附加可选遍历深度界（bfs -maxdepth 等位；WalkBuilder
/// max_depth：root=0 起算，超界目录整棵剪枝）。`None` = 不设界。
pub fn build_walker_depth(
	root: PathBuf,
	hidden: bool,
	gitignore: bool,
	max_depth: Option<usize>,
) -> ignore::Walk {
	ignore::WalkBuilder::new(root)
		.hidden(!hidden)
		.git_ignore(gitignore)
		.git_global(gitignore)
		.ignore(gitignore)
		.parents(gitignore)
		.require_git(false)
		.max_depth(max_depth)
		.build()
}

/// 并行遍历器：walker 自身并行 DFS，grep 在 visitor 内做 walk+search 融合。
/// 不移植 pi-walker，线程数由调用方按 available_parallelism 自适应。
pub fn build_walk_parallel(
	root: PathBuf,
	hidden: bool,
	gitignore: bool,
	threads: usize,
) -> ignore::WalkParallel {
	ignore::WalkBuilder::new(root)
		.hidden(!hidden)
		.git_ignore(gitignore)
		.git_global(gitignore)
		.ignore(gitignore)
		.parents(gitignore)
		.require_git(false)
		.follow_links(false)
		.threads(threads.max(1))
		.build_parallel()
}
