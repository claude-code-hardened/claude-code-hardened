//! Native BPE token counter (cl100k_base) for Claude Code.
//!
//! The JS side (`src/services/tokenEstimation.ts` `countTokensPrecise`) treats
//! this as a "cl100k_base approximation of Anthropic's tokenizer"; when the
//! module is missing it falls back to `length/4` rough estimation.
//!
//! Tokenizer construction mirrors tiktoken-rs 0.6.0 `tiktoken_ext::openai_public::cl100k_base`;
//! the BPE core is vendored in `vendor_tiktoken.rs`.

mod vendor_tiktoken;

use base64::{engine::general_purpose, Engine as _};
use napi::{Error, Result, Status};
use napi_derive::napi;
use rustc_hash::FxHashMap as HashMap;
use std::sync::OnceLock;
use vendor_tiktoken::{CoreBPE, Rank};

pub const ENDOFTEXT: &str = "<|endoftext|>";

pub const FIM_PREFIX: &str = "<|fim_prefix|>";
pub const FIM_MIDDLE: &str = "<|fim_middle|>";
pub const FIM_SUFFIX: &str = "<|fim_suffix|>";
pub const ENDOFPROMPT: &str = "<|endofprompt|>";


const CL100K_PATTERN: &str = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

fn cl100k_base() -> Result<CoreBPE, String> {
    const BPE_FILE: &str = include_str!("../assets/cl100k_base.tiktoken");

    let mut encoder = HashMap::default();
    for line in BPE_FILE.lines() {
        let mut parts = line.split(' ');
        let raw = parts.next().unwrap();
        let token = general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| e.to_string())?;
        let rank: Rank = parts.next().unwrap().parse().map_err(|e| e.to_string())?;
        encoder.insert(token, rank);
    }

    let mut special_tokens = HashMap::default();
    special_tokens.insert(ENDOFTEXT.to_string(), 100257);
    special_tokens.insert(FIM_PREFIX.to_string(), 100258);
    special_tokens.insert(FIM_MIDDLE.to_string(), 100259);
    special_tokens.insert(FIM_SUFFIX.to_string(), 100260);
    special_tokens.insert(ENDOFPROMPT.to_string(), 100276);

    CoreBPE::new(encoder, special_tokens, CL100K_PATTERN)
}

fn bpe() -> Result<&'static CoreBPE> {
    static BPE: OnceLock<CoreBPE> = OnceLock::new();
    match BPE.get() {
        Some(b) => Ok(b),
        None => {
            // A failed init is not cached: the only failure mode is a corrupt
            // embedded vocab, and retrying is harmless.
            let b = cl100k_base().map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("cl100k_base init failed: {e}"),
                )
            })?;
            Ok(BPE.get_or_init(|| b))
        }
    }
}

#[napi]
pub fn count_tokens(text: String) -> Result<u32> {
    Ok(bpe()?.encode_with_special_tokens(&text).len() as u32)
}

#[napi]
pub fn count_tokens_batch(texts: Vec<String>) -> Result<Vec<u32>> {
    let bpe = bpe()?;
    Ok(texts
        .iter()
        .map(|text| bpe.encode_with_special_tokens(text).len() as u32)
        .collect())
}

#[napi]
pub fn is_native_tokenizer() -> bool {
    true
}
