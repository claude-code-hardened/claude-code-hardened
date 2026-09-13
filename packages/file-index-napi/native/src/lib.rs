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
//! napi 3 note: this crate deliberately uses plain return values everywhere
//! (no `napi::Result`). See token-counter-napi/native/src/lib.rs for why
//! `use napi::Result` is dangerous (double-generic `Result<T, S = Status>`
//! alias shadowing `std::result::Result`).

use std::cmp::Ordering;

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
  if !data.seen.insert(line.to_string()) {
    return;
  }
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
/// `createNativeFileIndex()`, fill with `loadFromFileList` / `appendPaths`,
/// query with `search`. Mirrors the TS `FileIndex` API.
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
  #[napi]
  pub fn load_from_file_list(&mut self, file_list: Vec<String>) {
    let data = match self.data.as_mut() {
      Some(d) => d,
      None => return,
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
  }

  /// Incremental build step used by the JS wrapper's chunked async build
  /// (mirrors TS `buildAsync`): dedupes against everything appended so far
  /// and indexes immediately, so `search` always sees a consistent ready
  /// prefix of the final index.
  #[napi]
  pub fn append_paths(&mut self, paths: Vec<String>) {
    let data = match self.data.as_mut() {
      Some(d) => d,
      None => return,
    };
    for line in paths {
      accept_path(data, &line);
    }
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
  #[napi]
  pub fn search(&self, query: String, limit: u32) -> Vec<FileSearchResult> {
    let limit = limit as usize;
    if limit == 0 {
      return Vec::new();
    }
    let data = match self.data.as_ref() {
      Some(d) => d,
      None => return Vec::new(),
    };

    // Empty query: sorted top-level entries with score 0.0 (TS topLevelCache).
    if query.is_empty() {
      let mut sorted = data.top_level.clone();
      sorted.sort_by(|a, b| cmp_units(a, b));
      return sorted
        .into_iter()
        .take(limit)
        .map(|seg| FileSearchResult {
          path: decode_utf16le(&seg),
          score: 0.0,
        })
        .collect();
    }

    // Smart case: lowercase query → case-insensitive; any uppercase → sensitive.
    let lowered = query.to_lowercase();
    let case_sensitive = query != lowered;
    let needle_full: &str = if case_sensitive { &query } else { &lowered };
    let mut needle_units: Vec<u16> = needle_full.encode_utf16().collect();
    let n_len = needle_units.len().min(MAX_QUERY_LEN);
    needle_units.truncate(n_len);
    if n_len == 0 {
      return Vec::new();
    }

    let finders: Vec<memmem::Finder> = needle_units
      .iter()
      .map(|&c| {
        let bytes = c.to_le_bytes();
        memmem::Finder::new(&bytes)
      })
      .collect();

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
    results
  }

  /// Release the index memory. The JS wrapper calls this before replacing
  /// the index; safe to call twice, and search/append on a freed index are
  /// no-ops.
  #[napi]
  pub fn free(&mut self) {
    self.data = None;
  }
}
