# MCP 模块 Rust 重写可行性评估（2026-09-13）

> 按项目方法论（热点数据背书 / 边界税最小切分 / 逐字节对拍）评估 MCP 模块的 Rust 重写价值。结论先行：**整体不适合，部分适合但收益偏低；真正的赢家是 TS 层单源化改造（省 ~40MB，无需 Rust）**。

## 一、模块现状

| 层 | 位置 | 规模 | 职责 |
|---|---|---|---|
| 编排层 | `packages/mcp-client/` | ~1,900 行 | manager/connection/discovery/execution/cache 薄编排 |
| 核心层 | `src/services/mcp/` | ~11,300 行 | `client.ts`(3.4k 连接工厂+transport 编排)、`auth.ts`(2.5k OAuth)、`config.ts`(1.6k)、`useManageMCPConnections.ts`(1.1k 接 AppStateStore) |
| Transport | SDK + 自研 | — | stdio/SSE/StreamableHTTP 用官方 `@modelcontextprotocol/sdk` ^1.29；WebSocket(200 行)/InProcess/claudeai-proxy 自研 |

合计 ~14.4k 行 TS；SDK dist 84 文件/3MB。

## 二、热点与收益预估

- **内存大头是 schema 对象驻留，不是字节流**：P2 #22 属实——`manager.ts:73` toolsCache 与 `AppStateStore.ts:180` mcp.tools 双容器引用同一批 CoreTool；10 server 场景 ≈30–60MB（与文档 ~40MB 吻合）。**数据最终要回 JS 给 Tool registry/API 用，Rust 化不省这部分内存**。
- **新发现偏差**：`client.ts:996` stderr 上限实际仍是 **64MB/server**，且 `stderrOutput +=` 为 O(n²) 拼接——memory-peak 文档"已修 8MB"未落地（又一处报告过时）。
- CPU：SDK ReadBuffer 每消息 Buffer.concat + JSON.parse + **Zod schema 双解析**；`recursivelySanitizeUnicode` 全 schema 递归 NFC。均发生在连接建立/toolsChanged 时，非稳态高频，收益低。

## 三、边界税评估

- **可下沉（纯字节流，与 transcript-parser 同构）**：stdio 子进程管道、stderr 缓冲、行帧切分（SDK ReadBuffer 的 `indexOf('\n')`）、WS 帧。
- **必须留 JS**：client.ts 连接编排/重连、OAuth、elicitation/progress/权限回调、CoreTool 适配闭包与 AppStateStore 联动。
- **切分线**：SDK transport 层（进出均为完整 JSON 行）。

## 四、结论

1. **整体重写：不适合**。内存大头（schema 驻留）Rust 化不省；3–6 周工作量；OAuth/WS/InProcess 变体回归风险高。
2. **rmcp（官方 Rust SDK）不建议引入**：虽已 Tier-1（2026-08，client conformance 50/50），但完整 SDK 语义与本项目"逐字节对拍"方法论冲突。
3. **P2 #22 的正解是 TS 层单源化**（toolsCache 与 mcp.tools 二选一，局部改动省 ~40MB）——无需 Rust，性价比远超重写。
4. **最小可行切片（若做）**：
   - 首选 **stderr 管道下沉**：Rust 环形缓冲（8MB 硬上限、memchr 扫描、消除 O(n²)），输入 chunk → 输出字节区间，TS 按需 toString——单一纯函数边界、对拍容易，顺手修掉 64MB 隐患，估 2–3 天；
   - 次选 `recursivelySanitizeUnicode` 下沉（NFC + 控制符剔除，unicode-normalization crate，3–5 天，对拍方法同 color-diff）。

## 五、与既有评估的对照

transcript-parser 成功的三个要素——字节级扫描、单一纯函数边界、差分可对拍——MCP 只有 transport 层部分具备；而 MCP 的内存大头（schema 对象图）恰恰是"必须回 JS"的形状。这与当年排除"API 请求体构建（边界税）"是同一逻辑。
