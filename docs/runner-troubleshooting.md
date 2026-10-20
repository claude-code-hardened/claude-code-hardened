# Self-hosted runner troubleshooting runbook (CCH)

操作面落地：工作包 W8（任务 #59，运维/runner）。语义锚点取自官方反编译
`docs/reverse-284/decompiled`：

- `0239-chunk-bxerm1mk/module-003-uncategorized.js:227` —
  `selfHostedRunnerDoctorMain`（doctor 入口）；:281 — runbook §2 末行
  （80%-TTL refresh schedule）；:341 — §9"/healthz always returns 200"。
  runbook 正文共 **九类**排障表：auth chain / network / lifecycle /
  session execution / queue / version / observability / webhook /
  orchestrator（官方 wizard 提示语因 §8 webhook 处于 design 阶段而说 8 类）。
- `0376-chunk-zrkp23rq/tools/mcp-dispatch.js` — `self_hosted_runner_read_health`
  探测 `http://127.0.0.1:${health_port}/healthz`（"0 means disabled"）。
- `0511-chunk-dyqmyxqn/telemetry/events.js` — 官方事件白名单（205 个
  tengu 事件名）。

## 1. /healthz 监听（`src/remoteRuntime/healthServer.ts`）

Runner 进程按 CLI flag 或 env 启动 localhost 专用 `/healthz`：

```bash
# 两种等价开关（也可以用 env：SELF_HOSTED_RUNNER_HEALTH_PORT=8080）
claude ... --health-port=8080
claude ... --health-port 8080     # 裸 flag 默认 8080
SELF_HOSTED_RUNNER_HEALTH_PORT=0  # 显式禁用（官方语义 "0 means disabled"）
```

- 官方语义（runbook §9:341 "The endpoint always returns 200 — read the
  body for state"）：**任何路径、任何方法一律 200**，健康状态在 body 的
  `{ok, path}` 字段里；探针指错路径时可从 `path` 字段直接看出指向。
  状态码不参与健康判定。
- 端口被占用：降级为
  `[runner:warn] /healthz listener failed on port <p>: EADDRINUSE — continuing without /healthz`，
  runner 继续服务会话（runbook §7：观测缺口，非致命）。
- 进程级单例：一个 runner 进程只存在一个监听；优雅停机时随 cleanup
  registry 关闭（`src/cli/remoteIO.ts` 的 runner 会话入口接线，feature
  gate：`BRIDGE_MODE`）。
- liveness probe 指向 `GET :{health-port}/healthz`（runbook §3）。

## 2. Runner doctor（`src/remoteRuntime/runnerDoctor.ts`）

CLI 接线（`src/entrypoints/cli.tsx` 的 `self-hosted-runner` /
`environment-runner` 快速分支，feature gate `BRIDGE_MODE`）：

```bash
claude self-hosted-runner doctor [--json]   # 官方子命令形态（0239:227/:391）
claude self-hosted-runner --doctor [--json] # 等价别名
claude environment-runner doctor            # environment-runner 别名同路由
--json    # 机器可读 {checks, failed, warned, ok}
--help
```

独立结构化入口（非 Ink、不派生 wizard 子会话），输出 dependency /
config / env **三类**清单——这是官方九类排障表的 CCH 子集，**不是完整
对齐**；尚未覆盖的官方类别（TODO，见文件头）：§1 auth chain（仅探 env
来源，不含 4-token 刷新链）、§2 network（DNS/TLS/proxy/429 行未探）、
§3 lifecycle、§4 session execution、§5 queue/placement、§6 version、
§7 observability gaps、§8 webhook、§9 orchestrator。

- dependency：`kubectl` / `docker`（缺 → warn，仅影响取证面）、`git`
  （缺 → fail，会话执行前置条件，runbook §4）。
- config：`--health-port`/env 可解析性；80%-TTL token 刷新时钟偏移检查
  （见 §3）。
- env：`CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION`、session ingress token
  file/FD、`CLAUDE_CODE_ENVIRONMENT_KIND`（runbook §1 auth chain 起点）。

退出码：仅存在 fail 才非零（warn 不算失败）。

## 3. 80%-TTL token 刷新时钟偏移排障（`src/remoteRuntime/ttlWarning.ts`）

官方语义（runbook §2:281 "Runner clock skew throws off the 80%-TTL
refresh schedule"）：80%-TTL 点是 **token/work-order 刷新计划的触发点**
（刷新在 token TTL 的 80% 处执行，100% 处为 JWT `exp`），**不是 job
deadline 倒计时**。主机时钟漂移会让刷新相对服务端落在错误位置，表现为
"健康的 runner 中途 poll auth failed"；决定性动作是修 NTP（runbook §2
末行 fix 列；§9 `clock_skew_ms >= 60000` 同）。

纯函数：`computeTokenRefreshTtlWarning(ttlSec, sinceRefreshMs)` —
`ttlSec` 为 token TTL 总时长（秒），`sinceRefreshMs` 为本地时钟测得的
距上次成功刷新的毫秒数；越过 80% 返回 "refresh due" 告警（含剩余 token
秒数与 clock skew/NTP 提示），越过 100% 升级为 refresh-missed 告警。
degenerate 输入（负值/非有限数）返回 null。

诊断步骤（operator laptop 侧）：

```bash
date -u                                # 本地时钟
curl -sI "$API_BASE/" | grep -i '^date:'   # 服务端时钟
```

接线位置：doctor 的 `token_refresh_clock_skew` 检查项。env 输入为
**CCH 自定名**（官方 runner 的刷新计划来自 orchestrator work-order，
无对应官方 env 面）：

```bash
CCH_RUNNER_TOKEN_TTL_SEC=3600 \   # token TTL（秒，>0）
CCH_RUNNER_TOKEN_AGE_MS=3000000   # 距上次刷新的本地时钟毫秒（>=0，仅初值）
```

**CCH_RUNNER_TOKEN_AGE_MS 只是初值（种子）**：容器 env 恒定不变，单独
依赖它会让 doctor 永远读到同一个冻结的 age——token 实际已刷新后仍误报
"刷新逾期"。实时真值是落盘的
`<CLAUDE_CONFIG_DIR>/runner-token-last-refresh.json`（`lastRefreshAt`
epoch-ms 字段）：刷新方调用 `recordRunnerTokenRefresh()` 更新（生产刷新
链尚未接线，见 runnerDoctor.ts TODO(coverage) §1），
`initRunnerTokenRefreshMarkerFromEnv()` 可用 env 初值播种一次；doctor 的
`token_refresh_clock_skew` 检查在标记存在时优先读标记，env 仅在无标记时
兜底。

## 4. SLACK_TAG_TOKEN（`src/bridge/bridgeConfig.ts`）

官方 env 面：`CLAUDE_CODE_SLACK_TAG_TOKEN`
（env 面锚点 `0011-chunk-bxerm1mk/module-003-env-vars.js`、
`0052-chunk-bxerm1mk/config/env-vars.js`——与其它 secret bearer token
并列）。**官方 secret 脱敏名单成员**（锚点
`0011-chunk-bxerm1mk/module-004-uncategorized.js:1946`，与
`CLAUDE_CODE_OAUTH_TOKEN` 等同列）：任何日志/redact 管道都不得回显。

读取面：`getSlackTagToken()`（bridge 通知/桥接环境变量面）。当前构建内
无消费点，getter 即登记的导出点，通知桥接入时直接采用，勿重定义 env 名。

## 5. Telemetry 事件白名单

`src/services/analytics/datadog.ts` 的 `DATADOG_ALLOWED_EVENTS` 是 **CCH
自有事件白名单**（机制同官方 0511 归一化上报；事件名以本仓真实
`logEvent` 调用点为准）。官方 0511 `telemetry/events.js` 载有 205 个
事件名；CCH 名单并非其子集，也不与之"对齐"——W8 扩容块与本仓名单的
调用点对应，与官方 0511 名单的交集仅 2 条
（`tengu_mcp_list_changed` / `tengu_mcp_server_connection_failed`）。
只扩数据不改上报机制。
