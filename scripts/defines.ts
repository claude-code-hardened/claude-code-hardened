import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

/**
 * Shared MACRO define map used by both dev.ts (runtime -d flags)
 * and build.ts (Bun.build define option).
 *
 * Each value is a JSON-stringified expression that replaces the
 * corresponding MACRO.* identifier at transpile / bundle time.
 *
 * VERSION is read from package.json to avoid version drift.
 */
export function getMacroDefines(): Record<string, string> {
  return {
    'MACRO.VERSION': JSON.stringify(pkg.version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify(''),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(''),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
    'MACRO.PACKAGE_URL': JSON.stringify(''),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  }
}

/**
 * Default feature flags enabled in both Bun.build and Vite builds.
 * Additional features can be enabled via FEATURE_<NAME>=1 env vars.
 *
 * Used by:
 *   - build.ts (Bun.build)
 *   - scripts/vite-plugin-feature-flags.ts (Vite/Rollup)
 *   - scripts/dev.ts (bun run dev)
 */
export const DEFAULT_BUILD_FEATURES = [
  'BUDDY', // 陪伴宠物角色（Squirtle Waddles）
  'TRANSCRIPT_CLASSIFIER', // 对话分类器，用于标注会话类型
  'BRIDGE_MODE', // Remote Control / Bridge 模式，远程控制会话
  'AGENT_TRIGGERS_REMOTE', // sessionIngress 模块级 Map 累积（非 GB 级主因）
  'CHICAGO_MCP', // Chicago MCP 集成（内部代号）
  'VOICE_MODE', // Push-to-Talk 语音输入模式
  'SHOT_STATS', // 单次请求统计信息收集
  'PROMPT_CACHE_BREAK_DETECTION', // 检测 prompt cache 是否被打破（有 10 条上限，可控）
  'TOKEN_BUDGET', // Token 预算管理与控制
  'TOKEN_COUNT_NATIVE', // 本地 Rust BPE 精确 token 计数（native 缺失时自动回退 rough 估算）
  'TRANSCRIPT_NATIVE_SCAN', // 转录 JSONL 字节级链扫描 Rust 实现（native 缺失时回退 JS）
  'FILE_INDEX_NATIVE', // @-mention 文件路径模糊搜索 Rust 实现（native 缺失时回退 TS FileIndex）
  'SEARCH_NAPI', // 进程内原生搜索（packages/search-napi：grepSearch/findGlob/searchCancel）——默认开启。rg 外挂链已整体退役（embedded rg/vendor rg/fetch-rg 全拆除），GrepTool/GlobTool 及全仓文件清单走 native；证据：packages/search-napi 62 组测试 + vendored rg 同款字节渲染（renderGrepMatches）在库。native 缺失时核心搜索以 tool_result 错误返回（'search unavailable: native module missing'），不再有子进程回退
  // P0: local features
  'AGENT_TRIGGERS', // 本地 Agent 触发器（工具调用时启动子代理）
  'ULTRATHINK', // 超深度思考模式，增加推理链长度
  'BUILTIN_EXPLORE_PLAN_AGENTS', // 内置 Explore/Plan 子代理类型
  'LODESTONE', // 上下文锚点，优化长对话的相关性检索
  'EXTRACT_MEMORIES', // 每次 turn 结束 fork 完整消息历史（非 GB 级主因）
  'VERIFICATION_AGENT', // 任务完成后 fork 完整消息（非 GB 级主因）
  'KAIROS_BRIEF', // Kairos 定时摘要（定时汇报当前状态）
  'AWAY_SUMMARY', // 离线摘要（用户离开后生成总结）
  'ULTRAPLAN', // 超级规划模式，深度分析后生成实施计划
  'DAEMON', // 守护进程模式，长驻 supervisor 管理后台 worker（非 GB 级主因）
  'ACP', // ACP 代理协议，支持外部 agent 接入
  'WORKFLOW_SCRIPTS', // 工作流脚本（.claude/workflows/ 中的 YAML/MD）
  // 'HISTORY_SNIP', // 已禁用：snip 功能暂时关闭
  // 'MEMORY_PROJECTION', // 灰度：官方 2.1.284 time-based microcompact（tool_result_clear）的本地内存投影释放。默认关闭（外部行为 100% 不变）；灰度时按环境以 FEATURE_MEMORY_PROJECTION=1 单独开启，观察 prompt cache 命中率与内存 RSS 曲线后再决定是否进默认列表。与 HISTORY_SNIP 无关联（官方无 snip，勿混同）。
  // 'AUTO_COMPACT_BREAKER', // 灰度：官方 2.1.284 autocompact 双保护（2.9 工作包）。① prefix-overflow 预检（遥测 tengu_auto_compact_prefix_overflow，官方 chunk :9534597 "fixed prefix > threshold — compaction cannot help"）：请求构建前估算固定前缀（服务端 input+cache 读/建总量 − 消息内容估算 − snipTokensFreed，即 system prompt+tools+不可压缩部分）是否已单独超过 autocompact 阈值，超则跳过这次注定失败的压缩，走 API 报错/reactive 路径（官方 2.1.284 仅影子遥测 wouldHaveBlocked:true 不实际跳过，CCH flag 开启即实跳，字段名保留官方以对齐看板）。② rapid-refill 熔断（遥测 tengu_auto_compact_rapid_refill_breaker，官方 chunk :15516562）：compact 后 <3 轮（官方 qct=3）内再次回满、连续 3 次（官方 lFn n>=3）判定 thrashing，注入 apiError:'autocompact_thrashing' 终止消息并结束本次 query 的后续 autocompact，与既有 consecutiveFailures 失败熔断并存且互不干扰（守卫次序同官方 jvr：失败熔断在前）。flag 关闭时两条路径全部不可达，行为与现在逐字节等价；两 flag 全开时每轮次序为 snip → microcompact(MEMORY_PROJECTION 投影释放，2.9 不触碰) → autocompact(prefix 预检→rapid-refill 判定)，投影清掉的 tool_result 天然缩小回填量、降低 rapid-refill 计数。常量与消息文案均逐字取自官方 chunk（docs/reverse-284/full-source/_ALL.js :8681495/:8681566/:8681595/:8681801/:9533058）。
  // 'CONTEXT_COLLAPSE', // 已禁用：实现是空壳 stub，启用后会抑制 auto compact 导致上下文管理完全失效
  // 'HANDOFF_PROTOCOL', // 灰度：subagent handback 协议（工作包 4.1 档位 1，默认关闭=零行为变化）。官方一等协议证据（docs/reverse-284 反编译，grep 'handback'）：0128-chunk-zrkp23rq/tools/agent.js spawn 时传入 `handbackOptIn:!X`（X=isFork，fork 不参与）+ `handbackTool`，收尾产物 WPn 携带 {handback, handbackReport}，父级消费点 `Wet({handback,...})` 把报告合并进任务结果；0039-chunk-zrkp23rq/core/agent-loop.js 同名消费 + peer 消息 origin.handback=true 跨代理投递（档位 2 范畴，本轮不实现）。CCH 落地：Handback 工具（packages/builtin-tools/src/tools/AgentTool/handbackTool.ts + 纯逻辑 handback.ts）仅在 AgentTool.call 组装 workerTools 时注入常规（非 fork）子代理池，不进主注册表，主线程天然不可见（对齐 filterParentToolsForFork 的 spawn 期过滤思路）；调用即 schema 校验（summary 必填，findings/files/next_steps 选填自由 schema）→ recordHandback 登记 → tool_result 文本 + structured_output 附件（SyntheticOutputTool 同通道）写入 agent 消息流 → runAgent 监听到该 tool_result 已流出后 break（中止后续轮次，无 AbortError）；消费端 finalizeAgentTool 之后 consumeHandback 前置注入父级可见结果（sync: agentResult.content、backgrounded/async: finalMessage）。引入此条（或 FEATURE_HANDOFF_PROTOCOL=1）前面各接线全部失效：workerTools 不注入、filterToolsForAgent 分支永不命中（池中无实例）、消费者读空 registry。
  'MONITOR_TOOL', // Monitor 工具，流式监控后台进程输出
  // 'FORK_SUBAGENT',            // 已禁用：通过 Agent tool 的特殊方式实现了等效功能，无需再开
  'KAIROS', // Kairos 定时任务系统核心
  'COORDINATOR_MODE', // 多 worker 编排模式（AgentSummary 泄露已在 52b61c2c 修复）
  // 'UDS_INBOX', // 进程间通信管道（inbox/pipe/peers 等命令）构建后 nodejs 环境卡住
  // 'LAN_PIPES', // 局域网管道，依赖 UDS_INBOX  构建后 nodejs 环境卡住
  'BG_SESSIONS', // 后台会话管理（ps/logs/attach/kill）
  'TEMPLATES', // 模板任务（new/list/reply 子命令）
  // 'REVIEW_ARTIFACT',          // 代码审查产物（API 请求无响应，待排查 schema 兼容性）
  // API content block types
  'CONNECTOR_TEXT', // Connector 文本块类型，扩展 API 内容格式
  // Attribution tracking
  'COMMIT_ATTRIBUTION', // Git 提交归属追踪（记录 AI 辅助贡献）
  // Server mode (claude server / claude open)
  'DIRECT_CONNECT', // 直连模式（claude server / claude open）
  // Skill search & learning — feature flags compiled in (so the slash
  // commands /skill-* etc. exist), but the runtime "enabled" toggle
  // defaults to OFF (see featureCheck.ts). Operators turn on via the
  // slash-command toggle or env vars (SKILL_SEARCH_ENABLED=1,
  // SKILL_LEARNING_ENABLED=1). Rationale: bounded caches added on
  // this branch (see docs/agent/sur-skill-overflow-bugs.md) close the
  // overflow risk, but Haiku-on-first-Chinese-query and disk-side
  // observation accumulation remain operator-discretion concerns.
  'EXPERIMENTAL_SKILL_SEARCH', // 技能搜索（bounded caches 已修复 overflow，内存问题已解决）
  'EXPERIMENTAL_SEARCH_EXTRA_TOOLS', // 工具搜索预取管道（TF-IDF 索引 + inter-turn 异步预取）
  // 'SKILLS_SYNC', // 灰度：claude.ai synced-skills 云联动（W5 #56）。默认关闭：云端依赖面（claude.ai skills health/sync）按环境以 FEATURE_SKILLS_SYNC=1 单独开启；本地面（<configHome>/synced-skills/ 离线加载，src/skills/syncedSkills.ts）不受此门控、始终可用。API base 可用 CLAUDE_CODE_SKILLS_API_BASE 覆盖（自托管代理）。
  // 'SKILL_LEARNING',
  // P3: poor mode
  'POOR', // 穷鬼模式，跳过 extract_memories/prompt_suggestion 减少消耗
  // Team Memory
  // 'TEAMMEM', // 灰度：Team Memory（团队记忆）。原禁用理由「邮箱文件无限增长」已失效：src/utils/teammateMailbox.ts:44-49 现存 5 重上限（MAX_MAILBOX_MESSAGES=1000 / MAX_READ_MAILBOX_MESSAGES=200 / MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES=2000 / 单条 text 64KB / 文件 4MB 读超限即抛错），且全部 5 个写路径（writeToMailbox :404、markMessageAsReadByIndex :472、markMessageAsReadByIdentity :520、markMessagesAsRead :585、markMessagesAsReadByPredicate :1391）均经 writeCompactedMailbox → compactMailboxMessages(:172) 主动压缩（retained bytes 2MB 上限），与官方 0124-module-004 的 prune-on-read/ledger(100/2048) 防护等价；teammateViewHelpers 无 module 级 Map/缓存（evictAfter 30s 淘汰，tasks 复用 AppState，内存面对应旧注释第二理由已不成立）。前置 COORDINATOR_MODE 已在默认列表。默认仍关——灰度期按环境以 FEATURE_TEAMMEM=1 单独开启（运行时另有 isTeamMemoryEnabled 的 auto-memory + GrowthBook tengu_herring_clock 双门控，sync watcher 额外要求 github.com remote + OAuth；纯 build flag 打开不会立即触发同步），观察一个版本再决定是否进默认列表。防回归预检已抽查 10 个 teamMem*/teammate 文件，无 Auto-generated stub/空函数。
  // SSH Remote
  'SSH_REMOTE', // SSH 远程连接，本地 REPL + 远端工具执行
  // Autofix PR
  'AUTOFIX_PR', // /autofix-pr 命令（fork 引入；docs/jira/AUTOFIX-PR-001.md 承诺默认开启）
  // Persistent thread goal command — auto-continuation, JSONL persistence,
  // strict completion/blocked audit. See src/services/goal.
  'GOAL',
] as const

/**
 * W7 (#58) 灰度 env gate 组（注册面登记，非构建 feature——不入
 * DEFAULT_BUILD_FEATURES，避免为灰度开关触发重打包）。
 *
 * 官方锚点：docs/reverse-284/decompiled 0043-chunk-zrkp23rq
 * /module-003-env-vars.js 将如下 10 个双词代号 env 开关并排枚举
 * （THRIFTY_SONIC 另见 0082-chunk-dxsxk16b/config/env-vars.js）。
 * 官方构建默认全关，按环境以 CLAUDE_CODE_<NAME>=1 开流通车。
 * 同列表中的 CLAUDE_CODE_SIMPLE / SIMPLE_SYSTEM_PROMPT 是普通布尔旋钮
 * （--bare / 系统提示词替换），不属于灰度组，故不收录。
 *
 *   CLAUDE_CODE_BASALT_COVE / THRIFTY_SONIC / COZY_TEAPOT / GORSE_PLOVER /
 *   AMBER_ASTROLABE / BISON_CAIRN / LARCH_CISTERN / WILLOW_TERN /
 *   PARCHMENT_FERN / BREEZY_HORIZON
 *
 * 运行时读取面：src/utils/env/grayGates.ts（isGrayGateEnabled /
 * getEnabledGrayGates，默认 off——unset 与显式 '0' 均为关）。
 */
