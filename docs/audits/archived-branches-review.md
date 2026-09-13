# 归档分支淘金记录（2026-09-13）

> 分支治理时对 24 个陈旧分支（23 个打 archive tag + feature/pokemon/battle 保留）做的逐个代码核查结论。tag 里内容永存，本文档记录"哪些值得回头摘取"。

## 一、23 个归档分支核查结论（捞 2 / 疑 3 / 废 18）

### 待办 1：LSP compaction 后清理 openedFiles（可直接做，未做）

- `LSPServerManager.ts:414` 的 `closeAllFiles()` 方法本体已在 main，但**全仓无任何调用点**——compaction 后 LSP 文件 Map 无限增长（源码标注 TODO）。
- 修法：在 `src/services/compact/postCompactCleanup.ts` 清理序列加 `void lspManager.closeAllFiles()`，补集成测试。
- 性质：修真实泄漏，零用户可见行为变化。

### 待办 2：highlight.js 懒化（需先设计验证，勿直接捞）

- 现状：`packages/color-diff-napi/index.ts:27` 与 `src/utils/cliHighlight.ts:11` 顶层静态 `import hljs from 'highlight.js'`（全量 192 语言，5–15MB）。**即使 Rust native 接管高亮，hljs 仍无条件驻留内存**——native 迁移没覆盖 fallback 库的驻留成本（memory-peak P1 #9 的本质）。
- 旧方案（archive/feature-20260419-better 的 e8347cc0，26 语言按需注册）**未抓住重点**：hljs 仍被加载。
- 正确方案：native 可用时完全不加载 hljs——懒加载，仅 native 探测失败走 TS fallback 时 import。native 路径内存归零。
- **前置验证**：`cliHighlight.ts:11` 注释声称"Bun --compile 需要静态导入"——需实测 Bun 单文件编译对懒 require/dynamic import 的真实行为（参照 compile.ts SIGILL 教训），再动加载器结构。

### 待办 3：Edit 工具 Tab→空格匹配回退（等用户表态）

- main 的 `FileEditTool/utils.ts:51-59` `findActualString` 仅精确 `includes`——Read 输出将 Tab 渲染为空格，用户复制后 Edit 失配报错。
- 修复源：commit `4cbef966`（四级匹配级联 + mapNormalizedMatchBackToFile 回映射 + 6 测试）。
- **性质待定**：修真 bug，但属行为增强（官方原版是否有回退未考证），按"原汁原味"标准需用户明确接受再做。

### 疑 3（大体量，单独立项评估，勿直接捞）

- `archive/feat-local-memory-vault-wiring`：VaultHttpFetchTool + local-vault 共 13 文件 2950 行，自包含，main 无——但整支含 4.1 万行 fork squash。
- `archive/pr-suger-m-213`：VS Code IDE bridge 包，main 无（方向疑被 ideDiffConfig 取代）。
- `archive/refactor-huge-split`：query.ts 三层拆分，部分已吸收（src/query/ config/deps/stopHooks），engine/loop 拆分未进。

### 废 18（tag 保底，无回头价值）

codex/* 全部（UDS 测试、内存上界、ChatGPT OAuth 均已在 main）、docs-reorg、feature-add-auto-mode-settings、feature-docker-run、feature-documant-improve（sideQuery createTrace 已进 main）、feature-unknown-llm、fix-coderabbit、fix-ripgrep-fallback（main :94-106 已有回退）、fixture-remove-old-edit、lint-preview、pr-Kaxtrel-349、refactor-prune、revert-1222（main 的 /goal 完整存在）、version-i18n-zh-cn。

## 二、feature/pokemon/battle 考察（保留）

83 提交 / 4 天冲刺（4/21–24）/ +14,246 行：`packages/pokemon/` 完整战斗系统（engine 838 行、捕获/AI/蛋孵化/PokeAPI 导入、19 测试文件 2,831 行）+ src/buddy 区重写 + `/pokemon-battle` 命令。自带 AI 审查报告（13 项 Gen9 偏差修 8 项后停更）。

**裁决：保留分支不合回**——main 同区域（buddy/REPL）已独立演进 549 提交，合回必大冲突；pokemon 包自包含度高，将来想要从分支摘 `packages/pokemon/` 成本低。附带：`CLAUDE.md:184` "pokemon（示例/测试）"提法陈旧（main 无此目录），待清理。

## 三、经验

- "分支名像垃圾 ≠ 内容是垃圾"——本次淘出 1 个已采纳修复（t() 空 key 守卫，cec159ce）+ 3 项待办。
- 旧分支内容作计划依据前，必须 diff main 现状核实是否已被吸收（23 个里 18 个的改动已被后续开发覆盖或目标已消失）。
