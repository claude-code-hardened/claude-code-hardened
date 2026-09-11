//! Byte-level transcript scanner — Rust port of claude-code-best
//! `src/utils/sessionStorage.ts` `walkChainBeforeParse` (+ `pickDepthOneUuidCandidate`).
//!
//! Mirrors the JS implementation byte-for-byte so a differential test can
//! assert identical output on real transcript files. Input is the raw JSONL
//! buffer; output is the set of byte ranges to keep (active parentUuid chain
//! lines + all metadata lines, in file order) plus a stitch-gate flag.
//!
//! JSON semantics stay on the JS side — this crate only touches bytes.

use napi::bindgen_prelude::{Buffer, Uint32Array};
use napi::{Error, Result, Status};
use napi_derive::napi;

const NEWLINE: u8 = 0x0a;
const QUOTE: u8 = 0x22;
const BACKSLASH: u8 = 0x5c;
const OPEN_BRACE: u8 = 0x7b;
const CLOSE_BRACE: u8 = 0x7d;
const PARENT_PREFIX: &[u8] = b"{\"parentUuid\":";
const UUID_KEY: &[u8] = b"\"uuid\":\"";
const SIDECHAIN_TRUE: &[u8] = b"\"isSidechain\":true";
const UUID_LEN: usize = 36;
const TS_SUFFIX: &[u8] = b"\",\"timestamp\":\"";

#[napi(object)]
pub struct ChainScan {
  /// Flat stride-3 index of transcript-message lines:
  /// [lineStart, lineEnd, parentStart, ...]. parentStart is the byte offset
  /// of the parent uuid's first char, or u32::MAX for null parent.
  pub msg_index: Uint32Array,
  /// Flat [start, end, ...] pairs for metadata lines (no parentUuid prefix,
  /// or messages without a resolvable uuid).
  pub meta_ranges: Uint32Array,
  /// Flat [start, end, ...] pairs of lines to KEEP when stitching
  /// (active chain + metadata, in file order). Empty when keep_all is true.
  pub kept_ranges: Uint32Array,
  /// Sum of chain-line byte lengths.
  pub chain_bytes: f64,
  /// true = caller should use the original buffer unchanged (below the 50%
  /// stitch gate, or no leaf found). false = stitch from kept_ranges.
  pub keep_all: bool,
}

fn find_sub(buf: &[u8], needle: &[u8], from: usize) -> i64 {
  if needle.is_empty() || from >= buf.len() {
    return -1;
  }
  let start = from.min(buf.len());
  match memchr_like(buf, needle, start) {
    Some(idx) => idx as i64,
    None => -1,
  }
}

/// Bounded memmem — naive scan is fine here: markers are short and windows
/// are per-line (the JS reference uses Buffer.indexOf with the same cost).
fn memchr_like(buf: &[u8], needle: &[u8], start: usize) -> Option<usize> {
  let n = needle[0];
  let mut i = start;
  while i + needle.len() <= buf.len() {
    if buf[i] == n && &buf[i..i + needle.len()] == needle {
      return Some(i);
    }
    i += 1;
  }
  None
}

/// JS `pickDepthOneUuidCandidate`: disambiguate multiple
/// `"uuid":"<36>","timestamp":"` matches in one line by finding the one at
/// JSON nesting depth 1 (string-aware; `\"` and `\\` handled).
fn pick_depth_one_candidate(
  buf: &[u8],
  line_start: usize,
  candidates: &[usize],
) -> usize {
  let mut depth: i64 = 0;
  let mut in_string = false;
  let mut escape_next = false;
  let mut ci = 0usize;
  let mut i = line_start;
  while ci < candidates.len() && i < buf.len() {
    if i == candidates[ci] {
      if depth == 1 && !in_string {
        return candidates[ci];
      }
      ci += 1;
    }
    let b = buf[i];
    if escape_next {
      escape_next = false;
    } else if in_string {
      if b == BACKSLASH {
        escape_next = true;
      } else if b == QUOTE {
        in_string = false;
      }
    } else if b == QUOTE {
      in_string = true;
    } else if b == OPEN_BRACE {
      depth += 1;
    } else if b == CLOSE_BRACE {
      depth -= 1;
    }
    i += 1;
  }
  // No depth-1 hit — fall back to the last candidate (matches JS .at(-1)).
  *candidates.last().unwrap()
}

#[napi]
pub fn has_native_transcript_parser() -> bool {
  true
}

/// Rust port of `walkChainBeforeParse`. See ChainScan for the contract.
/// Note: parentStart == u32::MAX in msg_index means null parent (JS uses -1).
#[napi]
pub fn scan_chain(buf: Buffer) -> Result<ChainScan> {
  scan_chain_impl(&buf[..]).map_err(|e| Error::new(Status::GenericFailure, e))
}

fn scan_chain_impl(buf: &[u8]) -> std::result::Result<ChainScan, String> {
  let prefix_len = PARENT_PREFIX.len();
  let key_len = UUID_KEY.len();
  let ts_len = TS_SUFFIX.len();
  let len = buf.len();

  // Stride-3 flat message index, mirrors JS msgIdx.
  let mut msg_idx: Vec<u32> = Vec::with_capacity(1024);
  let mut meta_ranges: Vec<u32> = Vec::with_capacity(256);
  // uuid (36 ASCII bytes) → slot number (msg_idx offset / 3)
  let mut uuid_to_slot: std::collections::HashMap<[u8; UUID_LEN], usize> =
    std::collections::HashMap::with_capacity(1024);

  let mut pos: usize = 0;
  while pos < len {
    let nl = find_sub(buf, &[NEWLINE], pos);
    let line_end = if nl < 0 { len } else { (nl as usize) + 1 };

    if line_end - pos > prefix_len
      && buf[pos] == OPEN_BRACE
      && &buf[pos..pos + prefix_len] == PARENT_PREFIX
    {
      // `{"parentUuid":null,` or `{"parentUuid":"<36 chars>",`
      let parent_start: i64 = if buf[pos + prefix_len] == QUOTE {
        (pos + prefix_len + 1) as i64
      } else {
        -1
      };

      // Collect `"uuid":"` matches within the line; classify by the
      // `","timestamp":"` suffix after 36 chars (see JS comments for why
      // the suffix is required and what disambiguates multi-matches).
      let mut first_any: i64 = -1;
      let mut suffix0: i64 = -1;
      let mut suffix_n: Vec<usize> = Vec::new();
      let mut from = pos;
      loop {
        let next = find_sub(buf, UUID_KEY, from);
        if next < 0 || (next as usize) >= line_end {
          break;
        }
        let next = next as usize;
        if first_any < 0 {
          first_any = next as i64;
        }
        let after = next + key_len + UUID_LEN;
        if after + ts_len <= line_end
          && &buf[after..after + ts_len] == TS_SUFFIX
        {
          if suffix0 < 0 {
            suffix0 = next as i64;
          } else if suffix_n.is_empty() {
            suffix_n.push(suffix0 as usize);
            suffix_n.push(next);
          } else {
            suffix_n.push(next);
          }
        }
        from = next + key_len;
      }

      let uk: i64 = if !suffix_n.is_empty() {
        pick_depth_one_candidate(buf, pos, &suffix_n) as i64
      } else if suffix0 >= 0 {
        suffix0
      } else {
        first_any
      };

      if uk >= 0 {
        let uuid_start = (uk as usize) + key_len;
        let mut uuid = [0u8; UUID_LEN];
        uuid.copy_from_slice(&buf[uuid_start..uuid_start + UUID_LEN]);
        uuid_to_slot.insert(uuid, msg_idx.len() / 3);
        msg_idx.push(pos as u32);
        msg_idx.push(line_end as u32);
        msg_idx.push(parent_start as u32);
      } else {
        meta_ranges.push(pos as u32);
        meta_ranges.push(line_end as u32);
      }
    } else {
      meta_ranges.push(pos as u32);
      meta_ranges.push(line_end as u32);
    }

    pos = line_end;
  }

  // Leaf = last non-sidechain entry. Sidechain marker sits within the first
  // few dozen bytes when present; the bounds check catches spill-over.
  let mut leaf_slot: i64 = -1;
  let n_msgs = msg_idx.len() / 3;
  let mut i = n_msgs as i64 - 1;
  while i >= 0 {
    let start = msg_idx[(i as usize) * 3] as usize;
    let end = msg_idx[(i as usize) * 3 + 1] as usize;
    let sc = find_sub(buf, SIDECHAIN_TRUE, start);
    if sc == -1 || (sc as usize) >= end {
      leaf_slot = i;
      break;
    }
    i -= 1;
  }
  if leaf_slot < 0 {
    return Ok(ChainScan {
      msg_index: Uint32Array::with_data_copied(&msg_idx)?,
      meta_ranges: Uint32Array::with_data_copied(&meta_ranges)?,
      kept_ranges: Uint32Array::with_data_copied(&[])?,
      chain_bytes: 0f64,
      keep_all: true,
    });
  }

  // Walk parentUuid to root. Dangling parent = normal chain termination.
  let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
  let mut chain_slots: std::collections::HashSet<usize> =
    std::collections::HashSet::new();
  let mut chain_bytes: usize = 0;
  let mut slot: Option<usize> = Some(leaf_slot as usize);
  while let Some(s) = slot {
    if !seen.insert(s) {
      break;
    }
    let start = msg_idx[s * 3] as usize;
    let end = msg_idx[s * 3 + 1] as usize;
    chain_slots.insert(s);
    chain_bytes += end - start;
    let parent_start = msg_idx[s * 3 + 2];
    if parent_start == u32::MAX {
      break;
    }
    let parent_start = parent_start as usize;
    if parent_start + UUID_LEN > len {
      // Truncated line — JS would read a short string and miss the lookup.
      break;
    }
    let mut parent = [0u8; UUID_LEN];
    parent.copy_from_slice(&buf[parent_start..parent_start + UUID_LEN]);
    slot = uuid_to_slot.get(&parent).copied();
  }

  // 50% stitch gate (see JS comment): only stitch when dropping ≥ half.
  if len - chain_bytes < (len >> 1) {
    return Ok(ChainScan {
      msg_index: Uint32Array::with_data_copied(&msg_idx)?,
      meta_ranges: Uint32Array::with_data_copied(&meta_ranges)?,
      kept_ranges: Uint32Array::with_data_copied(&[])?,
      chain_bytes: chain_bytes as f64,
      keep_all: true,
    });
  }

  // Interleave chain lines with metadata in file order → kept_ranges.
  let mut kept: Vec<u32> =
    Vec::with_capacity((msg_idx.len() / 3 + meta_ranges.len() / 2) * 2);
  let mut m = 0usize;
  for slot_i in 0..n_msgs {
    let start = msg_idx[slot_i * 3];
    while m < meta_ranges.len() && meta_ranges[m] < start {
      kept.push(meta_ranges[m]);
      kept.push(meta_ranges[m + 1]);
      m += 2;
    }
    if chain_slots.contains(&slot_i) {
      kept.push(start);
      kept.push(msg_idx[slot_i * 3 + 1]);
    }
  }
  while m < meta_ranges.len() {
    kept.push(meta_ranges[m]);
    kept.push(meta_ranges[m + 1]);
    m += 2;
  }

  Ok(ChainScan {
    msg_index: Uint32Array::with_data_copied(&msg_idx)?,
    meta_ranges: Uint32Array::with_data_copied(&meta_ranges)?,
    kept_ranges: Uint32Array::with_data_copied(&kept)?,
    chain_bytes: chain_bytes as f64,
    keep_all: false,
  })
}
