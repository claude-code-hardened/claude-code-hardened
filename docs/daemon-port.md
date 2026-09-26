# Daemon Server 移植记录（官方 v2.1.283 → cch）

本文档记录将官方 Claude Code v2.1.283 的 daemon server 控制面 **1:1 移植**到 cch 的完整过程：逆向方法、遇到的坑、降级方案与改造点。移植目标是让 `cch daemon` 具备与官方 `claude daemon` 相同的 control socket 协议（op 动词、认证时序、错误码全集），使两边的客户端/服务端可以互相对话。

## 背景

官方 Claude Code 从 v2.1.16x 起**公开发布了 daemon 能力**（`claude daemon` 子命令 + `claude agents` 后台代理视图），而 cch 作为反编译 fork，此前的 `src/daemon/` 只有社区逆向重建的 supervisor 骨架（PR #170，spawn/backoff/workerRegistry），**没有控制面**——外部进程无法向 daemon 请求 spawn 会话或查询状态。

官方 daemon 的形态是 **Unix domain socket 控制协议**（非 HTTP）：

```
cch daemon run/status/logs/stop          ← CLI 面
        │ Unix domain socket
        ▼
/tmp/cch-daemon-<uid>/<hash8>/control.sock
        │ 双重认证：
        │  ① peer uid 校验（失败回 EPEERUID）
        │  ② ~/.cch/daemon/control.key（dispatch/reply/permission-response 必需，EAUTH）
        ▼
supervisor（on-demand：最后一个客户端断开即退出）
        │ --daemon-worker
        ▼
bg workers（roster + lease 跟踪 + attach journal）
```

## 逆向过程

### 第一阶段：binary 分析（撞墙）

官方 native binary（`~/.local/share/claude/versions/2.1.283`，240MB bun 单文件）最初看似**只有常量池**：

- `function xxx` / `async function xxx(` 等源码结构在 92MB 区域搜不到；
- 能看到的只有**字符串常量表**（`daemonMain\x00\x00\x1e\x00...` 形态，符号 + 错误消息）；
- 由此一度误判为"选择性 bytecode 化，daemon 实现无源码"。

从字符串表仍拿到了 743 条 daemon 相关文本（完整 CLI help、错误文案、`tengu_*` 埋点名、文件协议名），足以重构 CLI 面与文件布局，但拿不到控制流。

### 第二阶段：npm 包（也是坑）

官方 npm 包 `@anthropic-ai/claude-code@2.1.283` 只有 **27KB**：`cli-wrapper.cjs` + `install.cjs` + 平台 binary 下载器——**没有明文 cli.js**。旧版 npm 直接分发明文 bundle 的时代已结束。

### 第三阶段：bun-unpacker（突破）

`npx bun-unpacker <binary> -l` 揭示真相：binary 内嵌 **2371 个文件**，且**每个 JS chunk 都是"明文源码 + JSC bytecode"双份**（bytecode 只是启动加速缓存，源码仍在）。此前启发式抽取漏掉它们是因为 chunk 体积小（多在 1-3KB）且散布在 bytecode 段之间，800B 连续可打印阈值切不开。

```bash
npx bun-unpacker ~/.local/share/claude/versions/2.1.283 -o extracted/
# → extracted/chunk-e88tq28v.js  81KB  supervisor 生命周期（daemonMain 全文，明文）
# → extracted/chunk-f37h5e27.js  65KB  control socket 服务端（F 连接处理 + yn op 分发 + qt 状态机）
# → extracted/chunk-d8zrwwxn.js  3.6KB --daemon-worker 入口（runDaemonWorker）
```

### 关键 chunk 与函数对照

| 官方符号（混淆名） | 所在 chunk | 职责 | cch 对应 |
|-------------------|-----------|------|---------|
| `daemonMain`（导出名 `wa`） | chunk-e88tq28v | supervisor：lockfile 争用/让位/升级自重启/idle_exit | `src/daemon/main.ts`（已有，增强中） |
| `F`（createServer 回调） | chunk-f37h5e27 | 连接层：destroy-after-shutdown、30s timeout、peer uid 门 | `createControlServer` |
| `yn` | chunk-f37h5e27 | op 分发 switch（15 case） | `handleControlRequest` |
| `qt` | chunk-f37h5e27 | dispatch/await-ack 轮询状态机 | `awaitDispatchSettled` |
| `T` | chunk-f37h5e27 | 响应发送（JSON + `\n`） | `sendReply` |
| `vD`（chunk-g15kbmn7） | 同上 | controlKey 校验（length 预检 + timingSafeEqual） | `verifyControlKey` 1:1 |
| `RTo`（chunk-7y633cde） | 同上 | peer uid 对比 | `peerUidReject` |
| `K`（同上） | 同上 | peer uid 读取（`Bun.ant.getPeerUid(fd)`） | `getPeerUid`（bun:ffi 补齐，见下） |
| 路径计算（chunk-t2tcad5k） | 同上 | `join(tmpdir, cc-daemon-<uid>, sha256(root).slice(0,8))` | `daemonSockDir` |
| `STo`/`osn` | chunk-t2tcad5k | control.key 读（≤4096B + trim） | `readControlKey` |

## 遇到的坑与降级方案

### ① `Bun.ant.getPeerUid(fd)` 是 Anthropic 定制 Bun 的私有 API → bun:ffi 补齐

官方 peer uid 校验依赖 `Bun.ant.getPeerUid`——标准 Bun/Node 没有这个 API。

**逆向定位**：binary 字符串表里 `getPeerPid` 与 `getPeerUid` 并列出现（同一 native 能力返回 pid/uid/gid 三元组），伴随 `EPEERCRED` 错误码和 `[peer-cred] peer pid unavailable (fd=` 日志文案——**语义钉死为 Linux `getsockopt(SO_PEERCRED)` 返回 `struct ucred{pid,uid,gid}`**（darwin 对应 `getpeereid`）。

**FFI 补齐**（`src/daemon/peerCredentials.ts`，`bun:ffi`，零依赖）：

- linux：`getsockopt(fd, SOL_SOCKET=1, SO_PEERCRED=17, &ucred[12B], &len[4B])`，DataView 读 pid/uid/gid；
- darwin：`getpeereid(fd, &uid, &gid)`（libSystem.B.dylib）；
- win32：返回 null（官方 K() 同）；
- 运行在 Anthropic bundle 下时**优先直通 `Bun.ant.getPeerPid/getPeerUid`**，标准 Bun 才走 FFI；
- libc 不存在/dlopen 失败 → null + warn（与官方 K() 的 catch 行为一致）。

**真实 socket 验证**：daemon 与 client 同进程组实测，`getPeerUid → 0`（== daemon uid）、`getPeerPid → 客户端真实 pid`——与官方行为完全一致，peer uid 门完整生效。

### ② ③ socket 路径与 control.key：完全对齐官方（无缝切换）

初版曾把前缀改成 `cch-daemon-`、key 路径改到 `~/.cch/daemon/` 以"避免与官方安装冲突"——**这是错误方向**。项目目标是原汁原味、从官方无缝切换到 cch：

- 官方 daemon 自带 lockfile 争用机制（transient 让位/抢占），同一用户同一会话根同一时刻只有一个 daemon 持锁，不存在真正冲突；
- hash8 是会话根的 sha256 前缀——官方客户端连 `/tmp/cc-daemon-<uid>/<hash8>/control.sock` 时，连到的就应该是"这个会话根的 daemon"，无论它是官方还是 cch 跑起来的。协议 1:1 的意义正在于此。

**最终实现**：socket 路径 `/tmp/cc-daemon-<uid>/<hash8>/control.sock`、Windows pipe `\\.\pipe\cc-daemon-<id>-<e>`、key 路径 `~/.claude/daemon/control.key`（0600/0700）——全部与官方逐字对齐，脱敏正则 `hw()` 同步。

### ④ bytecode 与明文并存导致的误判

分析早期用"连续可打印 ≥800B"启发式抽明文，结果只抓到 36MB 且 daemon chunk 缺失——小 chunk（1-3KB）被 bytecode 段切碎。**教训**：对 bun compile 产物优先用 bun-unpacker 按嵌入文件表提取，不要靠可打印启发式。

### ⑤ 错误文案是协议面，不翻译

官方所有错误字符串（`EPEERUID` 的 "retry without sudo, or as the daemon owner"、`EAUTH` 的 legacy-client 提示等）按**原文保留**——它们是 wire contract 的一部分，客户端可能按文案匹配行为；i18n 规范（docs/i18n.md）中"给模型/协议看的文本不翻译"原则同样适用于控制协议。

## 协议参考（还原结果）

### op 动词与认证矩阵（15 case）

| op | 认证 | 语义 | 响应 |
|----|------|------|------|
| `ping` | 无 | 存活探测 | `{ok, op:"ping", version:{ISSUES_EXPLAINER}}` |
| `list` | 无 | job 清单（dying 标记） | `{ok, jobs:[record…]}` |
| `has` | 无 | 按 short 查询 | `{ok, alive, present, ready}` |
| `await-ack` | 无 | 等待 dispatch 落地 | qt 状态机响应 |
| `dispatch` | **EAUTH** | 分发后台会话 | qt；stale 连接丢弃埋点 |
| `reply` | **EAUTH**（old-client 专门文案） | 转发到 job | — |
| `permission-response` | **EAUTH** | 权限应答转发 | — |
| `attach` | **legacy 豁免**（无 auth → warn 放行） | 注册 attacher | — |
| `kill` | 无 | 删 roster + evict（exec+outcome 直接删） | `ENOJOB` |
| `respawn-stale` | 无 | idle-stale worker 重生 | `{...respawn 结果}` |
| `resize` | 无 | attacher cols/rows + repaint | — |
| `ensure-spare` | 无 | 预热备用 worker | `{ok}` |
| `nudge` / `yield` / `lease` / `leases` / `shutdown` | 无 | supervisor 生命周期 | — |

### qt 状态机（dispatch/await-ack 共用）

```
轮询（deadline = now + min(timeoutMs, 30s)）:
  settled.nonce === 请求 nonce？
    ├─ 有 refusal → {ok:false, code:ECWDGONE}
    └─ 无         → {ok:true, pid:0, messagingSock:"", via:"cold"}
  handle 存在且 nonce 匹配 → {ok:true, pid, messagingSock, via}
  handle 存在但 nonce 不匹配 → 继续（标记 mismatch；dispatched 为
    dup-live/dropped/refused/closed 时提前跳出）
  超时:
    曾见 mismatch → {ok:false, error:"a previous dispatch … ESTALE"}
    否则          → {ok:false, error:"didn't acknowledge in time", code:ETIMEOUT}
```

### 错误码全集（14 个，与官方逐一对齐）

`EAUTH`、`ECWDGONE`、`EHOSTDEAD`、`ENOJOB`、`ENOREPLY`、`EPEERUID`、`EPROTO`、`ERESPAWNING`、`ESTALE`、`ESTARTING`、`ETIMEOUT`、`ETOOLARGE`、`EUNKNOWN`、`EUNVERIFIED`——以 `ERROR_CODES` 常量固化，新增/删减协议码时编译期可见。

### supervisor exit cause 枚举（还原自字符串表）

`upgrade / service_recall / displaced / yield / shutdown_op / idle_exit / bg_manager_failed / signal / unknown`。

## cch 侧文件清单

| 文件 | 职责 |
|------|------|
| `src/daemon/controlProtocol.ts` | 纯协议层：路径计算、key 读写/校验、peer uid、帧发送、错误码类型（全部纯函数，可单测） |
| `src/daemon/peerCredentials.ts` | `bun:ffi` 重实现 `Bun.ant.getPeerPid/getPeerUid`（linux SO_PEERCRED / darwin getpeereid，Anthropic bundle 下直通原 API） |
| `src/daemon/controlServer.ts` | 服务端：连接处理 + 15 op 分发 + qt 状态机（依赖注入 handles/settled/回调，可测） |
| `src/daemon/controlClient.ts` | 客户端：connect + auth + 单请求（`cch daemon status` 等使用） |
| `src/daemon/main.ts` | supervisor 集成：启动时 bind control.sock（失败降级 warn 继续跑），shutdown 时 close |

## 尚未对齐（后续增量）

- ✅ **bg 会话 spawn 接线**：`onDispatch` 已接 `selectEngine().start()`（服务端签发 short/nonce → 引擎 spawn → JobHandle 注册，exec mode + pid 存活检测）；
- ✅ **on-demand 生命周期**：lease 计数 + 无 live worker 空闲 5s → `idle_exit`（对齐官方"最后客户端断开即退出"）；
- ✅ **respawn-stale 语义**：exec-mode 会话死亡 → handle 删除 + settled 标记；
- **messagingSock**（每 worker 的消息通道）：官方 dispatch 响应里带回（当前置空），需要 worker 侧消息通道实现；
- **service install**（launchctl/systemd）：官方在此版本也禁用了，低优先级；
- **peer uid 的完整方案**：✅ 已通过 bun:ffi 补齐（`src/daemon/peerCredentials.ts`，SO_PEERCRED/getpeereid，真实 socket 验证通过）——见"坑 ①"。
