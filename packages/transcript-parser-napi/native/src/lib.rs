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

#[napi(object)]
pub struct ChainScanRanges {
  /// Flat [start, end, ...] pairs of lines to KEEP when stitching
  /// (active chain + metadata, in file order). Empty when keep_all is true.
  pub kept_ranges: Uint32Array,
  /// Sum of chain-line byte lengths.
  pub chain_bytes: f64,
  /// true = caller should use the original buffer unchanged (below the 50%
  /// stitch gate, or no leaf found). false = stitch from kept_ranges.
  pub keep_all: bool,
}

/// Internal scan result — identical to `ChainScan` but holding owned vectors
/// so the two napi wrappers can copy across the ABI only what they return.
struct CoreScan {
  msg_idx: Vec<u32>,
  meta_ranges: Vec<u32>,
  kept: Vec<u32>,
  chain_bytes: usize,
  keep_all: bool,
  /// Slots on the active parentUuid chain, in file order (slot number order).
  /// Empty when keep_all is true — callers then treat every message as
  /// on-chain (the stitch gate decided the whole buffer is the chain).
  /// Also filled when no leaf exists (empty chain).
  chain_slots: Vec<usize>,
  /// Per-slot uuid bytes (36 ASCII chars each), indexed by slot number.
  /// Lets the window API report anchor uuids without re-scanning lines.
  slot_uuids: Vec<Option<[u8; UUID_LEN]>>,
}

fn find_sub(
  buf: &[u8],
  finder: &memchr::memmem::Finder,
  from: usize,
) -> i64 {
  if from >= buf.len() {
    return -1;
  }
  match finder.find(&buf[from.min(buf.len())..]) {
    Some(idx) => (idx + from.min(buf.len())) as i64,
    None => -1,
  }
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
/// `catch_unwind` converts a panic into a `Status::GenericFailure` Error
/// instead of unwinding across the FFI boundary.
#[napi(catch_unwind)]
pub fn scan_chain(buf: Buffer) -> Result<ChainScan> {
  let core = scan_core(&buf[..]).map_err(|e| Error::new(Status::GenericFailure, e))?;
  Ok(ChainScan {
    msg_index: Uint32Array::with_data_copied(&core.msg_idx),
    meta_ranges: Uint32Array::with_data_copied(&core.meta_ranges),
    kept_ranges: Uint32Array::with_data_copied(&core.kept),
    chain_bytes: core.chain_bytes as f64,
    keep_all: core.keep_all,
  })
}

/// Range-only variant of [`scan_chain`]: returns just the kept byte ranges
/// so JS callers can parse zero-copy `buf.subarray(start, end)` views
/// per line instead of materializing a concatenated copy. Skips copying
/// `msg_index`/`meta_ranges` across the ABI (the scan itself still needs
/// them internally). Same classification algorithm, byte-identical ranges.
/// `catch_unwind` converts a panic into a `Status::GenericFailure` Error
/// instead of unwinding across the FFI boundary.
#[napi(catch_unwind)]
pub fn scan_chain_ranges(buf: Buffer) -> Result<ChainScanRanges> {
  let core = scan_core(&buf[..]).map_err(|e| Error::new(Status::GenericFailure, e))?;
  Ok(ChainScanRanges {
    kept_ranges: Uint32Array::with_data_copied(&core.kept),
    chain_bytes: core.chain_bytes as f64,
    keep_all: core.keep_all,
  })
}

fn scan_core(buf: &[u8]) -> std::result::Result<CoreScan, String> {
  let prefix_len = PARENT_PREFIX.len();
  let key_len = UUID_KEY.len();
  let ts_len = TS_SUFFIX.len();
  let len = buf.len();

  // SIMD-accelerated searchers (memchr). The naive byte loop lost to JS
  // Buffer.indexOf by 3.7x on a 189MB transcript — these win decisively.
  let uuid_finder = memchr::memmem::Finder::new(UUID_KEY);
  let sidechain_finder = memchr::memmem::Finder::new(SIDECHAIN_TRUE);

  // Stride-3 flat message index, mirrors JS msgIdx.
  let mut msg_idx: Vec<u32> = Vec::with_capacity(1024);
  let mut slot_uuids: Vec<Option<[u8; UUID_LEN]>> = Vec::with_capacity(1024);
  let mut meta_ranges: Vec<u32> = Vec::with_capacity(256);
  // uuid (36 ASCII bytes) → slot number (msg_idx offset / 3)
  let mut uuid_to_slot: std::collections::HashMap<[u8; UUID_LEN], usize> =
    std::collections::HashMap::with_capacity(1024);

  let mut pos: usize = 0;
  while pos < len {
    let nl = match memchr::memchr(NEWLINE, &buf[pos.min(len)..]) {
      Some(idx) => (idx + pos.min(len)) as i64,
      None => -1,
    };
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
        let next = find_sub(buf, &uuid_finder, from);
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
        // Truncated line at EOF: JS `buf.toString('latin1', ...)` clamps the
        // end offset and reads a short string that no parent lookup can hit
        // (parents always appear before children in append-only files), so
        // skipping the insert matches JS instead of panicking on the slice.
        let mut slot_uuid: Option<[u8; UUID_LEN]> = None;
        if uuid_start + UUID_LEN <= len {
          let mut uuid = [0u8; UUID_LEN];
          uuid.copy_from_slice(&buf[uuid_start..uuid_start + UUID_LEN]);
          uuid_to_slot.insert(uuid, msg_idx.len() / 3);
          slot_uuid = Some(uuid);
        }
        msg_idx.push(pos as u32);
        msg_idx.push(line_end as u32);
        msg_idx.push(parent_start as u32);
        slot_uuids.push(slot_uuid);
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
    let sc = find_sub(buf, &sidechain_finder, start);
    if sc == -1 || (sc as usize) >= end {
      leaf_slot = i;
      break;
    }
    i -= 1;
  }
  if leaf_slot < 0 {
    return Ok(CoreScan {
      msg_idx,
      slot_uuids,
      meta_ranges,
      kept: Vec::new(),
      chain_bytes: 0,
      keep_all: true,
      chain_slots: Vec::new(),
    });
  }

  // Walk parentUuid to root. Dangling parent = normal chain termination.
  // Legacy progress lines ({"type":"progress"} — PR #24099 removed their
  // production, old transcripts still have them) are transparent: JS's
  // progressBridge rewrites children to skip them, so the Rust walk does
  // the same — the slot is not added to the chain, the walk continues
  // through its parent. (Progress slots keep their uuid → slot mapping:
  // other messages' parents point at them.)
  const PROGRESS_MARKER: &[u8] = b"\"type\":\"progress\"";
  let progress_finder = memchr::memmem::Finder::new(PROGRESS_MARKER);
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
    let is_progress = progress_finder
      .find(&buf[start..end.min(len)])
      .is_some();
    if !is_progress {
      chain_slots.insert(s);
      chain_bytes += end - start;
    }
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

  // Materialize the chain in file order — the window API derives its
  // on-chain set from this regardless of keep_all (sidechain/fork lines
  // stay out of the window even when the gate keeps the whole buffer).
  let mut chain_slots: Vec<usize> = chain_slots.into_iter().collect();
  chain_slots.sort_unstable();

  // 50% stitch gate (see JS comment): only stitch when dropping ≥ half.
  // keep_all only means "parse everything" — the CHAIN is still the
  // parentUuid walk above.
  if len - chain_bytes < (len >> 1) {
    return Ok(CoreScan {
      msg_idx,
      slot_uuids,
      meta_ranges,
      kept: Vec::new(),
      chain_bytes,
      keep_all: true,
      chain_slots,
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

  Ok(CoreScan {
    msg_idx,
    slot_uuids,
    meta_ranges,
    kept,
    chain_bytes,
    keep_all: false,
    chain_slots,
  })
}

/// Window over the active chain: byte ranges of the last `tail_count` chain
/// messages plus the anchors needed to load earlier ones on demand. The
/// JSON semantics stay on the JS side — this returns ranges, not parsed
/// messages, so resuming a huge session only materializes the visible tail
/// instead of the whole message graph.
#[napi(object)]
pub struct TranscriptWindow {
  /// Flat [start, end, ...] pairs — byte ranges of the tail window's chain
  /// message lines, in file order. Parse each with buf.subarray(start, end).
  pub tail_ranges: Uint32Array,
  /// Total messages on the active chain (keep_all: every message line).
  pub total_chain_count: u32,
  /// Number of chain messages NOT in the returned window.
  pub before_window_count: u32,
  /// uuid of the window's first message (readable by the model), empty when
  /// the transcript has no messages or the line was truncated at EOF.
  pub window_start_uuid: String,
  /// parentUuid of the window's first message — the anchor for a follow-up
  /// "load N more before this" pass. Empty when the window reaches the root.
  pub parent_of_first: String,
}

fn uuid_bytes_to_string(b: &[u8]) -> String {
  String::from_utf8_lossy(b).into_owned()
}

#[napi(catch_unwind)]
pub fn scan_transcript_window(buf: Buffer, tail_count: u32) -> Result<TranscriptWindow> {
  let core =
    scan_window_core(&buf[..], tail_count as usize).map_err(|e| Error::new(Status::GenericFailure, e))?;
  Ok(TranscriptWindow {
    tail_ranges: Uint32Array::with_data_copied(&core.tail_ranges),
    total_chain_count: core.total_chain_count as u32,
    before_window_count: core.before_window_count as u32,
    window_start_uuid: core.window_start_uuid,
    parent_of_first: core.parent_of_first,
  })
}

/// Napi-free window result so tests can run without a Node host providing
/// the napi symbols (cargo test links a bare binary).
pub struct WindowCore {
  pub tail_ranges: Vec<u32>,
  pub total_chain_count: usize,
  pub before_window_count: usize,
  pub window_start_uuid: String,
  pub parent_of_first: String,
}

fn scan_window_core(data: &[u8], tail_count: usize) -> std::result::Result<WindowCore, String> {
  let core = scan_core(data)?;
  let len = data.len();

  // The window is the ACTIVE parentUuid chain — always the walk result,
  // never "everything" (sidechain/fork lines stay out even when the
  // stitch gate keeps the whole buffer for parsing).
  let on_chain: Vec<usize> = core.chain_slots.clone();

  let total = on_chain.len();
  let tail_len = tail_count.min(on_chain.len());
  let window = &on_chain[on_chain.len() - tail_len..];

  let mut tail_ranges: Vec<u32> = Vec::with_capacity(tail_len * 2);
  for &slot in window {
    tail_ranges.push(core.msg_idx[slot * 3]);
    tail_ranges.push(core.msg_idx[slot * 3 + 1]);
  }

  let empty = String::new();
  let (start_uuid, parent_of_first) = if window.is_empty() {
    (empty.clone(), empty)
  } else {
    let first_slot = window[0];
    let start_uuid = core.slot_uuids
      .get(first_slot)
      .and_then(|u| u.as_ref())
      .map(|u| uuid_bytes_to_string(u))
      .unwrap_or_else(|| empty.clone());
    // parentStart: byte offset of the parent uuid char, or u32::MAX for null.
    let parent_start = core.msg_idx[first_slot * 3 + 2];
    let parent = if parent_start == u32::MAX
      || parent_start as usize + UUID_LEN > len
    {
      empty
    } else {
      uuid_bytes_to_string(&data[parent_start as usize..parent_start as usize + UUID_LEN])
    };
    (start_uuid, parent)
  };

  Ok(WindowCore {
    tail_ranges,
    total_chain_count: total,
    before_window_count: total - tail_len,
    window_start_uuid: start_uuid,
    parent_of_first,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  pub(crate) fn build_transcript(count: usize) -> Vec<u8> {
    // Synthetic transcript: meta line, then `count` chain messages each
    // with a usage block, plus one sidechain decoy at the end.
    let mut out = Vec::new();
    out.extend_from_slice(b"{\"type\":\"summary\",\"summary\":\"t\"}\n");
    let mut uuid: u64 = 0x1111;
    let mut parent = String::from("null");
    for i in 0..count {
      uuid = uuid.wrapping_add(0x9e3779b97f4a7c15);
      let id = format!("{:032x}", uuid);
      out.extend_from_slice(
        format!(
          "{{\"parentUuid\":{},\"type\":\"assistant\",\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:{:02}:{:02}.000Z\",\"message\":{{\"usage\":{{\"input_tokens\":{},\"output_tokens\":2}}}}}}\n",
          parent, id, i % 60, i % 60, i + 1
        )
        .as_bytes(),
      );
      parent = format!("\"{}\"", id);
    }
    // Sidechain decoy after the chain — must never join the chain.
    out.extend_from_slice(
      b"{\"parentUuid\":null,\"type\":\"assistant\",\"isSidechain\":true,\"uuid\":\"ffffffff-ffff-ffff-ffff-ffffffffffff\",\"timestamp\":\"2026-01-01T23:59:59.000Z\",\"message\":{\"usage\":{\"input_tokens\":999}}}\n",
    );
    out
  }

  fn uuid_at(buf: &[u8], start: usize, end: usize) -> String {
    let line = &buf[start..end];
    let key = b"\"uuid\":\"";
    let pos = line
      .windows(key.len())
      .position(|w| w == key)
      .expect("uuid key");
    String::from_utf8_lossy(&line[pos + key.len()..pos + key.len() + UUID_LEN]).into_owned()
  }

  #[test]
  fn window_is_idempotent_across_repeated_calls() {
    let buf = build_transcript(300);
    let first = scan_window_core(&buf[..], 50).expect("scan");
    assert_eq!(first.total_chain_count, 300, "sidechain decoy must not join the chain");
    for round in 0..100 {
      let again = scan_window_core(&buf[..], 50).expect("scan");
      assert_eq!(again.total_chain_count, first.total_chain_count, "round {}", round);
      assert_eq!(again.tail_ranges, first.tail_ranges, "round {}", round);
      assert_eq!(again.window_start_uuid, first.window_start_uuid, "round {}", round);
    }
  }

  #[test]
  fn alternating_buffers_do_not_cross_contaminate() {
    // Simulates repeated /resume across different session files in one
    // process — each scan must reflect its own buffer only.
    let small = build_transcript(10);
    let big = build_transcript(2000);
    for round in 0..50 {
      let a = scan_window_core(&small[..], 5).expect("scan");
      assert_eq!(a.total_chain_count, 10, "round {}", round);
      let b = scan_window_core(&big[..], 5).expect("scan");
      assert_eq!(b.total_chain_count, 2000, "round {}", round);
      assert_eq!(b.tail_ranges.len(), 10, "round {}", round); // 5 pairs
    }
  }

  #[test]
  fn window_tail_is_chain_tail_in_file_order() {
    let buf = build_transcript(120);
    let w = scan_window_core(&buf[..], 7).expect("scan");
    assert_eq!(w.tail_ranges.len(), 14);
    // First tail range = message #113 (0-based) of 120 → uuid matches slot.
    let start = w.tail_ranges[0] as usize;
    let end = w.tail_ranges[1] as usize;
    assert_eq!(uuid_at(&buf, start, end), w.window_start_uuid);
    // The window's first message still has its parent anchor (chain intact).
    assert!(!w.parent_of_first.is_empty());
    assert_eq!(w.before_window_count, 113);
  }

  #[test]
  fn boundaries_empty_single_and_oversized_tail() {
    let empty: Vec<u8> = Vec::new();
    let w0 = scan_window_core(&empty[..], 10).expect("scan");
    assert_eq!(w0.total_chain_count, 0);
    assert!(w0.tail_ranges.is_empty());
    assert!(w0.window_start_uuid.is_empty());

    let one = build_transcript(1);
    let w1 = scan_window_core(&one[..], 10).expect("scan");
    assert_eq!(w1.total_chain_count, 1);
    assert_eq!(w1.before_window_count, 0);
    assert!(w1.parent_of_first.is_empty()); // root has no parent

    let many = build_transcript(30);
    let w2 = scan_window_core(&many[..], 100).expect("scan");
    assert_eq!(w2.total_chain_count, 30);
    assert_eq!(w2.tail_ranges.len(), 60); // clamped to the whole chain
    assert_eq!(w2.before_window_count, 0);
  }
}

/// Full-pipeline window load, Rust side owns the file I/O: read → line
/// classification (message vs metadata) → active-chain walk → tail window.
/// Only the window's message lines and the (small) metadata lines cross the
/// ABI — the JS heap never materializes the full buffer or the full message
/// graph. This is the line-by-line port of the TS loadTranscriptFile front
/// half (read/classify/chain); the 15-way metadata type dispatch stays in
/// TypeScript (these lines are handed back verbatim for its existing
/// collector to parse, so the type logic cannot drift).
#[napi(object)]
pub struct TranscriptWindowLoad {
  /// The tail window's active-chain message lines, file order, as raw JSONL
  /// strings (each ends with "\n" except possibly the last).
  pub tail_lines: Vec<String>,
  /// All metadata lines from the file (summary/custom-title/tag/...), file
  /// order — small; TS parses these with its existing type dispatch.
  pub meta_lines: Vec<String>,
  /// Total messages on the active chain.
  pub total_chain_count: u32,
  /// Chain messages before the returned window.
  pub before_window_count: u32,
  /// uuid of the window's first message ("" when no messages).
  pub window_start_uuid: String,
  /// parentUuid of the window's first message ("" at the root).
  pub parent_of_first: String,
  /// File size in bytes (for the JS side's cache/telemetry decisions).
  pub file_bytes: f64,
}

#[napi(catch_unwind)]
pub fn load_transcript_window_from_file(
  path: String,
  tail_count: u32,
) -> Result<TranscriptWindowLoad> {
  let core = load_window_core(&path, tail_count as usize)
    .map_err(|e| Error::new(Status::GenericFailure, e))?;
  Ok(TranscriptWindowLoad {
    tail_lines: core.tail_lines,
    meta_lines: core.meta_lines,
    total_chain_count: core.total_chain_count as u32,
    before_window_count: core.before_window_count as u32,
    window_start_uuid: core.window_start_uuid,
    parent_of_first: core.parent_of_first,
    file_bytes: core.file_bytes as f64,
  })
}

/// Napi-free file-level result (tests link without a Node host, so they
/// call this instead of the napi wrapper).
pub struct WindowFileLoad {
  pub tail_lines: Vec<String>,
  pub meta_lines: Vec<String>,
  pub total_chain_count: usize,
  pub before_window_count: usize,
  pub window_start_uuid: String,
  pub parent_of_first: String,
  pub file_bytes: usize,
}

fn load_window_core(
  path: &str,
  tail_count: usize,
) -> std::result::Result<WindowFileLoad, String> {
  use std::fs;

  let data = fs::read(path).map_err(|e| format!("transcript read failed: {}", e))?;
  let core = scan_core(&data)?;

  // The window is the ACTIVE parentUuid chain — the walk result, always
  // (sidechain/fork lines stay out even when the stitch gate would keep
  // the whole buffer for parsing).
  let on_chain: &[usize] = &core.chain_slots;

  let total = on_chain.len();
  let tail_len = tail_count.min(total);
  let window = &on_chain[total - tail_len..];

  let slice_line = |start: usize, end: usize| -> String {
    let end = end.min(data.len());
    String::from_utf8_lossy(&data[start.min(end)..end]).into_owned()
  };

  let mut tail_lines: Vec<String> = Vec::with_capacity(tail_len);
  for &slot in window {
    tail_lines.push(slice_line(
      core.msg_idx[slot * 3] as usize,
      core.msg_idx[slot * 3 + 1] as usize,
    ));
  }

  // Metadata lines: all of them, file order. Windows/preserved-segment
  // edge cases are handled by the TS caller, which can fall back to the
  // full-parse path when its invariants don't hold.
  let mut meta_lines: Vec<String> = Vec::with_capacity(core.meta_ranges.len() / 2);
  let mut m = 0usize;
  while m + 1 < core.meta_ranges.len() {
    meta_lines.push(slice_line(
      core.meta_ranges[m] as usize,
      core.meta_ranges[m + 1] as usize,
    ));
    m += 2;
  }

  let empty = String::new();
  let (start_uuid, parent_of_first) = if window.is_empty() {
    (empty.clone(), empty)
  } else {
    let first_slot = window[0];
    let start_uuid = core.slot_uuids
      .get(first_slot)
      .and_then(|u| u.as_ref())
      .map(|u| uuid_bytes_to_string(u))
      .unwrap_or_else(|| empty.clone());
    let parent_start = core.msg_idx[first_slot * 3 + 2];
    let parent = if parent_start == u32::MAX
      || parent_start as usize + UUID_LEN > data.len()
    {
      empty
    } else {
      uuid_bytes_to_string(&data[parent_start as usize..parent_start as usize + UUID_LEN])
    };
    (start_uuid, parent)
  };

  Ok(WindowFileLoad {
    tail_lines,
    meta_lines,
    total_chain_count: total,
    before_window_count: total - tail_len,
    window_start_uuid: start_uuid,
    parent_of_first,
    file_bytes: data.len(),
  })
}

#[cfg(test)]
mod differential_tests {
  use super::*;
  use crate::tests::build_transcript;
  use std::collections::HashMap as StdHashMap;

  /// JSON-semantic reference implementation of the JS chain semantics:
  /// serde-parse every line, keep message lines (have uuid+parentUuid),
  /// build the active chain from the last non-sidechain message by walking
  /// parentUuid through a uuid→line map, skip legacy progress lines
  /// (transparent, like JS's progressBridge), and return the tail window's
  /// uuids in file order. Independent of the byte-level SIMD path.
  fn reference_chain_tail(
    data: &[u8],
    tail_count: usize,
  ) -> (Vec<String>, usize) {
    let text = String::from_utf8_lossy(data);
    struct Row {
      uuid: String,
      parent: Option<String>,
      is_message: bool,
      is_sidechain: bool,
      is_progress: bool,
      line: String,
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut by_uuid: StdHashMap<String, usize> = StdHashMap::new();
    for line in text.lines() {
      if line.is_empty() {
        continue;
      }
      let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => continue, // meta / unparseable — not a message row
      };
      let uuid = match v.get("uuid").and_then(|u| u.as_str()) {
        Some(u) => u.to_string(),
        None => continue,
      };
      let parent = v
        .get("parentUuid")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());
      let is_message = parent.is_some() || v.get("parentUuid").is_some();
      let is_sidechain = v
        .get("isSidechain")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
      let is_progress = v.get("type").and_then(|t| t.as_str()) == Some("progress");
      if is_message {
        by_uuid.insert(uuid.clone(), rows.len());
      }
      rows.push(Row {
        uuid,
        parent,
        is_message,
        is_sidechain,
        is_progress,
        line: format!("{}\n", line),
      });
    }
    // Leaf: last non-sidechain message row.
    let leaf = rows
      .iter()
      .rposition(|r| r.is_message && !r.is_sidechain);
    let leaf = match leaf {
      Some(i) => i,
      None => return (Vec::new(), 0),
    };
    // Walk to root through parent links (transparent through progress).
    let mut chain_idx: Vec<usize> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cur = Some(leaf);
    while let Some(i) = cur {
      if !seen.insert(i) {
        break;
      }
      let row = &rows[i];
      if row.is_message && !row.is_sidechain && !row.is_progress {
        chain_idx.push(i);
      }
      cur = row.parent.as_ref().and_then(|p| by_uuid.get(p).copied());
    }
    chain_idx.reverse(); // file order
    let total = chain_idx.len();
    let start = total.saturating_sub(tail_count);
    let lines = chain_idx[start..]
      .iter()
      .map(|&i| rows[i].line.clone())
      .collect();
    (lines, total)
  }

  fn build_messy_transcript() -> Vec<u8> {
    // Chain messages interleaved with: metadata lines, a sidechain run, a
    // fork branch (dead), legacy progress in-chain, and long content lines.
    let mut out = Vec::new();
    out.extend_from_slice(b"{\"type\":\"summary\",\"summary\":\"s1\",\"leafUuid\":\"leaf-a\"}\n");
    let mut uuid: u64 = 0x3333;
    let mut parent = String::from("null");
    for i in 0..60 {
      uuid = uuid.wrapping_add(0x9e3779b97f4a7c15);
      let id = format!("{:032x}", uuid);
      let line = if i == 30 {
        // legacy progress in the middle of the chain
        format!(
          "{{\"parentUuid\":{},\"type\":\"progress\",\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"data\":\"step\"}}\n",
          parent, id
        )
      } else if i == 31 {
        // long content line (force multi-kB row)
        let filler = "x".repeat(4096);
        format!(
          "{{\"parentUuid\":{},\"type\":\"assistant\",\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}],\"usage\":{{\"input_tokens\":{}}}}}}}\n",
          parent, id, filler, i
        )
      } else {
        format!(
          "{{\"parentUuid\":{},\"type\":\"assistant\",\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"message\":{{\"usage\":{{\"input_tokens\":{}}}}}}}\n",
          parent, id, i
        )
      };
      out.extend_from_slice(line.as_bytes());
      if i == 10 {
        // Sidechain run (2 lines) hanging off message #10 — not chain.
        for k in 0..2 {
          let sid = format!("side-{}-{}", i, k);
          let p = if k == 0 { parent.clone() } else { format!("side-{}-0", i) };
          out.extend_from_slice(
            format!(
              "{{\"parentUuid\":\"{}\",\"type\":\"assistant\",\"isSidechain\":true,\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
              p, sid
            )
            .as_bytes(),
          );
        }
        // Dead fork branch off message #10 — has children (the sidechain),
        // but is itself not on the active chain.
        out.extend_from_slice(
          format!(
            "{{\"parentUuid\":\"{}\",\"type\":\"assistant\",\"uuid\":\"fork-{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
            parent, i
          )
          .as_bytes(),
        );
      }
      parent = format!("\"{}\"", id);
      if i == 10 {
        // metadata line between messages
        out.extend_from_slice(b"{\"type\":\"custom-title\",\"sessionId\":\"sess-1\",\"customTitle\":\"t\"}\n");
      }
    }
    out
  }

  fn assert_lines_match_reference(data: &[u8], tail: usize) {
    let w = load_window_core(
      "unused", // not used when calling scan_window_core directly
      tail,
    );
    let _ = w; // placeholder — real assertion path below uses the buffer API
    let win = scan_window_core(data, tail).expect("scan");
    let (ref_lines, ref_total) = reference_chain_tail(data, tail);
    assert_eq!(
      win.total_chain_count as usize, ref_total,
      "total chain count must match the JSON-semantic reference"
    );
    let win_lines: Vec<String> = win
      .tail_ranges
      .chunks(2)
      .map(|r| {
        String::from_utf8_lossy(&data[r[0] as usize..r[1] as usize]).into_owned()
      })
      .collect();
    assert_eq!(
      win_lines, ref_lines,
      "tail window lines must match the JSON-semantic reference byte for byte"
    );
  }

  #[test]
  fn differential_window_vs_json_semantic_reference() {
    let data = build_messy_transcript();
    for tail in [1usize, 3, 10, 50, 59, 60, 200] {
      assert_lines_match_reference(&data, tail);
    }
  }

  #[test]
  fn differential_repeated_and_alternating_vs_reference() {
    let small = build_transcript(15);
    let big = build_messy_transcript();
    for round in 0..10 {
      assert_lines_match_reference(&small, 7);
      assert_lines_match_reference(&big, 7);
      let _ = round;
    }
  }
}

#[cfg(test)]
mod progress_tests {
  use super::*;

  #[test]
  fn legacy_progress_lines_are_transparent_in_the_chain() {
    // Old transcripts contain {"type":"progress"} lines in the parentUuid
    // chain (PR #24099 removed their production). JS's progressBridge
    // rewrites children to skip them — the Rust walk must do the same or
    // the windowed resume would materialize progress rows and break the
    // chain at them.
    let mut out = Vec::new();
    let mut uuid: u64 = 0x2222;
    let mut parent = String::from("null");
    for i in 0..10 {
      uuid = uuid.wrapping_add(0x9e3779b97f4a7c15);
      let id = format!("{:032x}", uuid);
      let line = if i == 5 {
        format!(
          "{{\"parentUuid\":{},\"type\":\"progress\",\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
          parent, id
        )
      } else {
        format!(
          "{{\"parentUuid\":{},\"type\":\"assistant\",\"uuid\":\"{}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"message\":{{\"usage\":{{\"input_tokens\":1}}}}}}\n",
          parent, id
        )
      };
      out.extend_from_slice(line.as_bytes());
      parent = format!("\"{}\"", id);
    }
    let dir = std::env::temp_dir().join(format!("twn-prog-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("progress.jsonl");
    std::fs::write(&path, &out).expect("write");

    let w = load_window_core(path.to_str().expect("utf8"), 100).expect("load");
    // The progress line must NOT be part of the chain (9 real messages).
    assert_eq!(w.total_chain_count, 9, "progress line excluded from chain");
    assert!(
      !w.tail_lines.iter().any(|l| l.contains("\"type\":\"progress\"")),
      "progress line must not appear in window lines"
    );
    // Chain stays connected through the progress node: the window is
    // contiguous and reaches back across it.
    assert_eq!(w.tail_lines.len(), 9);
    std::fs::remove_dir_all(&dir).ok();
  }
}

#[cfg(test)]
mod file_tests {
  use super::tests::build_transcript;
  use super::*;

  #[test]
  fn file_level_load_is_repeatable_and_correct_across_sessions() {
    let dir = std::env::temp_dir().join(format!(
      "twn-test-{}",
      std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path_a = dir.join("a.jsonl");
    let path_b = dir.join("b.jsonl");
    // Two different "sessions": a=120 messages, b=5. Repeated alternating
    // loads must reflect each file's own chain — the repeated-load guard
    // for multi-session /resume switching.
    std::fs::write(&path_a, build_transcript(120)).expect("write a");
    std::fs::write(&path_b, build_transcript(5)).expect("write b");

    for round in 0..30 {
      let a = load_window_core(path_a.to_str().expect("utf8"), 50).expect("load a");
      assert_eq!(a.total_chain_count, 120, "round {}", round);
      assert_eq!(a.before_window_count, 70, "round {}", round);
      assert_eq!(a.tail_lines.len(), 50, "round {}", round);
      assert!(a.tail_lines[0].contains("\"parentUuid\""));
      assert!(!a.meta_lines.is_empty(), "summary meta line present");

      let b = load_window_core(path_b.to_str().expect("utf8"), 50).expect("load b");
      assert_eq!(b.total_chain_count, 5, "round {}", round);
      assert_eq!(b.tail_lines.len(), 5, "round {}", round);
      // Oversized tail clamps: before_window 0.
      assert_eq!(b.before_window_count, 0, "round {}", round);
    }

    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn file_level_missing_path_is_clean_error() {
    let result = load_window_core("/nonexistent/tw.jsonl", 10);
    assert!(result.is_err(), "missing file must error, not panic");
  }
}

#[cfg(test)]
mod realfile_tests {
  use super::*;

  // #[ignore] — manual real-data probe, not part of CI. Run:
  //   cargo test -- --ignored --nocapture
  const REAL: &[&str] = &[
    "/root/.claude/projects/-root/71dfc101-dac2-4492-95ae-14f594ffe021.jsonl",
    "/root/.claude/projects/-root/af87404b-6670-43cd-b784-fc917f62d8c5.jsonl",
    "/root/.claude/projects/-root/dfed9300-91f9-4570-b037-7ac9dcba0cbe.jsonl",
  ];

  #[test]
  #[ignore]
  fn real_sessions_repeated_window_loads() {
    for path in REAL {
      let path = *path;
      if !std::path::Path::new(path).exists() {
        continue;
      }
      // First load: cold, timed.
      let t0 = std::time::Instant::now();
      let first = load_window_core(path, 500).expect("load");
      let cold = t0.elapsed();

      // Correctness sanity on REAL data: every tail line is a message line
      // (starts with the parentUuid prefix), valid UTF-8, ends with newline.
      assert!(!first.tail_lines.is_empty());
      for line in &first.tail_lines {
        assert!(line.starts_with("{\"parentUuid\":"), "chain line prefix");
        assert!(line.ends_with('\n'));
      }
      // window_start_uuid must appear inside the first tail line.
      let key = format!("\"uuid\":\"{}\"", first.window_start_uuid);
      assert!(
        first.tail_lines[0].contains(&key),
        "window_start_uuid must be in the first tail line"
      );

      // Total chain count sanity: leaf chain ⊆ message lines in file.
      let msg_line_count = data_line_count(path);
      assert!(
        first.total_chain_count <= msg_line_count,
        "chain ({}) must be ≤ message lines ({})",
        first.total_chain_count,
        msg_line_count
      );

      // Repeated loads: 20 rounds — must be identical and stable.
      for round in 0..20 {
        let again = load_window_core(path, 500).expect("reload");
        assert_eq!(again.total_chain_count, first.total_chain_count, "round {}", round);
        assert_eq!(again.tail_lines, first.tail_lines, "round {}", round);
        assert_eq!(again.window_start_uuid, first.window_start_uuid, "round {}", round);
        assert_eq!(again.meta_lines, first.meta_lines, "round {}", round);
      }

      // Small window on the same huge file — clamps and stays correct.
      let small = load_window_core(path, 3).expect("small");
      assert_eq!(small.tail_lines.len(), 3);
      assert_eq!(small.before_window_count, first.total_chain_count - 3);

      println!(
        "{}: chain={} msgLines={} cold={}ms tailLines={} metaLines={} reload=20×ok",
        path.rsplit('/').next().unwrap_or(path)[..8].to_string(),
        first.total_chain_count,
        msg_line_count,
        cold.as_millis(),
        first.tail_lines.len(),
        first.meta_lines.len(),
      );
    }
  }

  fn data_line_count(path: &str) -> usize {
    let data = std::fs::read(path).expect("read");
    data.iter().filter(|&&b| b == b'\n').count()
  }
}
