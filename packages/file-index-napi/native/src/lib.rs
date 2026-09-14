//! Native file-path fuzzy search — line-by-line Rust port of
//! `src/native-ts/file-index/index.ts` (nucleo-style fzf-v2 scoring).
//!
//! The TS module is the behavioral baseline (it is the only implementation
//! running in production today). nucleo's builtin scoring does NOT match the
//! TS port (different bonus model, different tie-breaking, no position/rank
//! normalization), so this crate re-implements the TS algorithm exactly
//! instead of wrapping nucleo: same constants, same multi-start indexOf scan,
//! same top-k insertion order, same 1.05x "test" penalty, same top-level
//! entry sort. `scripts/differential.ts` asserts result-for-result equality.
//!
//! UTF-16 fidelity: JS strings are UTF-16. Match positions, gap lengths and
//! boundary bonuses therefore operate on UTF-16 code units — not bytes, not
//! chars. Each path is stored as UTF-16 little-endian byte pairs; needle
//! chars are located with memchr's SIMD memmem over those pairs and odd
//! (straddling) byte hits are rejected, which reproduces
//! `String.prototype.indexOf` exactly. This matters for non-ASCII paths:
//! a CJK char is 1 UTF-16 unit but 3 UTF-8 bytes, so byte-based gaps would
//! shift scores and change result order.
//!
//! napi 3 note: entry methods that can panic under load (`load_from_file_list`
//! / `append_paths` / `search`) return a fully qualified `napi::Result` and
//! are declared `#[napi(catch_unwind)]`, so a Rust panic surfaces as a JS
//! exception instead of unwinding across the FFI boundary. The `napi::Result`
//! type is always written out in full path — never `use napi::Result`: napi
//! 3's `Result<T, S = Status>` is a double-generic alias that shadows
//! `std::result::Result` (see token-counter-napi/native/src/lib.rs). Pure
//! accessors (`path_count` / `free`) keep plain returns — their logic is
//! trivial and cannot panic.
//!
//! Known limitation: case folding uses Rust `str::to_lowercase` while the TS
//! baseline uses `String.prototype.toLowerCase`, and the two disagree on (a)
//! the Unicode SpecialCasing final-sigma rule — JS maps a word-final "Σ" to
//! "ς", Rust always emits "σ" — and (b) the Unicode version each ships with,
//! so the case-insensitive (smart-case) path can judge queries containing
//! Greek or rarely remapped uppercase letters differently from the TS
//! implementation. ASCII, CJK and emoji queries are unaffected.
//!
//! Besides the fuzzy index, this crate also exposes `ccb_scan_files_into`:
//! a pure `extern "C"` (no napi macro) export over the same jwalk (rayon)
//! parallel directory walk that replaces the ripgrep subprocess fallback in
//! `src/hooks/fileSuggestions.ts` for non-git directories. The JS side binds
//! it with bun:ffi `async: true`, so the scan runs on Bun's own thread pool
//! and never blocks the JS event loop; the export itself stays synchronous.

use std::cmp::Ordering;
use std::ffi::{c_char, CStr};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;

use jwalk::WalkDir;
use memchr::memmem;
use napi_derive::napi;
use rustc_hash::FxHashSet;

// Scoring constants — identical to src/native-ts/file-index/index.ts.
const SCORE_MATCH: i64 = 16;
const BONUS_BOUNDARY: i64 = 8;
const BONUS_CAMEL: i64 = 6;
const BONUS_CONSECUTIVE: i64 = 4;
const BONUS_FIRST_CHAR: i64 = 8;
const PENALTY_GAP_START: i64 = 3;
const PENALTY_GAP_EXTENSION: i64 = 1;

const MAX_QUERY_LEN: usize = 64;
const TOP_LEVEL_CACHE_LIMIT: usize = 100;

const NOT_FOUND: usize = usize::MAX;

/// Single search result. Mirrors the TS `SearchResult`: lower score is
/// better, the best match is 0.0; paths containing "test" carry a 1.05x
/// position penalty (capped at 1.0).
#[napi(object)]
pub struct FileSearchResult {
  pub path: String,
  pub score: f64,
}

struct IndexData {
  /// Original paths as UTF-16LE byte pairs (result content + bonus scoring).
  paths: Vec<Vec<u8>>,
  /// Lowercased paths as UTF-16LE byte pairs (case-insensitive haystack).
  lower: Vec<Vec<u8>>,
  /// a-z presence bitmap over the lowercased UTF-16 units.
  char_bits: Vec<u32>,
  /// Lowercased unit length, truncated to u16 like the TS Uint16Array.
  path_lens: Vec<u16>,
  /// Dedupe set over original path strings (JS `Set<string>` semantics).
  seen: FxHashSet<String>,
  /// First <=100 unique top-level segments (UTF-16LE), in path order.
  top_level: Vec<Vec<u8>>,
  top_level_set: FxHashSet<Vec<u8>>,
}

impl IndexData {
  fn new() -> IndexData {
    IndexData {
      paths: Vec::new(),
      lower: Vec::new(),
      char_bits: Vec::new(),
      path_lens: Vec::new(),
      seen: FxHashSet::default(),
      top_level: Vec::new(),
      top_level_set: FxHashSet::default(),
    }
  }
}

#[inline]
fn unit_len(buf: &[u8]) -> usize {
  buf.len() / 2
}

#[inline]
fn u16_at(buf: &[u8], unit_index: usize) -> u16 {
  let b = &buf[unit_index * 2..unit_index * 2 + 2];
  u16::from_le_bytes([b[0], b[1]])
}

fn encode_utf16le(s: &str) -> Vec<u8> {
  let mut out = Vec::with_capacity(s.len() * 2);
  for u in s.encode_utf16() {
    out.extend_from_slice(&u.to_le_bytes());
  }
  out
}

fn decode_utf16le(bytes: &[u8]) -> String {
  let units: Vec<u16> = bytes
    .chunks_exact(2)
    .map(|c| u16::from_le_bytes([c[0], c[1]]))
    .collect();
  String::from_utf16_lossy(&units)
}

/// JS `haystack.indexOf(char, fromIndex)` over UTF-16 units. `finder` is the
/// 2-byte little-endian pattern of the needle unit; byte hits at odd offsets
/// straddle two units and are rejected, so the returned unit index equals the
/// JS indexOf result.
fn find_from(finder: &memmem::Finder, hay: &[u8], from_unit: usize) -> usize {
  let mut byte_pos = from_unit * 2;
  while byte_pos < hay.len() {
    match finder.find(&hay[byte_pos..]) {
      Some(off) => {
        let abs = off + byte_pos;
        if abs % 2 == 0 {
          return abs / 2;
        }
        byte_pos = abs + 1;
      }
      None => return NOT_FOUND,
    }
  }
  NOT_FOUND
}

#[inline]
fn is_boundary(code: u16) -> bool {
  // / \ - _ . space
  code == 47 || code == 92 || code == 45 || code == 95 || code == 46 || code == 32
}

#[inline]
fn is_lower(code: u16) -> bool {
  (97..=122).contains(&code)
}

#[inline]
fn is_upper(code: u16) -> bool {
  (65..=90).contains(&code)
}

/// TS `scoreBonusAt`: boundary/camelCase bonus for a match at `pos` in the
/// original-case path. `first` enables the start-of-string bonus (needle[0]).
/// JS reads out-of-range positions as NaN, and every comparison against NaN
/// fails, so out-of-range reads contribute a bonus of 0 — reproduced exactly.
fn score_bonus_at(path: &[u8], pos: usize, first: bool) -> i64 {
  let len = unit_len(path);
  if pos == 0 {
    return if first { BONUS_FIRST_CHAR } else { 0 };
  }
  if pos - 1 >= len {
    return 0;
  }
  let prev_ch = u16_at(path, pos - 1);
  if is_boundary(prev_ch) {
    return BONUS_BOUNDARY;
  }
  if is_lower(prev_ch) && pos < len && is_upper(u16_at(path, pos)) {
    return BONUS_CAMEL;
  }
  0
}

/// TS `computeTopLevelEntries` in incremental form: the first <=100 unique
/// top-level segments in path order. The TS version walks the full list and
/// breaks once 100 segments are collected — feeding paths one by one is
/// identical. Segments keep UTF-16 identity for exact sorting later.
fn push_top_level(data: &mut IndexData, path: &str) {
  if data.top_level.len() >= TOP_LEVEL_CACHE_LIMIT {
    return;
  }
  let units: Vec<u16> = path.encode_utf16().collect();
  let mut end = units.len();
  for (i, &c) in units.iter().enumerate() {
    if c == 47 || c == 92 {
      end = i;
      break;
    }
  }
  if end == 0 {
    return;
  }
  let segment: Vec<u8> = units[..end].iter().flat_map(|u| u.to_le_bytes()).collect();
  if data.top_level_set.contains(&segment) {
    return;
  }
  data.top_level_set.insert(segment.clone());
  data.top_level.push(segment);
}

/// TS sort of top-level entries: (UTF-16 length asc, then UTF-16 code-unit
/// lexicographic asc). Rust's default `String` ordering is byte/code-point
/// order, which differs from UTF-16 unit order around astral chars.
fn cmp_units(a: &[u8], b: &[u8]) -> Ordering {
  let la = unit_len(a);
  let lb = unit_len(b);
  if la != lb {
    return la.cmp(&lb);
  }
  for i in 0..la {
    let (x, y) = (u16_at(a, i), u16_at(b, i));
    if x != y {
      return x.cmp(&y);
    }
  }
  Ordering::Equal
}

/// TS dedupe + indexPath + top-level entry, for one input line.
fn accept_path(data: &mut IndexData, line: &str) {
  if line.is_empty() {
    return;
  }
  // contains() first: inserting a duplicate would allocate a String that is
  // thrown away immediately — duplicates are common when chunks overlap.
  if data.seen.contains(line) {
    return;
  }
  data.seen.insert(line.to_string());
  let lower = line.to_lowercase();
  let lower_bytes = encode_utf16le(&lower);
  let len_units = unit_len(&lower_bytes);
  let mut bits: u32 = 0;
  for u in lower.encode_utf16() {
    if (97..=122).contains(&u) {
      bits |= 1u32 << (u - 97);
    }
  }
  data.paths.push(encode_utf16le(line));
  data.lower.push(lower_bytes);
  data.char_bits.push(bits);
  // Uint16Array assignment wraps modulo 65536; `as u16` truncates the same.
  data.path_lens.push(len_units as u16);
  push_top_level(data, line);
}

/// Capability probe — always true once the module has loaded.
#[napi]
pub fn is_native_file_index() -> bool {
  true
}

/// Opaque fuzzy-search index over a list of file paths. Create with
/// `NativeFileIndex.createNativeFileIndex()` (JS side of `#[napi(factory)]
/// create_native_file_index`, a static factory — not a constructor), fill
/// with `loadFromFileList` / `appendPaths`, query with `search`. Mirrors
/// the TS `FileIndex` API.
#[napi]
pub struct NativeFileIndex {
  data: Option<IndexData>,
}

#[napi]
impl NativeFileIndex {
  #[napi(factory)]
  pub fn create_native_file_index() -> NativeFileIndex {
    NativeFileIndex {
      data: Some(IndexData::new()),
    }
  }

  /// TS `loadFromFileList`: dedupe + full synchronous build.
  #[napi(catch_unwind)]
  pub fn load_from_file_list(&mut self, file_list: Vec<String>) -> napi::Result<()> {
    let data = match self.data.as_mut() {
      Some(d) => d,
      None => return Ok(()),
    };
    data.paths.clear();
    data.lower.clear();
    data.char_bits.clear();
    data.path_lens.clear();
    data.seen.clear();
    data.top_level.clear();
    data.top_level_set.clear();
    for line in file_list {
      accept_path(data, &line);
    }
    Ok(())
  }

  /// Incremental build step used by the JS wrapper's chunked async build
  /// (mirrors TS `buildAsync`): dedupes against everything appended so far
  /// and indexes immediately, so `search` always sees a consistent ready
  /// prefix of the final index.
  #[napi(catch_unwind)]
  pub fn append_paths(&mut self, paths: Vec<String>) -> napi::Result<()> {
    let data = match self.data.as_mut() {
      Some(d) => d,
      None => return Ok(()),
    };
    for line in paths {
      accept_path(data, &line);
    }
    Ok(())
  }

  /// Number of indexed (deduped, non-empty) paths.
  #[napi]
  pub fn path_count(&self) -> u32 {
    match self.data.as_ref() {
      Some(d) => d.paths.len() as u32,
      None => 0,
    }
  }

  /// Fuzzy search. Mirrors TS `search` exactly, including the empty-query
  /// top-level cache and the top-k insertion order.
  #[napi(catch_unwind)]
  pub fn search(
    &self,
    query: String,
    limit: u32,
  ) -> napi::Result<Vec<FileSearchResult>> {
    let limit = limit as usize;
    if limit == 0 {
      return Ok(Vec::new());
    }
    let data = match self.data.as_ref() {
      Some(d) => d,
      None => return Ok(Vec::new()),
    };

    // Empty query: sorted top-level entries with score 0.0 (TS topLevelCache).
    if query.is_empty() {
      let mut sorted = data.top_level.clone();
      sorted.sort_by(|a, b| cmp_units(a, b));
      return Ok(sorted
        .into_iter()
        .take(limit)
        .map(|seg| FileSearchResult {
          path: decode_utf16le(&seg),
          score: 0.0,
        })
        .collect());
    }

    // Smart case: lowercase query → case-insensitive; any uppercase → sensitive.
    let lowered = query.to_lowercase();
    let case_sensitive = query != lowered;
    let needle_full: &str = if case_sensitive { &query } else { &lowered };
    let mut needle_units: Vec<u16> = needle_full.encode_utf16().collect();
    let n_len = needle_units.len().min(MAX_QUERY_LEN);
    needle_units.truncate(n_len);
    if n_len == 0 {
      return Ok(Vec::new());
    }

    // Finder 借用 needle 字节序列——bytes 必须与 finders 同生命周期
    // （E0515：不能借用 map 闭包内的局部变量）。
    let needle_bytes: Vec<[u8; 2]> =
      needle_units.iter().map(|&c| c.to_le_bytes()).collect();
    let finders: Vec<memmem::Finder> =
      needle_bytes.iter().map(|b| memmem::Finder::new(b)).collect();

    // Only a-z bits, over the (possibly case-sensitive) needle — TS parity.
    let mut needle_bitmap: u32 = 0;
    for &u in &needle_units {
      if (97..=122).contains(&u) {
        needle_bitmap |= 1u32 << (u - 97);
      }
    }

    // Upper bound on score assuming every match gets the max boundary bonus.
    let score_ceiling: i64 =
      n_len as i64 * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32;

    // Top-k as (path index, integer fuzz score); threshold = worst kept score.
    let mut top_k: Vec<(usize, i64)> = Vec::new();
    let mut threshold: i64 = i64::MIN;

    let mut starts: Vec<usize> = Vec::with_capacity(8);
    let mut pos_buf = [0usize; MAX_QUERY_LEN];

    for i in 0..data.paths.len() {
      // O(1) bitmap reject: path must contain every a-z letter in the needle.
      if (data.char_bits[i] & needle_bitmap) != needle_bitmap {
        continue;
      }

      let hay: &[u8] = if case_sensitive {
        &data.paths[i]
      } else {
        &data.lower[i]
      };
      let hay_len = unit_len(hay);

      // Candidate start positions for needle[0]: the leftmost occurrence
      // plus every word-boundary occurrence (identical to the TS scan).
      starts.clear();
      let first_pos = find_from(&finders[0], hay, 0);
      if first_pos == NOT_FOUND {
        continue;
      }
      starts.push(first_pos);
      let mut bp = first_pos + 1;
      while bp < hay_len {
        bp = find_from(&finders[0], hay, bp);
        if bp == NOT_FOUND {
          break;
        }
        let prev_code = u16_at(hay, bp - 1);
        if is_boundary(prev_code) {
          starts.push(bp);
        }
        bp += 1;
      }

      let h_len = data.path_lens[i] as i64;
      let length_bonus: i64 = {
        let bonus = 32 - (h_len >> 2);
        if bonus < 0 {
          0
        } else {
          bonus
        }
      };

      let mut best_score: i64 = i64::MIN;

      for &start in &starts {
        pos_buf[0] = start;
        let mut gap_penalty: i64 = 0;
        let mut consec_bonus: i64 = 0;
        let mut prev = start;
        let mut matched = true;
        for j in 1..n_len {
          let pos = find_from(&finders[j], hay, prev + 1);
          if pos == NOT_FOUND {
            matched = false;
            break;
          }
          pos_buf[j] = pos;
          let gap = (pos - prev - 1) as i64;
          if gap == 0 {
            consec_bonus += BONUS_CONSECUTIVE;
          } else {
            gap_penalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
          }
          prev = pos;
        }
        if !matched {
          continue;
        }

        // Gap-bound reject for this start position.
        if top_k.len() == limit
          && score_ceiling + consec_bonus - gap_penalty + length_bonus <= threshold
        {
          continue;
        }

        let original: &[u8] = &data.paths[i];
        let mut score: i64 = n_len as i64 * SCORE_MATCH + consec_bonus - gap_penalty;
        score += score_bonus_at(original, pos_buf[0], true);
        for j in 1..n_len {
          score += score_bonus_at(original, pos_buf[j], false);
        }
        score += length_bonus;

        if score > best_score {
          best_score = score;
        }
      }

      if best_score == i64::MIN {
        continue;
      }
      let score = best_score;

      if top_k.len() < limit {
        top_k.push((i, score));
        if top_k.len() == limit {
          // Stable ascending sort — JS Array.prototype.sort is stable.
          top_k.sort_by(|a, b| a.1.cmp(&b.1));
          threshold = top_k[0].1;
        }
      } else if score > threshold {
        // Leftmost insertion among equal scores, then drop the worst
        // (JS binary search + splice + shift, reproduced exactly).
        let lo = top_k.partition_point(|e| e.1 < score);
        top_k.insert(lo, (i, score));
        top_k.remove(0);
        threshold = top_k[0].1;
      }
    }

    // Descending (best first); stable to preserve the JS tie order.
    top_k.sort_by(|a, b| b.1.cmp(&a.1));

    let match_count = top_k.len();
    let denom = match_count.max(1) as f64;
    let mut results = Vec::with_capacity(match_count);
    for (rank, (idx, _)) in top_k.iter().enumerate() {
      let path = decode_utf16le(&data.paths[*idx]);
      let position_score = rank as f64 / denom;
      let final_score = if path.contains("test") {
        let penalized = position_score * 1.05;
        if penalized > 1.0 {
          1.0
        } else {
          penalized
        }
      } else {
        position_score
      };
      results.push(FileSearchResult {
        path,
        score: final_score,
      });
    }
    Ok(results)
  }

  /// Release the index memory. The JS wrapper calls this before replacing
  /// the index; safe to call twice, and search/append on a freed index are
  /// no-ops.
  #[napi]
  pub fn free(&mut self) {
    self.data = None;
  }
}

/// Non-git 目录的文件列举——`rg --files --follow --hidden` 的原生替代。
/// 并行遍历 `root`，返回绝对路径列表（目录内按文件名排序，结果确定）。
/// `excludes` 按**目录名**匹配（JS 传入 node_modules/.git/…），命中即整棵
/// 剪枝；隐藏文件包含在结果中；符号链接被跟随（--follow）。
fn scan_project_files_impl(
  root: &str,
  excludes: &[String],
  deadline_ms: u64,
) -> Result<Vec<String>, String> {
  let root_path = Path::new(root);
  let metadata = fs::metadata(root_path)
    .map_err(|err| format!("scan_project_files: root metadata failed: {err}"))?;
  if !metadata.is_dir() {
    return Err(format!("scan_project_files: root is not a directory: {root}"));
  }

  let excludes_set: FxHashSet<String> = excludes.iter().cloned().collect();
  let mut files: Vec<String> = Vec::new();
  let scan_start = std::time::Instant::now();

  // sort(true)：每个目录的条目按名字排序，配合 jwalk 的有序并行队列输出
  // 全序确定的结果（rg --files 同样可复现）。
  // skip_hidden(false)：包含隐藏文件（--hidden 语义；jwalk 默认**跳过**
  // 隐藏条目，必须显式关闭）。
  // follow_links(false)：**不**跟随符号链接——jwalk 0.8 无已访问 inode 环
  // 检测（rg 内部有），/root 实测 follow 遇符号链接环产生 137MB/约 200 万
  // 条爆炸性路径、扫描 404s（2026-09-15）。语义收窄：符号链接指向的路径
  // 不进 @-mention 建议（rg 的无 --follow 模式同此行为）。
  for entry in WalkDir::new(root_path)
    .sort(true)
    .skip_hidden(false)
    .follow_links(false)
    .process_read_dir(move |_depth, _path, _state, children| {
      // deadline 自限：JS 侧 setTimeout race 在 Bun 等待线程池 async FFI
      // Promise 期间不触发（2026-09-15 实测 45-67s 扫描时 10s timer 回调
      // 一次都不执行，unref 与否无关）——超时预算必须在扫描线程内自洽。
      // 超时后清空 children：该目录的子树不再展开，已在飞的并行 read_dir
      // 自然收尾，整体返回 -1 让 JS 降级 ripgrep。
      if deadline_ms > 0 && scan_start.elapsed().as_millis() as u64 > deadline_ms {
        children.clear();
        return;
      }
      // 剪枝：目录名命中 excludes 的条目从 children 中移除，其子树不再
      // 被 read_dir（node_modules / VCS 目录 / .claude 转录）。单项
      // read_dir 失败的 Err 条目同样丢弃——rg 亦静默跳过。
      children.retain(|entry| {
        let dir_entry = match entry {
          Ok(e) => e,
          Err(_) => return false,
        };
        if dir_entry.file_type.is_dir() {
          let name = dir_entry.file_name.to_string_lossy();
          return !excludes_set.contains(name.as_ref());
        }
        true
      })
    })
  {
    // 只收集文件（目录本身跳过）；符号链接经 --follow 解析后 is_file()
    // 反映目标类型，断链/循环产生的 Err 条目直接跳过。
    if let Ok(dir_entry) = entry {
      if dir_entry.file_type.is_file() {
        files.push(dir_entry.path().to_string_lossy().into_owned());
      }
    }
  }

  // deadline 桥接：超时分支只 clear children 终止子树展开，循环结束后
  // 以总耗时复查判定——超 deadline 则 Err（impl 层转 -1），让 JS 降级
  // ripgrep。截止前已收集的部分结果不外泄：截断列表被 JS 当成功消费
  // 会静默缺文件（空列表同样 truthy 跳过降级）。
  if deadline_ms > 0 && scan_start.elapsed().as_millis() as u64 > deadline_ms {
    return Err(format!(
      "scan_project_files: deadline {deadline_ms}ms exceeded"
    ));
  }

  Ok(files)
}

/// 纯 FFI 导出（不走 napi 宏）：JS 侧用 bun:ffi `async: true` 直调，扫描
/// 在 Bun 线程池执行，事件循环不阻塞；同步导出自身无需再开线程。
///
/// 协议（对齐 `rg --files` 的行语义）：
///   - `root` / `excludes` 为 C 字符串；`excludes` 是 `\n` 分隔的目录名串。
///   - `deadline_ms`：扫描超时预算（毫秒），在扫描线程内用
///     `Instant::elapsed` 自洽检查（JS 侧 setTimeout 在 Bun 等待线程池
///     FFI Promise 期间不触发，预算只能放这里）；0 = 无限制。超时返回 -1。
///   - 成功：把结果以 `\n` 分隔的绝对路径写入 `buf`（末尾补一个 `\0`），
///     返回**内容字节数**（不含结尾 `\0`）。
///   - `buf_len` 不足：返回 `-(所需字节数)`（含 `\0`），JS 按该值扩容后
///     重试一次。
///   - 其他错误（空 root / 非目录 / 空指针 / 非 UTF-8 / panic / 超时）：-1。
///
/// panic 跨 `extern "C"` 边界会直接 abort 进程——jwalk/rayon 在极端
/// 文件系统状态下可能 panic，必须用 `catch_unwind` 隔离在边界之内。
#[no_mangle]
pub extern "C" fn ccb_scan_files_into(
  root: *const c_char,
  excludes: *const c_char,
  buf: *mut u8,
  buf_len: usize,
  deadline_ms: u64,
) -> isize {
  let outcome = panic::catch_unwind(AssertUnwindSafe(|| unsafe {
    ccb_scan_files_into_impl(root, excludes, buf, buf_len, deadline_ms)
  }));
  match outcome {
    Ok(code) => code,
    Err(_) => -1,
  }
}

/// `ccb_scan_files_into` 的 unsafe 主体：指针解引用只发生在被
/// `catch_unwind` 包裹的调用内。
///
/// # Safety
/// `root` / `excludes` 必须是以 NUL 结尾的有效 C 字符串（可为 \0 空串），
/// `buf` 必须可写且至少 `buf_len` 字节——由 JS 侧 bun:ffi 调用约定保证。
unsafe fn ccb_scan_files_into_impl(
  root: *const c_char,
  excludes: *const c_char,
  buf: *mut u8,
  buf_len: usize,
  deadline_ms: u64,
) -> isize {
  if root.is_null() || excludes.is_null() || buf.is_null() {
    return -1;
  }
  let root = match CStr::from_ptr(root).to_str() {
    Ok(s) => s,
    Err(_) => return -1,
  };
  if root.is_empty() {
    return -1;
  }
  let excludes_raw = match CStr::from_ptr(excludes).to_str() {
    Ok(s) => s,
    Err(_) => return -1,
  };
  let excludes: Vec<String> = excludes_raw
    .split('\n')
    .filter(|name| !name.is_empty())
    .map(str::to_string)
    .collect();

  let files = match scan_project_files_impl(root, &excludes, deadline_ms) {
    Ok(files) => files,
    Err(_) => return -1,
  };

  // 换行分隔 = rg --files 行语义；无需 JSON 序列化。
  // 输出上限 64MB（约 100 万条路径）：follow_links(false) 后正常项目远低于
  // 此值；若仍超限（极端 symlink 展开/病态目录树）直接 -1，防止 JS 侧按
  // -(所需) 无限扩容。实测 /root 环爆炸时曾达 137MB。
  const SCAN_OUTPUT_LIMIT: usize = 64 * 1024 * 1024;
  let data = files.join("\n").into_bytes();
  let needed = data.len() + 1; // 结尾 \0
  if needed > SCAN_OUTPUT_LIMIT {
    return -1;
  }
  if needed > buf_len {
    return -(needed as isize);
  }
  if !data.is_empty() {
    std::ptr::copy_nonoverlapping(data.as_ptr(), buf, data.len());
  }
  *buf.add(data.len()) = 0;
  data.len() as isize
}
