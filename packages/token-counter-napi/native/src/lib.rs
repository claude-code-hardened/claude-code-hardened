use napi_derive::napi;

#[napi]
pub fn count_tokens(text: String) -> u32 {
  // 烟测占位：验证 bun × napi3 加载链路。通过后替换为 tiktoken-rs 实现。
  text.len() as u32
}

#[napi]
pub fn is_native_tokenizer() -> bool {
  true
}
