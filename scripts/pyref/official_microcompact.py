#!/usr/bin/env python3
"""官方 Claude Code 2.1.284 time-based microcompact / tool_result_clear
(keep-recent) 纯函数参考模型 —— 用于与 CCH 的 MEMORY_PROJECTION 实现对拍。

对拍对象: src/services/compact/microCompact.ts clearToolResultProjection。
本文所有规则均标注官方反编译源码出处:
  _ALL.js  = docs/reverse-284/full-source/_ALL.js
  dec0043  = docs/reverse-284/decompiled/0043-chunk-zrkp23rq/module-004-uncategorized.js

规则行号地图
────────────
_ALL.js:4544 (单行模块)
  Ct      = "[Old tool result content cleared]"   占位符字面量
  Dl      = "<persisted-output>"                  已持久化前缀
  mun     = 20000                                 tokensSaved 门槛
  Ll      = 2000                                  image 块 token 估算
  bt      = 白名单 {Read,Bash,PowerShell,Grep,Glob,WebSearch,WebFetch,Edit,Write}
            (at/He/wt/$r/Qr/Cr/Et/wn 在 bundle 中逐一 verify 为上列工具名;
             gg="WebSearch" 见同行)
  Hl( )   tool_result token 估算 (string→Cd; text→Cd; image→+2000;
            document→+Rn)
  Fl( )   白名单 tool_use id 收集
  zl( )   已清除判定: 剥可选 Tt 前缀后 ==Ct 或 startswith(Dl)
  PLr( )  预览: r=max(1,keepRecent); 保留集=slice(-r); 候选=窗外 tool_result
            且 !zl(content) (零 token 不排除); tokensSaved=ΣHl(候选)
  EFt( )  替换: image/document→Ct; 其余→content_by_id[id]??Ct;
            若非 image/doc 且替换文本不以 Tt 开头且原内容含 Ym → Tt+替换
  lMo( )  主入口: PLr 预览; g<mun → 整体放弃(null); 逐候选
            P = content ? persist(content,id) : null; E[id]=P??Ct; EFt 应用;
            遥测 tengu_time_based_microcompact{toolsCleared:S.size,
            toolsKept:r.size, keepRecent, tokensSaved:g,
            trigger:"context_hint"}; 日志 "[KEEP-RECENT MC] context_hint
            trigger, cleared N tool results (~G tokens), kept last R";
            返回 {messages, tokensSaved, clearedIds:S, clearedContent:E}
  En      空闲通路 {minIdleSeconds:3900, keepToolUses:5,
            clearAtLeastTokens:20000, triggerToolUsesBelowCount:3,
            minTriggerToolUses:20}
_ALL.js:372   FWt(Tt)="<artifact-content-authored-by-others/>\\n",
              Ym="<artifact-content-authored-by-others/>" (Nl/Vl 标记)
_ALL.js:4440  Cd(text,n=4)=Math.round(len/n); tr(ext)=json/jsonl/jsonc→2 else 4
dec0043       Rn(e,n): text→Cd; document.source.type=="text"→
              Cd(source.data, tr(title扩展名)); source.type=="content"→
              逐块 Wte; 其余 image/document→2000
_ALL.js:6846-6855  Oee="<persisted-output>", J1n="</persisted-output>",
              Y=Ct 同字面量; Sz() persist (isJson=Array.isArray,
              JSON.stringify(content,null,2), EEXIST→复用, 文件
              ${id}.${json?'json':'txt'}); Rge() 预览模板
              "<persisted-output>\\nOutput too large ($Ht(size)). Full output
              saved to: $path\\n\\nPreview (first $Ht(2000)):\\n$preview\\n
              ...\\n</persisted-output>"
_ALL.js:28779-28781  context-hint 控制器 G(): includeFirstPartyBetas &&
              querySource.startsWith("repl_main_thread") && flag
              tengu_hazel_osprey; buildRequestParams: PLr(msgs,5).tokensSaved
              >=mun 才附 beta W1r="context-hint-2026-04-09"(:1721) 与 body
              context_hint; p()=status===422||424 → C() 清理 → retry;
              target 缺省 75000
_ALL.js:10605 retry 现场: as=am(pi.messages,"microcompact");
              pi.clearedIds.size>0 → onHintCleared(clearedIds,clearedContent)
_ALL.js:17906 onHintCleared → 事件 {type:"hint_clears", ids, contentById}

标注为"假设"(产物未恢复, 以 CCH 直接移植的实现回替):
  官方 Ht(字节格式化) chunk-yzkf958d.js 未恢复 → 用 CCH formatFileSize 同构;
  官方 P4e(preview 截断) 未恢复 → 用 CCH generatePreview 同构。

入口: apply_clear(messages, now, state) -> (cleared_messages, report)
用法: python3 scripts/pyref/official_microcompact.py --emit-fixture
"""

from __future__ import annotations

import json
import math
import os

# ---------------------------------------------------------------------------
# 常量 (逐条标注官方行号)
# ---------------------------------------------------------------------------

PLACEHOLDER = "[Old tool result content cleared]"           # :4544 Ct; :6855 Y
PERSIST_OPEN = "<persisted-output>"                         # :4544 Dl; :6846 Oee
PERSIST_CLOSE = "</persisted-output>"                       # :6855 J1n
TT_PREFIX = "<artifact-content-authored-by-others/>\n"      # :372 FWt (Tt)
ARTIFACT_MARKER = "<artifact-content-authored-by-others/>"  # :372 Ym

MUN_TOKENS_SAVED = 20000        # :4544 mun
IMAGE_TOKENS = 2000             # :4544 Ll
KEEP_RECENT = 5                 # En.keepToolUses :4544 (= :28781 k=5)
BETA_CONTEXT_HINT = "context-hint-2026-04-09"    # :1721 W1r
TARGET_TOKENS_FLOOR = 75000     # :28779 b (tengu_hazel_osprey_floor)

WHITELIST = {                   # :4544 bt (9 工具, 名称已逐一 verify)
    "Read", "Bash", "PowerShell", "Grep", "Glob",
    "WebSearch", "WebFetch", "Edit", "Write",
}

IDLE_CONFIG = {                 # :4544 En —— 空闲通路 (CCH 仅遥测镜像)
    "minIdleSeconds": 3900,
    "keepToolUses": 5,
    "clearAtLeastTokens": 20000,
    "triggerToolUsesBelowCount": 3,
    "minTriggerToolUses": 20,
}

TELEMETRY_EVENT = "tengu_time_based_microcompact"   # :4544 i(...)
KEEP_RECENT_LOG = ("[KEEP-RECENT MC] context_hint trigger, cleared {n} "
                   "tool results (~{g} tokens), kept last {r}")

JSON_EXTS = {"json", "jsonl", "jsonc"}    # :4440 tr()
PREVIEW_SIZE_BYTES = 2000                 # :6846 VTe (CCH toolResultStorage:110)


# ---------------------------------------------------------------------------
# 基础原语
# ---------------------------------------------------------------------------

def js_truthy(v):
    """JS 真值: null/''/0/False → falsy; []/{} 恒 truthy。"""
    if v is None or v is False:
        return False
    if isinstance(v, str):
        return v != ""
    if isinstance(v, (int, float)):
        return v != 0
    return True


def cd(text, n=4):
    """:4440 Cd(e,n=4)=Math.round(e.length/n)。正数域 floor(x+0.5) 复刻
    JS Math.round (Python round 是银行家舍入, 不可直接用)。"""
    if not isinstance(text, str):
        return 0
    return int(math.floor(len(text) / n + 0.5))


def tr(ext):
    """:4440 tr(e): json/jsonl/jsonc → 2, 其余 4。"""
    return 2 if ext in JSON_EXTS else 4


def is_block(b):
    """:4440 mp(e)=z(e) —— 普通对象块判定。"""
    return isinstance(b, dict)


def rn(block, n=None):
    """dec0043 Rn(e,n) —— document token 估算解码结果。"""
    if isinstance(block, str):
        return cd(block, 4 if n is None else n)
    if not is_block(block):
        return 0
    btype = block.get("type")
    if btype == "text":
        return cd(block.get("text", ""), 4 if n is None else n)
    if btype == "document" and isinstance(block.get("source"), dict):
        src = block["source"]
        if src.get("type") == "text":
            title = block.get("title")
            ext = ""
            if isinstance(title, str) and "." in title:
                ext = title.rsplit(".", 1)[-1].lower()
            g = tr(ext)
            return cd(src.get("data", ""), g if n is None else min(n, g))
        if src.get("type") == "content":
            inner = src.get("content")
            if isinstance(inner, str):
                return cd(inner, 4 if n is None else n)
            if isinstance(inner, list):
                return wte([b for b in inner if is_block(b)], n)
    if btype in ("image", "document"):
        return 2000
    return 0


def wte(content, n=None):
    """dec0043 Wte(e,n): string→Cd; 数组→逐块 ΣRn。"""
    if not js_truthy(content):
        return 0
    if isinstance(content, str):
        return cd(content, 4 if n is None else n)
    if isinstance(content, list):
        return sum(rn(b, n) for b in content)
    return 0


def hl(content):
    """:4544 Hl(e) —— tool_result token 估算。"""
    if not js_truthy(content):
        return 0
    if isinstance(content, str):
        return cd(content)
    if not isinstance(content, list):
        return 0
    total = 0
    for b in content:
        if isinstance(b, str):
            total += cd(b)
            continue
        if not is_block(b):
            continue
        btype = b.get("type")
        if btype == "text":
            total += cd(b.get("text", ""))
        elif btype == "image":
            total += IMAGE_TOKENS            # :4544 n+Ll
        elif btype == "document":
            total += rn(b)
    return total


def includes_marker(content):
    """:4544 Nl(e) —— content 是否含 Ym 标记 (字符串或 text 块)。"""
    if isinstance(content, str):
        return ARTIFACT_MARKER in content
    if isinstance(content, list):
        for b in content:
            if (is_block(b) and b.get("type") == "text"
                    and isinstance(b.get("text"), str)
                    and ARTIFACT_MARKER in b["text"]):
                return True
    return False


def is_already_cleared(content):
    """:4544 zl(e) —— 仅字符串; 剥可选 Tt 前缀后 == Ct 或 startswith(Dl)。"""
    if not isinstance(content, str):
        return False
    body = content[len(TT_PREFIX):] if content.startswith(TT_PREFIX) else content
    return body == PLACEHOLDER or body.startswith(PERSIST_OPEN)


def collect_whitelist_ids(messages):
    """:4544 Fl(e) —— assistant 消息中白名单 tool_use id, 遇序。"""
    ids = []
    for msg in messages:
        if msg.get("type") != "assistant":
            continue
        content = (msg.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if (is_block(b) and b.get("type") == "tool_use"
                    and b.get("name") in WHITELIST):
                ids.append(b.get("id"))
    return ids


def plr(messages, keep_recent):
    """:4544 PLr(e,n) —— 预览 {clearSet, keepSet, tokensSaved, candidates}。"""
    ids = collect_whitelist_ids(messages)
    r = max(1, keep_recent)
    keep = set(ids[-r:])
    clear = {i for i in ids if i not in keep}
    if not clear:
        return {"clearSet": clear, "keepSet": keep, "tokensSaved": 0,
                "candidates": []}
    tokens_saved = 0
    candidates = []
    for msg in messages:
        if msg.get("type") != "user":
            continue
        content = (msg.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if (is_block(b) and b.get("type") == "tool_result"
                    and b.get("tool_use_id") in clear
                    and not is_already_cleared(b.get("content"))):
                tokens_saved += hl(b.get("content"))
                candidates.append(b)
    return {"clearSet": clear, "keepSet": keep, "tokensSaved": tokens_saved,
            "candidates": candidates}


def block_content(block):
    return block.get("content")


def has_visual_block(content):
    """:4544 EFt 内 E = content 数组含 image/document 块。"""
    return isinstance(content, list) and any(
        is_block(b) and b.get("type") in ("image", "document") for b in content)


def eft(messages, clear_ids, content_by_id):
    """:4544 EFt(e,n,s) —— 占位符替换 (含 Tt 包装规则)。"""
    if not clear_ids:
        return [dict(m) for m in messages]
    out = []
    for msg in messages:
        if msg.get("type") != "user":
            out.append(msg)
            continue
        content = (msg.get("message") or {}).get("content")
        if not isinstance(content, list):
            out.append(msg)
            continue
        touched = False
        new_content = []
        for block in content:
            if (not is_block(block) or block.get("type") != "tool_result"
                    or block.get("tool_use_id") not in clear_ids):
                new_content.append(block)
                continue
            visual = has_visual_block(block_content(block))
            if visual:
                k = PLACEHOLDER
            else:
                k = content_by_id.get(block.get("tool_use_id")) or PLACEHOLDER
            if (not visual and not k.startswith(TT_PREFIX)
                    and includes_marker(block_content(block))):
                c = TT_PREFIX + k
            else:
                c = k
            if block_content(block) == c:
                new_content.append(block)
                continue
            touched = True
            nb = dict(block)
            nb["content"] = c
            new_content.append(nb)
        if touched:
            m2 = dict(msg)
            m2["message"] = dict(msg.get("message") or {})
            m2["message"]["content"] = new_content
            out.append(m2)
        else:
            out.append(msg)
    return out


# ---------------------------------------------------------------------------
# persist 通路 (官方 Sz(:6846)+Rge(:6855) 组合 → 返回替换文本)
# ---------------------------------------------------------------------------

def format_size(n):
    """CCH src/utils/format.ts formatFileSize 同构 (官方 Ht 未恢复, 见头注)。"""
    kb = n / 1024
    if kb < 1:
        return f"{n} bytes"
    if kb < 1024:
        s = f"{kb:.1f}"
        s = s[:-2] if s.endswith(".0") else s
        return f"{s}KB"
    mb = kb / 1024
    if mb < 1024:
        s = f"{mb:.1f}"
        s = s[:-2] if s.endswith(".0") else s
        return f"{s}MB"
    s = f"{mb / 1024:.1f}"
    s = s[:-2] if s.endswith(".0") else s
    return f"{s}GB"


def generate_preview(content, max_bytes):
    """CCH toolResultStorage.ts:340 generatePreview 同构 (官方 P4e 假设)。"""
    if len(content) <= max_bytes:
        return content, False
    truncated = content[:max_bytes]
    last_nl = truncated.rfind("\n")
    cut = last_nl if last_nl > max_bytes * 0.5 else max_bytes
    return content[:cut], True


def persisted_text(content, tool_use_id, mode="success"):
    """官方 Sz+Rge 组合 → 替换文本; 失败 (mode='error' 或非 text 块) 返回
    None → lMo 以 P??Ct 回退占位符。文件路径 ${id}.${json?'json':'txt'}
    (:6846 Ege); 目录取固定 /tmp/tool-results (真实 runtime 为
    projectDir/sessionId/tool-results, 不影响对拍)。"""
    if mode == "error":
        return None
    is_json = isinstance(content, list)
    if is_json and any(not (is_block(b) and b.get("type") == "text")
                       for b in content):
        return None
    content_str = json.dumps(content, indent=2) if is_json else content
    ext = "json" if is_json else "txt"
    filepath = f"/tmp/tool-results/{tool_use_id}.{ext}"
    preview, has_more = generate_preview(content_str, PREVIEW_SIZE_BYTES)
    msg = PERSIST_OPEN + "\n"
    msg += (f"Output too large ({format_size(len(content_str))}). "
            f"Full output saved to: {filepath}\n\n")
    msg += f"Preview (first {format_size(PREVIEW_SIZE_BYTES)}):\n"
    msg += preview
    msg += "\n...\n" if has_more else "\n"
    msg += PERSIST_CLOSE
    return msg


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def apply_clear(messages, now=0.0, state=None):
    """官方 lMo(:4544) + 控制器门(:28781) 的纯函数化。

    state 可选键:
      keep_recent   官方调用恒 5 (:28781 k; En.keepToolUses)
      persist       persist(content,id)->文本|None 接缝; 缺省 persisted_text
      persist_mode  "success"|"error" (缺省接缝行为)
      query_source  控制器要求 startsWith("repl_main_thread") (:28781)
      flag_on       tengu_hazel_osprey (:28779)
      first_party   includeFirstPartyBetas (:28781)

    返回 (messages, report)。declined=True 时 messages 原样。
    `now` 在 context_hint 通路不参与判定 (时间仅属 En 空闲通路), 仅记录。"""
    st = dict(state or {})
    keep_recent = st.get("keep_recent", KEEP_RECENT)
    persist_mode = st.get("persist_mode", "success")
    persist_fn = st.get("persist")
    query_source = st.get("query_source", "repl_main_thread")
    flag_on = st.get("flag_on", True)
    first_party = st.get("first_party", True)

    base = {"declined": True, "decline_reason": None, "toolsCleared": 0,
            "toolsKept": 0, "keepRecent": keep_recent, "tokensSaved": 0,
            "trigger": "context_hint", "clearedIds": [], "clearedContent": {},
            "placeholder": PLACEHOLDER, "telemetry": TELEMETRY_EVENT,
            "log": None, "persistCalls": [], "telemetryPayload": None,
            "beta": None, "now": now}

    # :28781 G() —— includeFirstPartyBetas + repl_main_thread 前缀 +
    # tengu_hazel_osprey。CCH 对应 isMainThreadSource + feature flag。
    if not first_party:
        return [dict(m) for m in messages], dict(
            base, decline_reason="controller:include_first_party_betas")
    if not isinstance(query_source, str) or \
            not query_source.startswith("repl_main_thread"):
        return [dict(m) for m in messages], dict(
            base, decline_reason="controller:query_source")
    if not flag_on:
        return [dict(m) for m in messages], dict(
            base, decline_reason="controller:tengu_hazel_osprey")

    # :28781 buildRequestParams —— u = PLr(r,k).tokensSaved >= mun 才附 beta。
    # :4544 lMo —— 预览 + g<mun 整体放弃。
    preview = plr(messages, keep_recent)
    tokens_saved = preview["tokensSaved"]
    if tokens_saved < MUN_TOKENS_SAVED:
        reason = ("threshold:preview_below_mun" if preview["clearSet"]
                  else "no_clearable_candidates")
        return [dict(m) for m in messages], dict(base, decline_reason=reason)

    clear_ids = {b["tool_use_id"] for b in preview["candidates"]}
    content_by_id = {}
    persist_calls = []
    for cand in preview["candidates"]:
        cid = cand["tool_use_id"]
        content = cand.get("content")
        if js_truthy(content):                      # content ? persist : null
            if persist_fn is not None:
                p = persist_fn(content, cid)
            else:
                p = persisted_text(content, cid, persist_mode)
            persist_calls.append(cid)
        else:
            p = None
        content_by_id[cid] = p if p is not None else PLACEHOLDER   # P??Ct

    result = eft(messages, clear_ids, content_by_id)

    report = dict(base)
    report["declined"] = False
    report["toolsCleared"] = len(clear_ids)
    report["toolsKept"] = len(preview["keepSet"])
    report["tokensSaved"] = tokens_saved
    report["clearedIds"] = list(clear_ids)
    report["clearedContent"] = content_by_id
    report["log"] = KEEP_RECENT_LOG.format(n=len(clear_ids),
                                           g=tokens_saved,
                                           r=len(preview["keepSet"]))
    report["persistCalls"] = persist_calls
    report["beta"] = BETA_CONTEXT_HINT
    report["telemetryPayload"] = {   # :4544 事件键序与值
        "toolsCleared": len(clear_ids),
        "toolsKept": len(preview["keepSet"]),
        "keepRecent": keep_recent,
        "tokensSaved": tokens_saved,
        "trigger": "context_hint",
    }
    return result, report


# ---------------------------------------------------------------------------
# 向量生成 → tests/fixtures/pyref/microcompact_vectors.json
# ---------------------------------------------------------------------------

BIG = "a" * 200_000          # cd → 50000 tokens
SMALL_1K = "x" * 1_000       # cd → 250 tokens

# fixture 体积控制: 大内容在 JSON 中以整串标记存储, 载入时 expand_markers 还原
# (仅整串精确匹配才展开, 不误伤占位符模板内的文本)。
MARKERS = {
    "__BIG_200K_A__": BIG,
    "__BIG_80K_A__": "a" * 80_000,
    "__Y40K__": "y" * 40_000,
    "__X1K__": SMALL_1K,
    "__ARTIFACT_200K__": None,   # 置于 ARTIFACT_MARKER 定义后填充
}


def expand_markers(obj):
    if isinstance(obj, str):
        return MARKERS.get(obj, obj)
    if isinstance(obj, list):
        return [expand_markers(v) for v in obj]
    if isinstance(obj, dict):
        return {k: expand_markers(v) for k, v in obj.items()}
    return obj


MARKERS["__ARTIFACT_200K__"] = ARTIFACT_MARKER + "\n" + BIG

TS = [0]


def _assistant(tool_id, name, input_=None):
    TS[0] += 1
    return {
        "type": "assistant",
        "uuid": f"uuid-a-{TS[0]}",
        "timestamp": "2026-10-15T00:00:00.000Z",
        "message": {
            "id": f"msg_{tool_id}",
            "role": "assistant",
            "type": "message",
            "content": [{"type": "tool_use", "id": tool_id, "name": name,
                         "input": input_ if input_ is not None else {}}],
        },
    }


def _user(tool_id, content):
    TS[0] += 1
    return {
        "type": "user",
        "uuid": f"uuid-u-{TS[0]}",
        "timestamp": "2026-10-15T00:00:01.000Z",
        "message": {"role": "user",
                    "content": [{"type": "tool_result",
                                 "tool_use_id": tool_id, "content": content}]},
    }


def session(pairs):
    msgs = []
    for tid, name, content in pairs:
        msgs.append(_assistant(tid, name))
        msgs.append(_user(tid, content))
    return msgs


NOW_MS = 1792022401000.0     # 2026-10-15T00:00:01Z (仅 CCH 遥测镜像用)


def build_vectors():
    vectors = []

    def expected_msgs(pairs, cleared):
        """生成官方期望投影: 复制基线会话并把 cleared id 的块内容替换。"""
        msgs = session(pairs)
        for m in msgs:
            c = (m.get("message") or {}).get("content")
            if isinstance(c, list) and c:
                b = c[0]
                if b.get("type") == "tool_result" and \
                        b.get("tool_use_id") in cleared:
                    b["content"] = cleared[b.get("tool_use_id")]
        return msgs

    def add(name, description, pairs, cleared_content, report,
            notes="", query_source="repl_main_thread", persist_mode="success",
            messages_override=None):
        declined = bool(report.get("declined"))
        vec = {
            "name": name,
            "description": description,
            "querySource": query_source,
            "persistMode": persist_mode,
            "nowMs": NOW_MS,
            "messages": messages_override if messages_override is not None
            else session(pairs),
            "expected": {
                "declined": declined,
                "clearedIds": report.get("clearedIds", []),
                "clearedContent": report.get("clearedContent", {}),
                "report": {k: report[k] for k in (
                    "toolsCleared", "toolsKept", "keepRecent", "tokensSaved",
                    "trigger", "placeholder", "log") if k in report},
                "declineReason": report.get("decline_reason"),
                "messagesUnchanged": declined or not cleared_content,
                "persistCalls": report.get("persistCalls", []),
            },
            "notes": notes,
        }
        vectors.append(vec)
        return vec

    # ── 1. 正好 5 条白名单 → 全在窗内, 不清 ──────────────────────
    add(
        "keep5_exact_no_clear",
        "恰好 5 条 Read —— 全在 keepRecent=5 窗口; PLr clearSet 空 → g=0<mun "
        "整体放弃 (_ALL.js:4544)",
        [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(5)], None,
        {"declined": True, "decline_reason": "no_clearable_candidates"},
        notes="期望: 无清除, persist 零调用。",
    )

    # ── 2. 第 6 条(最老)被清; persist 成功 → 预览模板占位 ──────────
    pairs2 = [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(6)]
    t0_text = persisted_text(BIG, "t0", "success")
    add(
        "six_clear_oldest_persist_ok",
        "6 条 Read —— 最老 t0 越窗被清; persist 成功 → 占位为持久化预览模板 "
        "(官方 Rge :6851-6857); 其余 5 条原样",
        pairs2, {"t0": t0_text},
        {"declined": False, "clearedIds": ["t0"], "clearedContent": {"t0": t0_text},
         "persistCalls": ["t0"], "toolsCleared": 1, "toolsKept": 5,
         "keepRecent": 5, "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
    )

    # ── 3. 全部非白名单 → 永不清 ─────────────────────────────────
    add(
        "non_whitelist_never_clear",
        "30 条 Agent (白名单外) 巨大结果 —— Fl 收不到白名单 id → 放弃 "
        "(_ALL.js:4544 bt)",
        [(f"a{i}", "Agent", "__BIG_200K_A__") for i in range(30)], None,
        {"declined": True, "decline_reason": "no_clearable_candidates"},
        notes="期望: 无清除 (约 150 万 token 也不清)。",
    )

    # ── 4. 预览门槛之下 → 放弃, persist 零调用 ────────────────────
    add(
        "below_threshold_abort_before_persist",
        "6 条 Read 各 1000 字符 (250 token, 未达 mun=20000) —— g<mun 整体放弃 "
        "(_ALL.js:4544 if(g<mun)return null)",
        [(f"t{i}", "Read", "__X1K__") for i in range(6)], None,
        {"declined": True, "decline_reason": "threshold:preview_below_mun"},
        notes="persist_calls 期望 0。",
    )

    # ── 5. 20k 边界: 预览恰 20000 → 官方放行; CCH 净值门拒 (分歧) ────
    pairs5 = [("t0", "Read", "__BIG_80K_A__")] + \
             [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(1, 6)]
    t0_text5 = persisted_text("a" * 80_000, "t0", "success")
    add(
        "boundary_exact_20000",
        "边界: 预览 tokensSaved=20000 恰达标 — 官方 g<mun 只拒小于 → 放行;"
        " CCH 在 persist 后按净额再门槛 (microCompact.ts:837-844) → 净额 "
        "<20000 → 预期分歧 (官方清 / CCH 拒)",
        pairs5, {"t0": t0_text5},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": t0_text5}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 20000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=20000, r=5)},
        notes="分歧样本: preview>=20000 放行 vs net>=20000 (CCH 第二道门)。",
    )

    # ── 6. 边界之上 (净额也 >= 20000) → 对齐放行 ──────────────────
    pairs6 = [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(7)]
    t0_text6 = persisted_text(BIG, "t0", "success")
    t1_text6 = persisted_text(BIG, "t1", "success")
    add(
        "boundary_above_20000_aligned",
        "7 条 Read 各 50000 token — 清 t0,t1, 预览 100000, 扣替换文本后仍 "
        ">=20000 → 官方与 CCH 均放行 (对齐样本)",
        pairs6, {"t0": t0_text6, "t1": t1_text6},
        {"declined": False, "clearedIds": ["t0", "t1"],
         "clearedContent": {"t0": t0_text6, "t1": t1_text6},
         "persistCalls": ["t0", "t1"],
         "toolsCleared": 2, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 100000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=2, g=100000, r=5)},
    )

    # ── 7. 温和混合 → 只清窗外白名单, Agent 不动也不占窗 ───────────
    pairs7 = [("t0", "Read", "__BIG_200K_A__"), ("a0", "Agent", "__BIG_200K_A__"),
              ("t1", "Read", "__BIG_200K_A__"), ("a1", "Agent", "__BIG_200K_A__"),
              ("t2", "Read", "__BIG_200K_A__"), ("a2", "Agent", "__BIG_200K_A__"),
              ("t3", "Read", "__BIG_200K_A__"), ("a3", "Agent", "__BIG_200K_A__"),
              ("t4", "Read", "__BIG_200K_A__"), ("t5", "Read", "__BIG_200K_A__")]
    t0_text7 = persisted_text(BIG, "t0", "success")
    add(
        "mixed_whitelist_and_not",
        "Read/Agent 交错 — 保留窗只按白名单 id 计数 (Agent 不占窗), 清 t0; "
        "Agent 结果全部原样 (_ALL.js:4544 Fl 只收白名单)",
        pairs7, {"t0": t0_text7},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": t0_text7}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
    )

    # ── 8. persist 失败 → 裸字面量占位 ────────────────────────────
    pairs8 = [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(6)]
    add(
        "persist_failure_literal_fallback",
        "persist 报错 — P=null → E[id]=Ct 裸字面量回退 (_ALL.js:4544 "
        "E.set(C.tool_use_id,P??Ct); CCH microCompact.ts:817-819)",
        pairs8, {"t0": PLACEHOLDER},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": PLACEHOLDER}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
        persist_mode="error",
    )

    # ── 9. image 块 → 裸字面量; persist 官方接口仍被调 (恒真数组) ────
    img_content = [
        {"type": "image",
         "source": {"type": "base64", "media_type": "image/png",
                    "data": "AAAA"}},
        {"type": "text", "text": "__BIG_200K_A__"},
    ]
    pairs9 = [("t0", "Read", img_content)] + \
             [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(1, 6)]
    add(
        "image_block_bare_literal",
        "t0 含 image 块 — EFt hasVisual → 直接 Ct 裸字面量, Tt 包装被排除 "
        "(_ALL.js:4544 E?Ct:...; CCH microCompact.ts:811-814)。官方 lMo 在 "
        "content 真值时仍调 persist (数组恒真, persist 返错即回退); CCH 在"
        " persist 之前分流 → persistCalls 预期差异",
        pairs9, {"t0": PLACEHOLDER},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": PLACEHOLDER}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 52000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=52000, r=5)},
        notes="tokensSaved: image 计 2000 (Ll) + text 50000。",
    )

    # ── 10. document(source.text, json 扩展) → 按 data 长度/2 计 ─────
    doc_content = [{"type": "document", "title": "report.json",
                    "source": {"type": "text", "data": "__Y40K__"}}]
    pairs10 = [("t0", "Read", doc_content)] + \
              [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(1, 6)]
    add(
        "document_source_text_token_count",
        "t0 为 text-source document (40000 chars, 扩展 json → tr=2 → "
        "cd=20000, dec0043 Rn) — 官方 tokensSaved=20000 恰达标放行; CCH 把 "
        "document 平铺计 2000 (microCompact.ts:151-153) → 预期分歧 (官方清 / "
        "CCH 拒)",
        pairs10, {"t0": PLACEHOLDER},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": PLACEHOLDER}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 20000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=20000, r=5)},
    )

    # ── 11. 已持久化内容 (<persisted-output> 前缀) 不清不计额 ────────
    persisted_earlier = ("Output too large (195.3KB). Full output saved to: "
                         "/tmp/tool-results/t0.txt")
    prior = (PERSIST_OPEN + "\n" + persisted_earlier + "\n\n"
             "Preview (first 2.0KB):\n" + "a" * 2000 + "\n...\n"
             + PERSIST_CLOSE)
    pairs11 = [("t0", "Read", prior), ("t1", "Read", "__BIG_200K_A__")] + \
              [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(2, 7)]
    t1_text11 = persisted_text(BIG, "t1", "success")
    add(
        "already_persisted_skipped",
        "t0 已是 <persisted-output> 预览 — zl → 不入候选、不计数; t1 巨大 → "
        "只清 t1 (_ALL.js:4544 zl; CCH microCompact.ts:761-767 对齐)",
        pairs11, {"t1": t1_text11},
        {"declined": False, "clearedIds": ["t1"],
         "clearedContent": {"t1": t1_text11}, "persistCalls": ["t1"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
    )

    # ── 12. 已是裸字面量 → 跳过 ──────────────────────────────────
    pairs12 = [("t0", "Read", PLACEHOLDER), ("t1", "Read", "__BIG_200K_A__")] + \
              [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(2, 7)]
    t1_text12 = persisted_text(BIG, "t1", "success")
    add(
        "already_literal_skipped",
        "t0 已是 [Old tool result content cleared] — zl 识别 (含剥 Tt 前缀后"
        "等值分支) → 只清 t1 (_ALL.js:4544 zl)",
        pairs12, {"t1": t1_text12},
        {"declined": False, "clearedIds": ["t1"],
         "clearedContent": {"t1": t1_text12}, "persistCalls": ["t1"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
    )

    # ── 13. 零 token 空串候选: 官方仍清, CCH 剔除 (分歧) ───────────
    pairs13 = [("t0", "Read", ""), ("t1", "Read", "__BIG_200K_A__")] + \
              [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(2, 7)]
    t1_text13 = persisted_text(BIG, "t1", "success")
    add(
        "empty_string_candidate_official_clears",
        "t0 为空串 tool_result — 官方 zl('')==false → 入候选 (Hl=0 不计额), "
        "空串 falsy 不调 persist → E[t0]=Ct, toolsCleared=2; CCH tokens===0 "
        "剔除候选 → 只清 t1 (microCompact.ts:768-769) → 预期分歧",
        pairs13, {"t0": PLACEHOLDER, "t1": t1_text13},
        {"declined": False, "clearedIds": ["t0", "t1"],
         "clearedContent": {"t0": PLACEHOLDER, "t1": t1_text13},
         "persistCalls": ["t1"],
         "toolsCleared": 2, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=2, g=50000, r=5)},
    )

    # ── 14. 非主线程来源 → 对齐放弃 ──────────────────────────────
    add(
        "non_main_thread_source_declines",
        "querySource=agent:abc — 官方控制器要求 repl_main_thread 前缀 "
        "(:28781), CCH isMainThreadSource 同拒 → 对齐样本",
        [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(6)], None,
        {"declined": True, "decline_reason": "controller:query_source"},
        query_source="agent:abc",
    )

    # ── 15. 输出风格变体来源 (前缀匹配) → 对齐放行 ─────────────────
    pairs15 = [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(6)]
    t0_text15 = persisted_text(BIG, "t0", "success")
    add(
        "output_style_source_variant_aligned",
        "querySource=repl_main_thread:outputStyle:custom — 官方 startsWith 与 "
        "CCH 前缀匹配 (microCompact.ts:254-262) 均放行 → 对齐样本",
        pairs15, {"t0": t0_text15},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": t0_text15}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
        query_source="repl_main_thread:outputStyle:custom",
    )

    # ── 16. 同 id tool_result 两份 → 内容对齐, 计数/持久化次数分歧 ───
    msgs16 = []
    for i in range(6):
        msgs16.append(_assistant(f"t{i}", "Read"))
        msgs16.append(_user(f"t{i}", "__BIG_200K_A__"))
    dup_user = {"type": "user", "uuid": "uuid-dup-1",
                "timestamp": "2026-10-15T00:00:02.000Z",
                "message": {"role": "user", "content": [{
                    "type": "tool_result", "tool_use_id": "t0",
                    "content": "__BIG_200K_A__"}]}}
    msgs16.insert(2, dup_user)
    t0_text16 = persisted_text(BIG, "t0", "success")
    exp16 = []
    for m in msgs16:
        m2 = json.loads(json.dumps(m))
        c = (m2.get("message") or {}).get("content")
        if isinstance(c, list) and c and c[0].get("type") == "tool_result" \
                and c[0].get("tool_use_id") == "t0":
            c[0]["content"] = t0_text16
        exp16.append(m2)
    add(
        "duplicate_tool_result_ids",
        "t0 的 tool_result 出现两份 (同 id) — 官方候选取两份 → tokensSaved "
        "计两份、persist 调两次 (E 覆盖同 id); CCH blocksById 首份、persist "
        "一次 — 内容对齐但 tokensSaved/persistCalls 预期分歧行",
        None, {"t0": t0_text16},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": t0_text16},
         "persistCalls": ["t0", "t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 100000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=100000, r=5)},
        messages_override=msgs16,
    )
    vectors[-1]["expected"]["messages_json"] = exp16

    # ── 17. artifact 标记 → 官方 Tt 包装占位 (仅消息内容); CCH 无包装 ──
    marked = ARTIFACT_MARKER + "\n" + BIG
    pairs17 = [("t0", "Read", marked)] + \
              [(f"t{i}", "Read", BIG) for i in range(1, 6)]
    # 官方 lMo 返回的 clearedContent=E 是未包装 persist 文本 (:4544 return
    # clearedContent:E); Tt 包装只存在于 EFt 生成的 messages 占位内容里。
    t0_cc17 = persisted_text(marked, "t0", "success")
    t0_msg17 = TT_PREFIX + t0_cc17
    g17 = hl(marked)
    vec17 = add(
        "artifact_marker_tt_wrap",
        "t0 内容含 artifact-authored-by-others 标记 — 官方 EFt 给消息中的替换"
        "文本加 Tt 前缀 (_ALL.js:4544 !E&&!k.startsWith(Tt)&&Nl(...)?Tt+k:k);"
        " clearedContent(E) 本身不带包装; CCH 无此包装 → 消息级字面量分歧行",
        pairs17, {"t0": t0_cc17},
        {"declined": False, "clearedIds": ["t0"],
         "clearedContent": {"t0": t0_cc17}, "persistCalls": ["t0"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": g17, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=g17, r=5)},
    )
    # 期望消息: t0 块内容 = Tt 前缀 + persist 模板
    exp17 = []
    for m in session(pairs17):
        m2 = json.loads(json.dumps(m))
        c = (m2.get("message") or {}).get("content")
        if isinstance(c, list) and c and c[0].get("type") == "tool_result" \
                and c[0].get("tool_use_id") == "t0":
            c[0]["content"] = t0_msg17
        exp17.append(m2)
    vec17["expected"]["messages_json"] = exp17

    # ── 18. Tt+裸字面量: 官方 zl 识别为已清除; CCH 会再清 (分歧) ─────
    tt_cleared = TT_PREFIX + PLACEHOLDER
    pairs18 = [("t0", "Read", tt_cleared), ("t1", "Read", "__BIG_200K_A__")] + \
              [(f"t{i}", "Read", "__BIG_200K_A__") for i in range(2, 7)]
    t1_text18 = persisted_text(BIG, "t1", "success")
    add(
        "tt_prefixed_literal_official_skips",
        "t0 为 Tt+裸字面量 (官方 Tt 包装留下的已清除形态) — 官方 zl 剥 Tt 后"
        "识别为已清除 → 跳过; CCH 只认裸等值/持久化前缀 → 当活候选再清 → "
        "预期分歧行",
        pairs18, {"t1": t1_text18},
        {"declined": False, "clearedIds": ["t1"],
         "clearedContent": {"t1": t1_text18}, "persistCalls": ["t1"],
         "toolsCleared": 1, "toolsKept": 5, "keepRecent": 5,
         "tokensSaved": 50000, "trigger": "context_hint",
         "placeholder": PLACEHOLDER,
         "log": KEEP_RECENT_LOG.format(n=1, g=50000, r=5)},
    )

    return vectors


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit-fixture", action="store_true")
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--out", default=os.path.join(
        here, "..", "..", "tests", "fixtures", "pyref",
        "microcompact_vectors.json"))
    args = ap.parse_args()

    vectors = build_vectors()
    fixture = {
        "_description": (
            "MEMORY_PROJECTION 对拍向量: 官方 2.1.284 time-based microcompact "
            "(tool_result_clear keep-recent) 参考模型期望输出。由 "
            "scripts/pyref/official_microcompact.py --emit-fixture 生成; "
            "scripts/pyref/compare_cch.py 用 CCH 静态转写模型逐字段对拍。"),
        "_sourceMap": {
            "keepRecent": "_ALL.js:4544 En.keepToolUses=5; :28781 k=5",
            "whitelist": "_ALL.js:4544 bt (9 工具)",
            "threshold": "_ALL.js:4544 mun=20000 (g<mun 整体放弃)",
            "placeholder": "_ALL.js:4544 Ct",
            "persistTemplate": "_ALL.js:6846-6855 Oee/Rge",
            "telemetry": "_ALL.js:4544 tengu_time_based_microcompact",
            "idle": "_ALL.js:4544 En (minIdleSeconds 3900 等)",
            "retry": "_ALL.js:10605 retry:context-hint + onHintCleared",
        },
        "vectors": vectors,
    }
    if args.emit_fixture:
        out = os.path.normpath(os.path.join(os.path.dirname(args.out), "."
                                            )) if False else args.out
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(fixture, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"wrote {os.path.abspath(out)} ({len(vectors)} vectors)")
    else:
        print(json.dumps(fixture, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
