# Vendored components

`native/` 内的以下文件来自上游项目，MIT 许可：

- `src/vendor_tiktoken.rs`
  来自 [tiktoken-rs 0.6.0](https://github.com/zurawiki/tiktoken-rs)（`src/vendor_tiktoken.rs` +
  `src/patched_tiktoken.rs` 中的 `CoreBPE::new` / `encode_with_special_tokens`）。
  修改内容见文件头注释（移除 pyo3 残留、unstable 编码路径、`decode`、`bstr`/`anyhow` 依赖）。
- `assets/cl100k_base.tiktoken`
  来自 [tiktoken-rs 0.6.0](https://github.com/zurawiki/tiktoken-rs) `assets/`，原始数据为
  [openai/tiktoken](https://github.com/openai/tiktoken) 发布的 cl100k_base 词表
  （openaipublic.blob.core.windows.net，MIT 许可）。

两者均以 MIT 许可分发；上游版权与许可文本见
<https://github.com/zurawiki/tiktoken-rs/blob/main/LICENSE>。
