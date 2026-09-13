# Rust 原生模块（*-napi）规范

本文档说明仓库中 Rust (napi-rs) 原生模块的架构、构建链、验证方法与已知边界。目标：**用 Rust 重写热点模块降低资源占用，行为与原 TS 实现完全一致（原汁原味）**——所有 native 输出必须与 TS 基线逐字节可对拍。

## 模块总览

| 模块 | 作用 | 接线点 | feature flag | 验证 |
|------|------|--------|--------------|------|
| token-counter-napi | 真 BPE token 计数（cl100k） | `countTokensPrecise`（src/services/tokenEstimation.ts，FIFO 512 缓存） | `TOKEN_COUNT_NATIVE` | 差分 506/506 |
| transcript-parser-napi | 转录 SIMD 扫描 + JSONL 解析 + 零拷贝区间接口 | `walkChainBeforeParseNative`、`scanChainRanges`（src/utils/sessionStorage.ts） | `TRANSCRIPT_NATIVE_SCAN` | 差分 974/974 文件 |
| color-diff-napi | jsdiff 忠实移植（行/词 diff + structured_patch）+ syntect 高亮 | `src/index.ts` native-first 导出 | 无（探针自动回退） | 对拍 4566 用例逐字节 |
| file-index-napi | 文件路径模糊搜索（@-mention/quick-open） | `fileSuggestions.ts`（`createNativeFileIndex()`） | `FILE_INDEX_NATIVE` | 差分直连 TS 实现 |
| clipboard-napi | 剪贴板（官方二进制提取，无 Rust 源码） | 静默 null 回退 | — | — |

所有 flag 都在 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES` 中默认启用。

## vendor 布局与加载链

```
vendor/<name>/<triple>/<name>.node     # 构建产物，git 已忽略（见下）
vendor/color-diff/themes/*.tmTheme     # 源资产，入库
vendor/clipboard/、vendor/audio-capture/  # 静态提取资产，入库
```

加载顺序（所有 napi 包统一，见各包 `src/index.ts`）：

1. **内嵌**：编译二进制中 `EMBEDDED_NATIVES`（base64 → `process.dlopen` 内存直载，零文件 I/O）
2. **vendor 目录**：按 platform/arch 选 triple，`require` 对应 `.node`
3. **TS fallback**：纯 TS 实现接管，功能不缺失仅性能回退

每层失败静默降级到下一层，异常不外抛。

### vendor 构建产物的获取（新机制）

**CI 与仓库都不再保存 .node 二进制**（2026-09-13 起，见「CI 架构」）。fresh clone 后：

- 不做任何事：loader 静默回退 TS 实现，功能完整。
- 需要原生速度（本机差分/基准/开发）：`bun run build:all`（不带 `--skip-native`），脚本会对 host 架构现场 `cargo build` 并填充 `vendor/`。
- 注意本机为 aarch64 时 `platformDirName()` 走 `aarch64-unknown-linux-gnu`，加载错目录的 dlopen 报误导性 ENOENT。

## 构建与 CI 架构

单一 workflow `.github/workflows/ci.yml`，三段链：

1. **quality**：biome ci + typecheck + test（coverage）
2. **native**：5 平台矩阵（linux-x64/arm64、darwin-x64/arm64、windows-x64）各 crate `cargo build --release --target <triple>`，产物上传 artifact
3. **package**（push 触发）：下载 native artifacts → **仅填充工作区 `vendor/`（不入 git）** → `node scripts/build-all.mjs --skip-native` → 单文件二进制 + npm tgz，附产物架构断言

> **vendor 不回写机制（2026-09-13 定稿）**：CI 构建完不把 .node 提交回仓库。每次构建现场编译 Rust，产物永远对应当前源码；避免 [skip ci] 自动提交污染历史、与人工提交冲突（曾导致合并冲突与 push 被拒）。`.gitignore` 规则见上。

单文件二进制注意：`scripts/compile.ts` 必须用**单数** `compile: { target }` 逐平台循环——复数 `targets` 被 Bun 静默忽略，产物退化为 host 架构（SIGILL 事故根因，勿改回）。

## 验证方法论

- **差分对拍脚本**（零依赖，本机可跑）：
  - `packages/transcript-parser-napi/scripts/differential.ts <node路径>` / `bench.ts`
  - `packages/color-diff-napi/scripts/differential.ts`（含词 diff 用例与随机语料，`--strict`）
  - 差分基准必须来自**原样提取的 JS 参考实现**（防自证），随机语料需覆盖 CJK、`İ`/`é`、`\r\n`、孤 `\r`、尾行无换行等边界。
- **真参考库执行通道**：node_modules 损坏不挡 ground truth——把 `node_modules/<lib>` 复制到 /tmp 再 import（绕符号链接环），可直接执行真 jsdiff 等参考库拿权威输出做逐字节对拍。
- **判据**：本机不构建不测试（Android proot 上 bun/tsc 失效症状见 `feedback` 记录），**CI 绿是唯一验收判据**；对拍脚本与字节级比对是本机唯一可信实测手段。
- **忠实移植的测试失败定责**：先怀疑手写期望值而非实现——执行真参考库比对后再改任何一边。

## 新建 napi crate 模板清单

- **build.rs 两件套**：`build.rs` 调 `napi_build::setup()` + Cargo.toml `[build-dependencies] napi-build`——缺一个 macOS 链接就报 unresolved `_napi_create_error`。
- crate 名用下划线（产物 `lib<crate>_napi.so`），package 名连字符在 workflow staging 里要替换。
- `use napi::Result` 会遮蔽 `std::result::Result`——自定义错误时 napi Result 写全路径。
- 加依赖只手动编辑 Cargo.toml（禁 `cargo add` / `bun add`）；版本 pin 与现有包惯例一致（napi 3 / memchr 2 / rustc-hash 1.1 / opt-level 3 / lto thin）。
- 构建登记六处：ci.yml native job、collect 脚本 staging、defines.ts、post-build.ts、compile.ts/build-all.mjs 枚举、（如需）bun.lock 手工条目。

## 已知边界与备忘（均不影响实际行为，勿重复报告）

- **Rust `to_lowercase` final-sigma**：词尾 Σ 转变与 JS `toLowerCase` 有理论分歧（file-index），真实路径不可达，内部自洽。
- **lone surrogate**：经 napi ABI 统一变 U+FFFD，路径与查询同被替换，内部自洽。
- **`vendor_tiktoken.rs` 的 find_from_pos unwrap**：fancy-regex 回溯超限会 panic（与上游一致，低概率）；如需加固改为映射 Err。
- **`count_tokens_batch`**：JS 侧预留契约，暂无调用方。
- **transcript `pos as u32`**：>4GiB 文件 msg_idx 截断（上游 fd 层裁剪后不可达）。
- **similar 已从 color-diff 移除**：词/行 diff 为手写 jsdiff 8.0.4 移植（TS `src/jsDiff.ts` 与 Rust 引擎双实现，对拍互证）。
