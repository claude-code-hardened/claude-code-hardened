//! bfswalk — bfs 的 bftw 走器语义在 Rust 的忠实对位（v2 实装）。
//!
//! 蓝本：vendor/search-kit/upstream/bfs/src/{bftw.c,eval.c}：
//! - **breadth-first 招牌序**（bfs 之名的来历）：按深度层推进、层障全收后
//!   统一回排，emit 全序 = (depth, 父目录序, 目录内名序)——与单线程 BFS
//!   （bftw 的 DirQueue 单队列模型）逐字同序；bftw 多 worker（ioq/
//!   BatchQueue）的输出非确定性被层障+回排抹平；
//! - 符号链三策略（bftw.c:1413-1422 `bftw_stat_flags`：只有 depth==0 叠
//!   BFTW_FOLLOW_ROOTS）：`-P` 从不跟随（symlink 报 type=l）；`-L` 全跟随
//!   （报解链后的目标类型 + 入深）；`-H` 仅根路径本身跟随；
//! - **环防护**（bftw.c:1746 `BFTW_DETECT_CYCLES` 的 (dev,ino) 祖先比对的
//!   全局化简化）：-L 下目录 inode 访问集——已进过一次队列的真实目录不再
//!   二次下潜（环与同目录 alias 两条语义同一由本集吸收）；
//! - -maxdepth/-mindepth（eval.c:1512-1526 按行确认）：`depth >= max` 对
//!   目录是 PRUNE（不下潜），而 emit 条件是 `mindepth <= depth <= maxdepth`
//!   ⇒ **边界层目录本身照样输出、但不再下潜**；mindepth 只挡 emit 不挡
//!   下潜（剪枝面只有 maxdepth）；
//! - 每 entry 一次 stat 判型（-P 走 lstat / -L 走 stat）+ 层内并行展开
//!   （std::thread::scope 切片 worker，钳 16）+ gitignore 分层链（每目录
//!   编译本地 .gitignore，查询 innermost→outermost 首个非 None 判定生效）；
//!   节点只在 gitignore 启用且根目录为 git 仓库（require_git：根层一次
//!   `.git` 存在性探测）时构建——非 git 目录整树不走忽略面。

use std::collections::HashSet;
use std::fs;
#[cfg(target_family = "unix")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_family = "windows")]
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use ignore::gitignore::Gitignore;

use crate::heart::SearchToken;

/// (设备, 索引节点) 键：-L 环防护 / alias 去重的真实身份对。
/// unix 走 dev/ino；windows 用 volume_serial+file_index 同语义对位；
/// 其余平台无此 API——返回 None（环防护降级为不设防，仅 bfs 侧容差面）。
#[cfg(target_family = "unix")]
fn inode_pair(meta: &fs::Metadata) -> Option<(u64, u64)> {
	Some((meta.dev(), meta.ino()))
}

#[cfg(target_family = "windows")]
fn inode_pair(meta: &fs::Metadata) -> Option<(u64, u64)> {
	Some((meta.volume_serial_number(), meta.file_index()))
}

#[cfg(not(any(target_family = "unix", target_family = "windows")))]
fn inode_pair(_meta: &fs::Metadata) -> Option<(u64, u64)> {
	None
}

/// 并行 worker 上限（与 find/grep 同钳制口径）。
pub(crate) const BFS_MAX_WORKERS: usize = 16;

/// 符号链策略（find/bfs -P/-L/-H 语义）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SymlinkPolicy {
	/// 从不跟随（symlink 报 type=l，不入深）。默认。
	P,
	/// 全跟随（symlink 报解链后的目标类型 + 入深；inode 访问集防环）。
	L,
	/// 仅命令行根路径本身跟随（depth 0；更深层级回落 -P）。
	H,
}

impl SymlinkPolicy {
	/// "P"|"L"|"H"（大小写不敏感、容忍首尾空白）；缺省/非法值 → "P"。
	pub fn parse(value: Option<&str>) -> Self {
		match value
			.map(str::trim)
			.map(str::to_ascii_uppercase)
			.as_deref()
		{
			Some("L") => Self::L,
			Some("H") => Self::H,
			_ => Self::P,
		}
	}
}

/// bfs type 面（eval.c:979 `-type` 字母语义子集）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BfsKind {
	/// -type f：常规文件（find emit 面；-L 下 symlink 解链为 f 亦归此）。
	File,
	/// -type d：目录（下潜面）。
	Dir,
	/// -type l：未跟随的符号链（-P 恒报此；-L 下断链亦报此）。
	Symlink,
	/// 其余（fifo/socket/设备/…）。
	Other,
}

/// 被访问 entry（对位 bfs BFTW 结构子集；path 由层缓冲持有，callback 内借用）。
pub struct BfsEntry<'a> {
	pub path: &'a Path,
	/// 层深（root=0 起算）：find emit 面不消费（深度门已由走器收口），
	/// bfswalk 直采测试与诊断用。
	#[allow(dead_code)]
	pub depth: u64,
	pub kind: BfsKind,
	/// 排序面用 mtime（find 只对 f 消费）。
	pub mtime: SystemTime,
}

/// gitignore 链节点：本目录 `.gitignore` 的编译产物 + 外层（parent）链。
struct GiLink {
	gi: Gitignore,
	parent: Option<Arc<GiLink>>,
}

/// BFS 走器配置（find 面组装；字段全 pub 供测试直接构造）。
pub struct WalkConfig {
	/// true = 包含隐藏条目（GlobTool --hidden 默认开）；false 时跳过 `.` 开头
	/// 条目（且不进其子树）。
	pub hidden: bool,
	/// true = 启用分层 .gitignore 链（节点只在启用时构建）。
	pub gitignore: bool,
	pub follow: SymlinkPolicy,
	/// 目录不下潜的界（emit 门为其闭包——eval.c:1512-1526 语义）。
	pub max_depth: Option<u64>,
	/// emit 下界（< min 不出、照常下潜）。
	pub min_depth: u64,
	/// 层内并行 worker 数（钳 [1,16]）。
	pub workers: usize,
	/// 准时/显式取消令牌：每层、每目录、层回排前各查一次。
	pub token: SearchToken,
}

/// 待展开目录队列项（tier 层障内的一个父目录）。
struct Dir {
	path: PathBuf,
	/// 父目录在本层内的序（层内确定性键之一）。
	seq: u64,
	/// 本目录 .gitignore 节点起链（仅 gitignore 启用时有节点）。
	chain: Option<Arc<GiLink>>,
}

/// 层采集行：emit + 下潜两个消费面共用的全信息。
struct Row {
	/// (depth, parent_seq, name) 回排键的后两位。
	parent_seq: u64,
	name: String,
	path: PathBuf,
	kind: BfsKind,
	mtime: SystemTime,
	/// -L 下 Dir 的目标 (dev, ino)：环防 / alias 去重键。
	dir_key: Option<(u64, u64)>,
	/// 父目录链（排阶段给子目录叠本地节点用）。
	chain: Option<Arc<GiLink>>,
}

#[derive(Default)]
struct TierOut {
	rows: Vec<Row>,
}

/// BFS 遍历主入口：visit 回调对每个 entry（root/文件/目录/符号链）按
/// (depth, 父序, 名序) 全序调用；返回 false = 提前终止。root 不存在则静默
/// 返回（对位 v1 ignore walker 的 error-entry 面：find 侧等价空输出）。
pub fn bfs_walk(root: &Path, config: &WalkConfig, visit: &mut dyn FnMut(&BfsEntry<'_>) -> bool) {
	if config.token.cancelled() {
		return;
	}
	let Ok(lmeta) = fs::symlink_metadata(root) else {
		return;
	};
	let root_is_symlink = lmeta.file_type().is_symlink();
	// bftw.c:1413-1422：depth==0 才叠 BFTW_FOLLOW_ROOTS ⇒ -P 根不跟随；
	// -L/-H 根跟随（-H 在更深层级回落 -P，见 expand_dir 的跟随判定面）。
	let follow_root = matches!(config.follow, SymlinkPolicy::L | SymlinkPolicy::H);
	let followed_meta = if follow_root {
		fs::metadata(root).ok()
	} else {
		None
	};
	let root_meta = followed_meta.as_ref().unwrap_or(&lmeta);
	// 根为 symlink：解链成功 → 报目标类型；断链 → 报 l（TRYFOLLOW 语义）。
	let kind = if root_is_symlink && followed_meta.is_none() {
		BfsKind::Symlink
	} else {
		classify(root_meta, false)
	};

	let mtime = root_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
	let mut visited: HashSet<(u64, u64)> = HashSet::new();
	if kind == BfsKind::Dir && config.follow == SymlinkPolicy::L {
		// -L 环防起手：根（解链后的真实 inode）先入访问集。
		if let Some(key) = inode_pair(root_meta) {
			visited.insert(key);
		}
	}
	if depth_in_range(0, config) && !visit(&BfsEntry { path: root, depth: 0, kind, mtime }) {
		return;
	}
	if kind != BfsKind::Dir {
		return;
	}

	// rg/require_git 语义：非 git 目录不应用 .gitignore——根层一次
	// `.git` 存在性探测（Dir 存在即记为 git 仓库；一层缓存，树内不再查），
	// 链面（Gitignore::matched）仅在 git 目录生效。
	let git_active = config.gitignore && root.join(".git").symlink_metadata().is_ok();
	let root_chain = if git_active { gitignore_node(root, None) } else { None };
	let tier = vec![Dir {
		path: root.to_path_buf(),
		seq: 0,
		chain: root_chain,
	}];
	run_tiers(tier, config, visited, 0, visit);
}

/// emit 门 = [min_depth, max_depth]（eval.c:1518-1526）。
fn depth_in_range(depth: u64, config: &WalkConfig) -> bool {
	depth >= config.min_depth && config.max_depth.is_none_or(|max| depth <= max)
}

/// 层障推进主体：展开（并行）→ 回排（(parent_seq, name)）→ 依序 emit +
/// 界内目录入下层（-L 环防在此收口）。
fn run_tiers(
	mut tier: Vec<Dir>,
	config: &WalkConfig,
	mut visited: HashSet<(u64, u64)>,
	mut parent_depth: u64,
	visit: &mut dyn FnMut(&BfsEntry<'_>) -> bool,
) {
	while !tier.is_empty() {
		if config.token.cancelled() {
			return;
		}
		let mut rows = expand_tier(&tier, config);
		if config.token.cancelled() {
			return;
		}
		// 层内确定序：父目录序 → 目录内名序（bftw 单队列 FIFO 的确定性回排）。
		rows.sort_unstable_by(|a, b| {
			a.parent_seq
				.cmp(&b.parent_seq)
				.then_with(|| a.name.cmp(&b.name))
		});
		let mut next: Vec<Dir> = Vec::new();
		let mut child_seq = 0u64;
		for row in &rows {
			let depth = parent_depth + 1;
			if depth_in_range(depth, config)
				&& !visit(&BfsEntry {
					path: &row.path,
					depth,
					kind: row.kind,
					mtime: row.mtime,
				})
			{
				return;
			}
			// 下潜门：目录且 depth < max（eval.c:1512——边界层目录只输出
			// 不下潜；>max 的行不可能出现：父层入队时已剪）。
			if row.kind == BfsKind::Dir && config.max_depth.is_none_or(|max| depth < max) {
				// bftw.c:1746 环防的全局化：-L 下目标目录 inode 已访问
				// ⇒ 不再下潜（环/alias 同一由集吸收）。
				if let Some(key) = row.dir_key {
					if !visited.insert(key) {
						continue;
					}
				}
				// 子目录本地 .gitignore 节点只在 git 链已激活（根 .git 探测
				// 命中）时叠加——非 git 目录整树不走忽略面（require_git）。
				let chain = if config.gitignore && row.chain.is_some() {
					gitignore_node(&row.path, row.chain.clone())
				} else {
					row.chain.clone()
				};
				next.push(Dir {
					path: row.path.clone(),
					seq: child_seq,
					chain,
				});
				child_seq += 1;
			}
		}
		tier = next;
		parent_depth += 1;
	}
}

/// 层内并行展开：worker 切片各产局部产物、互不共享，层障后统一收并。
fn expand_tier(tier: &[Dir], config: &WalkConfig) -> Vec<Row> {
	let workers = config.workers.clamp(1, BFS_MAX_WORKERS);
	if tier.len() < 2 || workers <= 1 {
		// 小层/单 worker：免线程开销直跑（取消检查在 expand_dir 内）。
		let mut out = TierOut::default();
		for dir in tier {
			expand_dir(dir, config, &mut out);
		}
		return out.rows;
	}
	let chunk = tier.len().div_ceil(workers);
	let shards = tier.len().div_ceil(chunk);
	let mut outs: Vec<TierOut> = (0..shards).map(|_| TierOut::default()).collect();
	std::thread::scope(|scope| {
		for (out, group) in outs.iter_mut().zip(tier.chunks(chunk)) {
			scope.spawn(move || {
				for dir in group {
					expand_dir(dir, config, out);
				}
			});
		}
	});
	outs.into_iter().flat_map(|out| out.rows).collect()
}

/// 展开一个目录的直系子项：逐项判型 + 门面（hidden/gitignore）过滤，产出
/// 本层行（emit/下潜判定统一留给层障回排阶段）。
fn expand_dir(dir: &Dir, config: &WalkConfig, out: &mut TierOut) {
	let Ok(read_dir) = fs::read_dir(&dir.path) else {
		return;
	};
	for entry in read_dir {
		if config.token.cancelled() {
			return;
		}
		let Ok(entry) = entry else {
			continue;
		};
		let name_os = entry.file_name();
		let name = name_os.to_string_lossy();
		// hidden 面（GlobTool --hidden 默认开；关时跳过 `.·` 开头条目子树）。
		if !config.hidden && name.starts_with('.') {
			continue;
		}
		let path = entry.path();
		let Ok(lmeta) = fs::symlink_metadata(&path) else {
			continue;
		};
		// 跟随判定对位 bftw_stat_flags：-L 全跟（stat 解链）；-P 恒不跟；
		// -H 仅层级 0（已在 bfs_walk 对根收口），这里的层级恒 >= 1 → 不跟。
		let followed = if config.follow == SymlinkPolicy::L {
			fs::metadata(&path).ok()
		} else {
			None
		};
		let kind = match &followed {
			Some(meta) => classify(meta, false),
			// -L 断链 fallback：lstat 成功但目标缺席 → 报 l（TRYFOLLOW
			// 失败语义对位）。
			None => classify(&lmeta, lmeta.is_symlink()),
		};
		// gitignore 链：innermost→outermost 首个非 None 判定生效
		// （Ignore 剔除、Whitelist 保出、None 外探）。
		if config.gitignore && chain_ignored(&dir.chain, &path, kind == BfsKind::Dir) {
			continue;
		}
		let meta_ref = followed.as_ref().unwrap_or(&lmeta);
		let mtime = meta_ref.modified().unwrap_or(SystemTime::UNIX_EPOCH);
		let dir_key = followed
			.as_ref()
			.filter(|_| kind == BfsKind::Dir)
			.and_then(|meta| inode_pair(&meta));
		out.rows.push(Row {
			parent_seq: dir.seq,
			name: name.into_owned(),
			path,
			kind,
			mtime,
			dir_key,
			chain: dir.chain.clone(),
		});
	}
}

/// 元数据 → type 面。
fn classify(meta: &fs::Metadata, as_symlink: bool) -> BfsKind {
	if as_symlink {
		BfsKind::Symlink
	} else if meta.is_dir() {
		BfsKind::Dir
	} else if meta.is_file() {
		BfsKind::File
	} else {
		BfsKind::Other
	}
}

/// 编译目录本地 `.gitignore` 节点并链上外层；无本地文件（或全空）→ 链原样。
fn gitignore_node(dir: &Path, parent: Option<Arc<GiLink>>) -> Option<Arc<GiLink>> {
	let (gi, _err) = Gitignore::new(dir.join(".gitignore"));
	if gi.is_empty() {
		return parent;
	}
	Some(Arc::new(GiLink { gi, parent }))
}

/// 链式查询：innermost→outermost；首个非 None 判定生效（git 语义）。
fn chain_ignored(chain: &Option<Arc<GiLink>>, path: &Path, is_dir: bool) -> bool {
	let mut current = chain.as_deref();
	while let Some(node) = current {
		match node.gi.matched(path, is_dir) {
			ignore::Match::Ignore(_) => return true,
			ignore::Match::Whitelist(_) => return false,
			ignore::Match::None => current = node.parent.as_deref(),
		}
	}
	false
}
