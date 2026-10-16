//! 跨平台行为与速度预期测试（用户拍板的第二护栏面）。
//!
//! 三类断言按平台差异门控：
//! - **内容比较**：路径断言一律 basename/相对路径比较（分隔符归一），平台
//!   字面量不进断言；
//! - **能力探针门控**：符号链创建（win 需特权/开发者模式）与大小写敏感
//!   文件系（win/mac 常为 insensitive）先探测再跑对应行为组；
//! - **速度护栏**：合成树上的宽上界（只抓单线程化/fs 风暴类病态回归），
//!   实测耗时打 stderr 供人眼对照——阈本身就是契约。


	use std::fs;
	use std::path::{Path, PathBuf};
	use std::sync::atomic::{AtomicU64, Ordering};
	use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

	use crate::find::find_glob_sync;
	use crate::grep::grep_search_sync;
	use crate::types::{GlobOptions, GrepOptions, GrepOutputMode};

	/// find_tests 同款自铸临时目录守卫（crate 无 tempfile 依赖面）。
	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map(|d| d.as_nanos())
				.unwrap_or(0);
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let pid = std::process::id();
			let path = std::env::temp_dir().join(format!(
				"search-napi-platform-test-{pid}-{nanos}-{seq}"
			));
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

	/// 归一路径为 'a/b/c' 形态（平台分隔符差异不进断言）。
	fn norm(p: &str) -> String {
		p.replace('\\', "/")
	}

	fn unique_cancel_key() -> String {
		format!(
			"platform-tests-{}",
			SystemTime::now()
				.duration_since(SystemTime::UNIX_EPOCH)
				.map(|d| d.as_nanos())
				.unwrap_or(0)
		)
	}

	fn glob(pattern: &str, path: &str) -> Vec<String> {
		find_glob_sync(GlobOptions {
			pattern: Some(pattern.into()),
			path: Some(path.into()),
			r#type: None,
			hidden: Some(true),
			gitignore: None,
			sort_by_mtime: None,
			max_results: None,
			offset: None,
			timeout_ms: None,
			cancel_key: Some(unique_cancel_key()),
			bfs_name: None,
			bfs_icase: None,
			min_depth: None,
			max_depth: None,
			follow: None,
			order: None,
		})
		.expect("findGlob ok")
	}

	fn grep_count(pattern: &str, path: &str) -> usize {
		let result = grep_search_sync(GrepOptions {
			pattern: pattern.into(),
			path: Some(path.into()),
			glob: None,
			r#type: None,
			ignore_case: Some(true),
			multiline: None,
			hidden: Some(true),
			gitignore: Some(false),
			max_count: None,
			offset: None,
			context_before: None,
			context_after: None,
			max_columns: None,
			only_matching: None,
			files_without_match: None,
			binary_skip: None,
			mode: Some(GrepOutputMode::Count),
			timeout_ms: Some(60_000),
			cancel_key: None,
		})
		.expect("grepSearch ok");
		result
			.matches
			.iter()
			.filter_map(|m| m.line.parse::<usize>().ok())
			.sum()
	}

	/// 探针：当前环境能否创建 symlink（win 常需开发者模式/特权）。
	fn can_create_symlink(dir: &std::path::Path) -> bool {
		let target = dir.join(".__probe_target");
		let link = dir.join(".__probe_link");
		fs::write(&target, b"p").is_ok()
			&& {
				#[cfg(target_family = "unix")]
				{
					std::os::unix::fs::symlink(&target, &link).is_ok()
				}
				#[cfg(target_family = "windows")]
				{
					std::os::windows::fs::symlink_file(&target, &link).is_ok()
				}
				#[cfg(not(any(target_family = "unix", target_family = "windows")))]
				{
					false
				}
			}
	}

	/// 探针：文件系是否大小写敏感（win/mac 常为 insensitive）。
	fn case_sensitive_fs(dir: &std::path::Path) -> bool {
		let a = dir.join(".__case_probe");
		fs::write(&a, b"x").is_ok() && !dir.join(".__CASE_PROBE").exists()
	}

	/// 合成树：3 层、20 目录、每叶 130 文件（做速度护栏的固定地形）。
	fn build_tree(root: &std::path::Path, files_per_leaf: usize) -> usize {
		let mut total = 0usize;
		for group in 0..5usize {
			for branch in 0..4usize {
				let leaf_pair = root
					.join(format!("g{group}"))
					.join(format!("b{branch}"));
				for leaf in 0..2usize {
					let dir = leaf_pair.join(format!("l{leaf}"));
					fs::create_dir_all(&dir).expect("mk leaf");
					for f in 0..files_per_leaf {
						fs::write(
							dir.join(format!("data_{f:04}.txt")),
							format!("needle line {f}\nfiller {group}-{branch}-{leaf}\n"),
						)
						.expect("write leaf");
						total += 1;
					}
				}
			}
		}
		total
	}

	// ── 行为面（各平台语义等值） ────────────────────────────────────

	#[test]
	fn full_tree_walk_content_matches_across_platforms() {
		let root = TempDirGuard::new();
		let expected = build_tree(root.path(), 3);
		let hits = glob("**/*.txt", root.path().to_str().unwrap());
		assert_eq!(hits.len(), expected, "walk 全收全出（含目录语义边界）");
		// 内容比较：basename 集合 + 相对结构（分隔符归一）任抽一组
		let rels: Vec<String> = hits
			.iter()
			.map(|h| norm(h).split_once("g0/").map(|(_, r)| r).unwrap_or("").into())
			.filter(|r: &String| !r.is_empty())
			.collect();
		assert!(rels.contains(&"b0/l0/data_0000.txt".into()));
		assert!(rels.iter().all(|r| !r.contains('\\')), "归一后无反斜杠");
	}

	#[test]
	fn hidden_dotfile_gate_semantics() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("visible.txt"), b"v").unwrap();
		fs::write(root.path().join(".concealed.txt"), b"h").unwrap();
		let all = glob("**/*.txt", root.path().to_str().unwrap());
		assert_eq!(all.len(), 2, "hidden=true 收点文件");
		let basenames: Vec<String> = all.iter().map(|h| {
			norm(h).rsplit('/').next().unwrap_or("").into()
		}).collect();
		assert!(basenames.contains(&".concealed.txt".into()));
	}

	#[test]
	fn gitignore_chain_windows_newline() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join("sub")).unwrap();
		// CRLF 写法——windows 编辑器常态；规则面须等值
		fs::write(root.path().join(".gitignore"), b"ignored*\r\n").unwrap();
		fs::write(root.path().join("kept.txt"), b"k").unwrap();
		fs::write(root.path().join("ignored.txt"), b"i").unwrap();
		fs::create_dir(root.path().join(".git")).unwrap();
		let opts = |gitignore: bool| find_glob_sync(GlobOptions {
			pattern: Some("**/*.txt".into()),
			path: Some(root.path().to_str().unwrap().into()),
			r#type: None,
			hidden: Some(true),
			gitignore: Some(gitignore),
			sort_by_mtime: None,
			max_results: None,
			offset: None,
			timeout_ms: None,
			cancel_key: Some(unique_cancel_key()),
			bfs_name: None,
			bfs_icase: None,
			min_depth: None,
			max_depth: None,
			follow: None,
			order: None,
		});
		assert_eq!(opts(true).unwrap().len(), 1, "CRLF 规则生效");
		assert_eq!(opts(false).unwrap().len(), 2, "--no-ignore 全收");
	}

	#[test]
	fn symlink_semantics_when_permitted() {
		// 能力探针：win 无开发者模式时跳过（行为组由 -L 测试组平台覆盖）
		let root = TempDirGuard::new();
		if !can_create_symlink(root.path()) {
			eprintln!("[platform_tests] symlink 不可用——跳过（能力门控）");
			return;
		}
		fs::create_dir_all(root.path().join("real")).unwrap();
		fs::write(root.path().join("real/f.txt"), b"needle").unwrap();
		#[cfg(target_family = "unix")]
		{
			std::os::unix::fs::symlink(
				root.path().join("real"),
				root.path().join("alias"),
			)
			.unwrap();
		}
		#[cfg(target_family = "windows")]
		{
			std::os::windows::fs::symlink_dir(
				root.path().join("real"),
				root.path().join("alias"),
			)
			.unwrap();
		}
		// -P：alias 不入深（只报 symlink 自身）；-L：跟随入深
		let p = find_glob_sync(GlobOptions {
			pattern: Some("**".into()),
			path: Some(root.path().to_str().unwrap().into()),
			r#type: None,
			hidden: Some(true),
			gitignore: None,
			sort_by_mtime: None,
			max_results: None,
			offset: None,
			timeout_ms: None,
			cancel_key: Some(unique_cancel_key()),
			bfs_name: None,
			bfs_icase: None,
			min_depth: None,
			max_depth: None,
			follow: Some("P".into()),
			order: None,
		})
		.unwrap();
		assert!(
			!p.iter().map(|s| norm(s)).any(|s| s.ends_with("alias/f.txt")),
			"-P 不跟 alias"
		);
		let l = find_glob_sync(GlobOptions {
			pattern: Some("**".into()),
			path: Some(root.path().to_str().unwrap().into()),
			r#type: None,
			hidden: Some(true),
			gitignore: None,
			sort_by_mtime: None,
			max_results: None,
			offset: None,
			timeout_ms: None,
			cancel_key: Some(unique_cancel_key()),
			bfs_name: None,
			bfs_icase: None,
			min_depth: None,
			max_depth: None,
			follow: Some("L".into()),
			order: None,
		})
		.unwrap();
		assert!(
			l.iter().map(|s| norm(s)).any(|s| s.ends_with("alias/f.txt")),
			"-L 跟随入深"
		);
	}


	#[test]
	fn case_gate_semantics_on_probe_result() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("Only.txt"), b"x").expect("write case probe");
		let base = root.path().to_str().unwrap();
		if case_sensitive_fs(root.path()) {
			// 敏感面：仅精确大小写命中
			assert_eq!(glob("**/Only.txt", base).len(), 1);
			assert_eq!(glob("**/only.txt", base).len(), 0);
			eprintln!("[platform_tests] 大小写敏感文件系——精确门断言通过");
		} else {
			// 不敏感面：小写写法命中同一文件（库不得自作聪明去重报 2）
			assert!(!glob("**/only.txt", base).is_empty());
			eprintln!("[platform_tests] 大小写不敏感文件系——等值门断言通过");
		}
	}

	// ── 速度护栏（宽上界 = 契约；实测打 stderr） ───────────────────

	#[test]
	fn walk_speed_guardrail_synthetic_tree() {
		let root = TempDirGuard::new();
		let files = build_tree(root.path(), 130);
		assert_eq!(files, 5200);
		let t0 = Instant::now();
		let hits = glob("**/*.txt", root.path().to_str().unwrap());
		let elapsed = t0.elapsed();
		eprintln!(
			"[platform_tests] walk {files} files in {:.1?}（护栏 120s）",
			elapsed
		);
		assert_eq!(hits.len(), files);
		assert!(
			elapsed < Duration::from_secs(120),
			"全树行走超 120s——病态回归（单线程化/fs 风暴类）"
		);
	}

	#[test]
	fn grep_count_speed_guardrail_synthetic_tree() {
		let root = TempDirGuard::new();
		build_tree(root.path(), 130);
		let t0 = Instant::now();
		let total = grep_count("needle", root.path().to_str().unwrap());
		let elapsed = t0.elapsed();
		eprintln!(
			"[platform_tests] grep count 5200 files in {:.1?}（护栏 60s）",
			elapsed
		);
		assert_eq!(total, 5200, "每文件 1 命中");
		assert!(
			elapsed < Duration::from_secs(60),
			"count 超 60s——流式引擎病态回归"
		);
	}
