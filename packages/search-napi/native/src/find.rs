//! find/glob 模块 — bfs 语义的进程内等位（对齐 GlobTool 消费面
//! `rg --files --glob --sort=modified --no-ignore --hidden` + argv0 find 子集）。
//!
//! 语义锚（v1 收口）：
//! - pattern：逗号多模式；`!` 前缀取反 = 排除（sanitize::GlobFilter 的
//!   include ∧ ¬exclude；无 include 全收）；归一走 sanitize::build_glob_pattern
//!   （`**/` 自动前缀 / 花括号补全 / 反斜杠归一）；
//! - sort_by_mtime：**oldest-first**（对齐 rg --sort=modified；mtime 并列按
//!   路径字典序；先全收、后排序、再 skip(offset).take(max_results)——
//!   结果与「全收+排序+截断」严格一致，无提前 break）；
//! - type 过滤：sanitize::resolve_type_filter + matches_type_filter（basename
//!   扩展名/文件名等值，rg --type 语义）；目录/文件区分由 glob 匹配自然给出；
//! - hidden 默认 true、gitignore 默认 false（GlobTool --no-ignore 语义）；
//! - 深度界：GlobFilter::depth_bound → WalkBuilder max_depth 剪枝；
//! - 取消/超时：SearchToken 每 entry 检查（超时不拖死，取消截断即返回）。

use std::path::PathBuf;
use std::time::SystemTime;

use crate::heart::SearchToken;
use crate::sanitize::{self, GlobFilter};
use crate::types::GlobOptions;

/// findGlob 的同步核（对齐 `rg --files --glob --sort=modified --no-ignore --hidden`）。
pub fn find_glob_sync(opts: GlobOptions) -> Result<Vec<String>, String> {
	let token = SearchToken::activate(opts.timeout_ms);
	let root = PathBuf::from(opts.path.clone().unwrap_or_else(|| ".".into()));
	let hidden = opts.hidden.unwrap_or(true);
	// GlobTool 现语义为 --no-ignore → gitignore 默认 false。
	let gitignore = opts.gitignore.unwrap_or(false);
	// 多模式 + `!` 取反 → include ∧ ¬exclude（type 面走 basename 等值，单独过滤）。
	let filter = sanitize::build_glob_filter(opts.pattern.as_deref(), None)?;
	let type_filter = sanitize::resolve_type_filter(opts.r#type.as_deref());
	// -maxdepth 深度界：include 面各模式可达深度的 max（无 include = 不设界）。
	let depth_bound = filter.as_ref().map_or(usize::MAX, GlobFilter::depth_bound);

	let max_results = opts.max_results.map_or(usize::MAX, |n| n as usize);
	let offset = opts.offset.unwrap_or(0) as usize;

	let walker = crate::walk::build_walker_depth(
		root.clone(),
		hidden,
		gitignore,
		(depth_bound != usize::MAX).then_some(depth_bound),
	);
	let mut hits: Vec<(SystemTime, String)> = Vec::new();
	for entry in walker {
		if token.cancelled() {
			break;
		}
		let Ok(entry) = entry else { continue };
		if entry.depth() > depth_bound {
			continue;
		}
		if !entry.file_type().is_some_and(|t| t.is_file()) {
			continue;
		}
		let path = entry.path();
		// rg 语义：glob/type 对 root 相对路径匹配（strip 失败召回整路径）。
		let relative = path.strip_prefix(&root).unwrap_or(path);
		let relative_str = relative.to_string_lossy();
		if let Some(filter) = &filter {
			if !filter.is_match(&relative_str) && !filter.is_match(&path.to_string_lossy()) {
				continue;
			}
		}
		if let Some(type_filter) = &type_filter {
			if !sanitize::matches_type_filter(&relative_str, type_filter) {
				continue;
			}
		}
		let mtime = entry
			.metadata()
			.ok()
			.and_then(|meta| meta.modified().ok())
			.unwrap_or(SystemTime::UNIX_EPOCH);
		hits.push((mtime, path.display().to_string()));
	}

	if opts.sort_by_mtime.unwrap_or(false) {
		// rg --sort=modified：oldest-first；mtime 并列 tie=路径字典序（稳定的全序）。
		hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
	}
	let out: Vec<String> = hits
		.into_iter()
		.map(|(_, path)| path)
		.skip(offset)
		.take(max_results)
		.collect();
	token.deactivate();
	Ok(out)
}

#[cfg(test)]
#[path = "find_tests.rs"]
mod find_tests;
