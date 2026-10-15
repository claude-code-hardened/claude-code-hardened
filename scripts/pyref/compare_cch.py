#!/usr/bin/env python3
"""CCH MEMORY_PROJECTION (clearToolResultProjection) 的静态转写模型 ——
读码转写 (把 TS 实现的规则逐句翻译为 Python), 不执行 CCH 代码 ——
然后用与 scripts/pyref/official_microcompact.py 同型的输出逐字段对拍。

CCH 源码出处 (src/services/compact/microCompact.ts 下称 MC.ts;
src/utils/toolResultStorage.ts 下称 TRS.ts; src/query.ts 下称 Q.ts):
  MC.ts:42        TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
  MC.ts:38,148-157 IMAGE_MAX_TOKEN_SIZE = 2000; 已有 calculateToolResultTokens
                  (legacy 时间路径/估算仍用; 投影改用 :795 官方 Hl 镜像)
  MC.ts:41-50     COMPACTABLE_TOOLS (Read/SHELL[Bash,PowerShell]/Grep/Glob/
                  WebSearch/WebFetch/Edit/Write) —— 与官方 9 工具白名单一致
  MC.ts:138-157   calculateToolResultTokens (string→countTokensPrecise→
                  roughTokenCountEstimation=len/4, tokenEstimation.ts:217-222)
  MC.ts:237-252   collectCompactableToolIds
  MC.ts:260-262   isMainThreadSource (前缀匹配; 831 行还要求 querySource 真值)
  MC.ts:620-645   KEEP_TOOL_USES=5 / MIN_TOKENS_SAVED=20000 (官方 mun,
                  严格 g<mun 才放弃, 恰 20000 放行) / MIN_IDLE_MS=3_900_000 /
                  MIN_TOTAL_TOOL_USES=20 / MIN_CLEARABLE=3 /
                  Tt 前缀+Ym 标记 (_ALL.js:372)
  MC.ts:682-696   collectTotalToolUseCount (全部 tool_use, 不分白名单)
  MC.ts:698-744   hasImageOrDocumentBlock (参数放宽) + isProjectionCleared
                  (官方 :4544 zl —— 剥 Tt 前缀后 ==Ct 或 startswith
                  <persisted-output>; 仅字符串) + contentIncludesArtifactMarker
                  (官方 Nl)
  MC.ts:750-812   官方 Hl/Rn 镜像 projectionToolResultTokens: string→Cd=
                  len/4; text→Cd; image→2000; document→Rn 源语义 (source.text
                  →Cd(data, title 扩展 json/jsonl/jsonc→2 其余 4);
                  source.content→逐块; 其余→2000)
  MC.ts:823-846   门 (querySource 真值 + repl_main_thread 前缀) +
                  keepSet slice(-5) + clearIdSet
  MC.ts:848-888   read_paths_by_id (仅 Read) + PLr 预览候选: 每个窗外且非
                  zl 的 tool_result 块 (零 token 不剔除, 同 id 多份按块计)
  MC.ts:890-901   官方唯一一道门: grossTokens(=ΣHl 预览, 预持久化)<20000 →
                  放弃 (原 CCH :837-844 净额第二道门已删除 —— 2.13 修复①)
  MC.ts:903-921   idleAdmitted 仅遥测 (gapMs>3.9e6 && total>=20 && cand>=3)
  MC.ts:923-946   官方 lMo persist 相: content 真值即调 persist (image/
                  document 数组恒真也调, 非 text 块在 persist 处失败回退;
                  空串/无 content 跳过) → E[id]=P??Ct —— 原 visual 先分流
                  不调 persist 的次序已对齐 (2.13 修复②)
  MC.ts:948-996   官方 :4544 EFt 投影: visual→裸字面量; 否则 E[id];
                  原内容含 Ym 且替换未带 Tt 前缀 → Tt+替换 (:972-978,
                  2.13 修复③); 与替换逐字节相同的块不动; 净额仅 debug 日志
  MC.ts:998-1041  readFileStatePaths (仅 Read 输入, 官方 UI 契约移植) +
                  tengu_memory_projection_clear 遥测 (tokensSaved=gross
                  预览口径, 同官方 g) + [MEMORY_PROJECTION] 日志
  TRS.ts:31-35    PERSISTED_OUTPUT_TAG / CLOSING_TAG
  TRS.ts:110      PREVIEW_SIZE_BYTES=2000
  TRS.ts:138-185  persistToolResult (json=Array.isArray; 非 text 块→error;
                  wx/EEXIST 复用; preview)
  TRS.ts:190-200  buildLargeToolResultMessage (与官方 Rge :6851-6857 同构)
  TRS.ts:340-357  generatePreview
  Q.ts:608-651    接入: microcompact→projection 同步 mutableMessages +
                  readFileState 释放 (客户端清除, 无服务端 422/424 往返)
Q.ts:634-651      feature('MEMORY_PROJECTION') 灰度多一路短路

已知结构性偏离 (对拍报告标注为 DESIGN, 不计入分歧):
  ①官方: 附 context-hint beta → 服务端 422/424 拒绝 → lMo 清除 →
    retry:context-hint + hint_clears 事件 (/_ALL.js:28781,10605,17906);
  CCH: 无服务端往返, 直接客户端投影 + 同步替换 (Q.ts:633-651)。
  ②官方 flag=tengu_hazel_osprey 控制整个控制器; CCH 由 feature flag 在
  microcompactMessages 入口红度短路, legacy time-based/cached-MC 走原路。

用法: python3 scripts/pyref/compare_cch.py [--fixture PATH] [--out PATH]
"""

from __future__ import annotations

import argparse
import copy
import datetime
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import official_microcompact as om  # noqa: E402

# ---------------------------------------------------------------------------
# CCH 常量转写
# ---------------------------------------------------------------------------

CCH_LITERAL = "[Old tool result content cleared]"       # MC.ts:36
CCH_PERSIST_TAG = "<persisted-output>"                  # TRS.ts:31
CCH_PERSIST_CLOSE = "</persisted-output>"               # TRS.ts:32
CCH_KEEP = 5                                            # MC.ts:621
CCH_MIN_TOKENS = 20_000                                 # MC.ts:628
CCH_MIN_IDLE_MS = 3_900_000                             # MC.ts:631
CCH_MIN_TOTAL_TOOL_USES = 20                            # MC.ts:634
CCH_MIN_CLEARABLE = 3                                   # MC.ts:637
CCH_IMAGE_TOKENS = 2000                                 # MC.ts:38
CCH_PREVIEW_BYTES = 2000                                # TRS.ts:110
CCH_TELEMETRY = "tengu_memory_projection_clear"         # MC.ts:1006
# 官方 Tt/Ym (_ALL.js:372) → MC.ts ARTIFACT_CONTENT_MARKER_PREFIX / MARKER
CCH_TT_PREFIX = "<artifact-content-authored-by-others/>\n"
CCH_ARTIFACT_MARKER = "<artifact-content-authored-by-others/>"
CCH_COMPACTABLE = {"Read", "Bash", "PowerShell", "Grep", "Glob",
                   "WebSearch", "WebFetch", "Edit", "Write"}   # MC.ts:41-50
CCH_LOG = ("[MEMORY_PROJECTION] cleared {n} tool results "
           "(~{g} tokens, net {net}, idle={idle}), kept last 5")


# ---------------------------------------------------------------------------
# CCH 规则转写
# ---------------------------------------------------------------------------

def _js_truthy(v):
    if v is None or v is False:
        return False
    if isinstance(v, str):
        return v != ""
    if isinstance(v, (int, float)):
        return v != 0
    return True


def cch_cd(text, n=4):
    # MC.ts→tokenEstimation.ts:217-222 roughTokenCountEstimation
    # Math.round(len/4) (TOKEN_COUNT_NATIVE 关闭时)
    if not isinstance(text, str):
        return 0
    return int(math.floor(len(text) / n + 0.5))


def cch_calculate_tool_result_tokens(block):
    # MC.ts:138-157
    content = block.get("content")
    if not _js_truthy(content):
        return 0
    if isinstance(content, str):
        return cch_cd(content)
    if not isinstance(content, list):
        return 0
    total = 0
    for item in content:
        if isinstance(item, str):
            total += cch_cd(item)
            continue
        if not isinstance(item, dict):
            continue
        t = item.get("type")
        if t == "text":
            total += cch_cd(item.get("text", ""))
        elif t in ("image", "document"):
            total += CCH_IMAGE_TOKENS      # MC.ts:151-153 (document 也 2000)
    return total


def cch_collect_compactable_ids(messages):
    # MC.ts:237-252
    ids = []
    for msg in messages:
        if msg.get("type") != "assistant":
            continue
        content = (msg.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use" \
                    and b.get("name") in CCH_COMPACTABLE:
                ids.append(b.get("id"))
    return ids


def cch_has_image_or_document(content):
    # MC.ts:698-705
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") in ("image", "document")
        for b in content)


def cch_is_already_cleared(content):
    # MC.ts:714-725 (官方 :4544 zl —— 剥可选 Tt 前缀后 ==Ct 或
    # startswith(<persisted-output>); 仅字符串参与)
    if not isinstance(content, str):
        return False
    body = content[len(CCH_TT_PREFIX):] \
        if content.startswith(CCH_TT_PREFIX) else content
    return body == CCH_LITERAL or body.startswith(CCH_PERSIST_TAG)


def cch_includes_marker(content):
    # MC.ts:731-744 (官方 :4544 Nl —— content 含 Ym 标记: 字符串或 text 块)
    if isinstance(content, str):
        return CCH_ARTIFACT_MARKER in content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" \
                    and isinstance(b.get("text"), str) \
                    and CCH_ARTIFACT_MARKER in b["text"]:
                return True
    return False


def cch_title_ext_divisor(title):
    # MC.ts:750-759 (官方 tr :4440 —— title 扩展名 json/jsonl/jsonc → 2)
    if isinstance(title, str) and "." in title:
        ext = title.rsplit(".", 1)[-1].lower()
        return 2 if ext in ("json", "jsonl", "jsonc") else 4
    return 4


def cch_document_tokens(block):
    # MC.ts:767-788 (官方 dec0043 Rn —— document 块估算)
    source = block.get("source")
    if isinstance(source, dict) and source.get("type") == "text":
        return cch_cd(str(source.get("data", "")),
                      cch_title_ext_divisor(block.get("title")))
    if isinstance(source, dict) and source.get("type") == "content":
        inner = source.get("content")
        if isinstance(inner, str):
            return cch_cd(inner)
        if isinstance(inner, list):
            return sum(
                cch_cd(b.get("text", ""))
                if isinstance(b, dict) and b.get("type") == "text"
                else CCH_IMAGE_TOKENS
                for b in inner if isinstance(b, dict))
    return CCH_IMAGE_TOKENS


def cch_projection_tokens(content):
    # MC.ts:795-812 (官方 :4544 Hl —— 预览/门槛的 tool_result 估算)
    if not _js_truthy(content):
        return 0
    if isinstance(content, str):
        return cch_cd(content)
    if not isinstance(content, list):
        return 0
    total = 0
    for b in content:
        if isinstance(b, str):
            total += cch_cd(b)
            continue
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            total += cch_cd(b.get("text", ""))
        elif t == "image":
            total += CCH_IMAGE_TOKENS
        elif t == "document":
            total += cch_document_tokens(b)
    return total


def cch_generate_preview(content, max_bytes):
    # TRS.ts:340-357
    if len(content) <= max_bytes:
        return content, False
    truncated = content[:max_bytes]
    last_nl = truncated.rfind("\n")
    cut = last_nl if last_nl > max_bytes * 0.5 else max_bytes
    return content[:cut], True


def cch_format_size(n):
    # src/utils/format.ts:9-23
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


def cch_build_large_tool_result_message(result):
    # TRS.ts:190-200 (与官方 Rge :6851-6857 逐字节同构)
    msg = CCH_PERSIST_TAG + "\n"
    msg += (f"Output too large ({cch_format_size(result['originalSize'])}). "
            f"Full output saved to: {result['filepath']}\n\n")
    msg += f"Preview (first {cch_format_size(CCH_PREVIEW_BYTES)}):\n"
    msg += result["preview"]
    msg += "\n...\n" if result["hasMore"] else "\n"
    msg += CCH_PERSIST_CLOSE
    return msg


def cch_persist(content, tool_use_id, mode="success"):
    # TRS.ts:138-185 (模拟磁盘; EEXIST 语义与此无关, 向量均为首写)
    if mode == "error":
        return {"error": "Permission denied: /tmp/tool-results"}
    is_json = isinstance(content, list)
    if is_json and any(not (isinstance(b, dict) and b.get("type") == "text")
                       for b in content):
        return {"error":
                "Cannot persist tool results containing non-text content"}
    content_str = json.dumps(content, indent=2) if is_json else content
    prev, more = cch_generate_preview(content_str, CCH_PREVIEW_BYTES)
    return {
        "filepath": f"/tmp/tool-results/{tool_use_id}."
                    + ("json" if is_json else "txt"),
        "originalSize": len(content_str),
        "isJson": is_json,
        "preview": prev,
        "hasMore": more,
    }


def cch_apply_clear(messages, query_source, now_ms, state=None):
    """CCH clearToolResultProjection (MC.ts:823-1043) 转写。
    返回 dict(CCH 结构) 或 None/declined-dict。"""
    st = dict(state or {})
    persist_mode = st.get("persist_mode", "success")

    # MC.ts:831-833
    if not _js_truthy(query_source) or not isinstance(query_source, str) \
            or not query_source.startswith("repl_main_thread"):
        return None

    # MC.ts:835-846
    compactable_ids = cch_collect_compactable_ids(messages)
    keep_set = set(compactable_ids[-CCH_KEEP:])
    clear_id_set = set(i for i in compactable_ids if i not in keep_set)
    if not clear_id_set:
        return None

    # MC.ts:682-696
    total_tool_uses = 0
    for msg in messages:
        if msg.get("type") == "assistant":
            content = (msg.get("message") or {}).get("content") or []
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    total_tool_uses += 1

    # MC.ts:848-866 (仅 Read 输入的 file_path 索引)
    read_paths_by_id = {}
    for msg in messages:
        content = (msg.get("message") or {}).get("content")
        if msg.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use" \
                        and b.get("name") == "Read":
                    inp = b.get("input")
                    fp = inp.get("file_path") if isinstance(inp, dict) else None
                    if isinstance(fp, str):
                        read_paths_by_id[b.get("id")] = fp

    # MC.ts:868-888 — 官方 PLr 预览: 每个窗外且非 zl 的 tool_result 块都是
    # 候选 (零 token 不剔除、同 id 多份按块计)。
    candidates = []
    for msg in messages:
        if msg.get("type") != "user":
            continue
        content = (msg.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_result":
                continue
            if b.get("tool_use_id") not in clear_id_set:
                continue
            if cch_is_already_cleared(b.get("content")):
                continue
            candidates.append(b)

    if not candidates:                                   # MC.ts:886-888
        return None

    # MC.ts:890-901 — 官方唯一一道门 :4544 `g < mun` (严格小于, 预持久化的
    # gross 预览 Σ Hl); 恰 20000 放行。原净额第二道门已删除。
    gross_tokens = sum(cch_projection_tokens(b.get("content"))
                       for b in candidates)
    if gross_tokens < CCH_MIN_TOKENS:
        return {"declined": True, "reason": "gross_below_min",
                "grossTokens": gross_tokens}

    # MC.ts:903-915 (仅遥测)
    last_asst = None
    for msg in messages:
        if msg.get("type") == "assistant":
            last_asst = msg
    gap_ms = float("inf")
    finite = False
    if last_asst is not None:
        ts = last_asst.get("timestamp")
        try:
            gap_ms = now_ms - datetime.datetime.fromisoformat(
                ts.replace("Z", "+00:00")).timestamp() * 1000
            finite = math.isfinite(gap_ms)
        except Exception:
            pass
    idle_admitted = bool(finite and gap_ms > CCH_MIN_IDLE_MS
                         and total_tool_uses >= CCH_MIN_TOTAL_TOOL_USES
                         and len(candidates) >= CCH_MIN_CLEARABLE)

    # MC.ts:923-946 — 官方 lMo persist 相: content 真值即调 persist (image/
    # document 数组恒真也调, 非 text 块在 persist 处失败回退; 空串跳过),
    # E[id] = P ?? Ct。
    content_by_id = {}
    persist_calls = []
    for cand in candidates:
        cid = cand.get("tool_use_id")
        content = cand.get("content")
        if _js_truthy(content):
            persist_calls.append(cid)
            persisted = cch_persist(content, cid, persist_mode)
            if "error" in persisted:                     # MC.ts:936-938
                content_by_id[cid] = CCH_LITERAL
            else:                                        # MC.ts:934-939
                content_by_id[cid] = cch_build_large_tool_result_message(
                    persisted)
        else:
            content_by_id[cid] = CCH_LITERAL

    # MC.ts:948-992 — 官方 :4544 EFt 投影: visual → 裸字面量; 否则 E[id];
    # 原内容含 Ym 标记且替换文本未带 Tt 前缀 → Tt+替换; 与替换逐字节相同
    # 的块不动。
    cleared_replacements = {}
    net_tokens_saved = 0
    projection = []
    for msg in messages:
        content = (msg.get("message") or {}).get("content")
        if msg.get("type") != "user" or not isinstance(content, list):
            projection.append(msg)
            continue
        touched = False
        new_blocks = []
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_result" \
                    or b.get("tool_use_id") not in content_by_id:
                new_blocks.append(b)
                continue
            visual = cch_has_image_or_document(b.get("content"))
            if visual:
                rep = CCH_LITERAL
            else:
                rep = content_by_id.get(b.get("tool_use_id")) or CCH_LITERAL
            if not visual and not rep.startswith(CCH_TT_PREFIX) \
                    and cch_includes_marker(b.get("content")):
                rep = CCH_TT_PREFIX + rep
            if b.get("content") == rep:
                new_blocks.append(b)
                continue
            touched = True
            net_tokens_saved += cch_projection_tokens(b.get("content")) \
                - cch_projection_tokens(rep)
            cleared_replacements[b.get("tool_use_id")] = rep
            nb = dict(b)
            nb["content"] = rep
            new_blocks.append(nb)
        if touched:
            m2 = dict(msg)
            m2["message"] = dict(msg.get("message") or {})
            m2["message"]["content"] = new_blocks
            projection.append(m2)
        else:
            projection.append(msg)

    if not cleared_replacements:                         # MC.ts:994-996
        return None

    return {
        "declined": False,
        "clearedToolUseIds": list(cleared_replacements.keys()),
        "clearedReplacements": cleared_replacements,
        "messages": projection,
        "telemetry": CCH_TELEMETRY,
        "telemetryPayload": {
            "toolsCleared": len(cleared_replacements),
            "toolsKept": min(len(compactable_ids), CCH_KEEP),
            "totalToolUses": total_tool_uses,
            "tokensSaved": gross_tokens,   # 官方 :4544 gross 预览口径 (g)
            "grossTokens": gross_tokens,
            "idleAdmitted": idle_admitted,
            "gapMinutes": (None if not finite else round(gap_ms / 60_000)),
        },
        "log": CCH_LOG.format(n=len(cleared_replacements), g=gross_tokens,
                              net=net_tokens_saved, idle=idle_admitted),
        "keepRecent": CCH_KEEP,
        "persistCalls": persist_calls,
        "readFileStatePaths": [read_paths_by_id[i]
                               for i in cleared_replacements
                               if i in read_paths_by_id],
    }


# ---------------------------------------------------------------------------
# 对拍
# ---------------------------------------------------------------------------

EVIDENCE = {
    "declined": "官方 :28781 G()(includeFirstPartyBetas/repl_main_thread/"
                "flag) + :4544 g<mun (严格小于, 恰 20000 放行); CCH "
                "MC.ts:823/841/895-901 (净额第二道门已删除)",
    "clearedIds": "官方 :4544 PLr/slice(-5)/S=候选ids(zl 排除已清除); CCH "
                  "MC.ts:868-888 (zl :714-725, 零 token 不剔除, 重复块按块计)",
    "clearedContent": "官方 :4544 lMo E.set(P??Ct); CCH MC.ts:923-946; "
                       "模板 官方:6851-6857 / CCH TRS.ts:190-200",
    "placeholder": "同 clearedContent; EFt Tt 包装见 messages 行",
    "messages": "官方 :4544 EFt (visual→Ct / E[id] / Tt 包装: "
                "!E&&!k.startsWith(Tt)&&Nl→Tt+k); CCH MC.ts:955-992 "
                "(包装 :972-978)",
    "toolsCleared": "官方 :4544 S.size; CCH MC.ts:1012 "
                    "len(clearedReplacements) (候选 id 均有替换, 同值)",
    "toolsKept": "官方 :4544 r.size; CCH MC.ts:1014-1017",
    "keepRecent": "官方 En.keepToolUses=5; CCH MC.ts:621",
    "tokensSaved": "官方 :4544 g=PLr 预览ΣHl (gross, 不减替换文本); CCH "
                   "MC.ts:895-901 同口径 gross (Σ :795-812, Hl/Rn 镜像), "
                   "净额仅 debug 日志 (:954/981-983), 净额第二道门已删除",
    "trigger": "官方 :4544 trigger:'context_hint'; CCH 遥测无此字段",
    "telemetryEvent": "官方 tengu_time_based_microcompact; CCH "
                      "tengu_memory_projection_clear (仅命名)",
    "log": "官方 [KEEP-RECENT MC] ...; CCH [MEMORY_PROJECTION] ... (仅命名)",
    "persistCalls": "官方 :4544 content 真值即调 persist (空串跳过/image数组"
                    "恒真仍调, 非 text 块在 persist 处失败回退); CCH 已对齐 "
                    "(MC.ts:923-946, 真值分流在 visual 判定之前)",
}

# 历史分歧分类映射 (2.13 修复后不应再触发, 保留仅为回归防御: 若三处修复
# 回退, 这些向量会按原样分类)。修复内容见 compare_report.json rows 与
# memoryProjection.test.ts 边界断言:
#   artifact_marker_tt_wrap        → LITERAL: EFt Tt 包装 (MC.ts:972-978)
#   empty_string_candidate_...     → SEMANTIC: 候选不剔零 token (MC.ts:868-888)
#   tt_prefixed_literal_...        → SEMANTIC: zl 剥 Tt (MC.ts:714-725)
MSG_DIVERGENCE_CLASS = {
    "artifact_marker_tt_wrap": "LITERAL",
    "empty_string_candidate_official_clears": "SEMANTIC",
    "tt_prefixed_literal_official_skips": "SEMANTIC",
}
# 特定 (向量, 字段) 分类覆盖 (同上, 修复后应为 ALIGNED, 覆盖不触发)
FIELD_OVERRIDE = {
    ("duplicate_tool_result_ids", "tokensSaved"): "SEMANTIC",
    ("duplicate_tool_result_ids", "persistCalls"): "SEMANTIC",
    ("image_block_bare_literal", "persistCalls"): "EDGE",
}


def dump(messages):
    return json.dumps(messages, ensure_ascii=False, sort_keys=True)


def projected_block_content(messages, cid):
    """取该 tool_use_id 在投影消息里的第一个 tool_result 块内容 (无则 None)。"""
    for msg in messages:
        content = (msg.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_result" \
                    and b.get("tool_use_id") == cid:
                return b.get("content")
    return None


def compare_vector(vec):
    name = vec["name"]
    # 大内容以标记存储, 载入即还原 (official_microcompact.SIZE_MARKERS)
    base_messages = om.expand_markers(copy.deepcopy(vec["messages"]))
    persist_mode = vec.get("persistMode", "success")
    now = vec.get("nowMs", 0.0)
    qs = vec.get("querySource", "repl_main_thread")
    exp_msgs_json = vec.get("messages_json")
    if exp_msgs_json is not None:
        exp_msgs_json = om.expand_markers(exp_msgs_json)

    off_msgs, off = om.apply_clear(copy.deepcopy(base_messages), now,
                                   {"query_source": qs,
                                    "persist_mode": persist_mode})
    off_decl = off["declined"]

    # fixture 自检 (官方模型 vs fixture 期望)
    exp = vec["expected"]
    selfcheck = []
    if off_decl != exp["declined"]:
        selfcheck.append("declined")
    if sorted(off["clearedIds"]) != sorted(exp["clearedIds"]):
        selfcheck.append("clearedIds")
    for cid, txt in (exp.get("clearedContent") or {}).items():
        if not off_decl and off["clearedContent"].get(cid) != txt:
            selfcheck.append(f"clearedContent[{cid}]")
    for k, v in (exp.get("report") or {}).items():
        if not off_decl and off.get(k) != v:
            selfcheck.append(f"report.{k}")
    if exp_msgs_json is not None and \
            dump(off_msgs) != dump(exp_msgs_json):
        selfcheck.append("messages_json")
    if sorted(off.get("persistCalls", [])) != \
            sorted(exp.get("persistCalls") or []):
        selfcheck.append("persistCalls")

    cch = cch_apply_clear(copy.deepcopy(base_messages), qs, now,
                          {"persist_mode": persist_mode})
    cch_decl = cch is None or cch.get("declined") is True

    rows = []

    def row(field, ov, cv, verdict, note=""):
        rows.append({"vector": name, "field": field, "official": ov,
                     "cch": cv, "verdict": verdict, "note": note,
                     "evidence": EVIDENCE.get(field, "")})

    # 1) 结果级
    row("declined", off_decl, cch_decl,
        "ALIGNED" if off_decl == cch_decl else "SEMANTIC",
        f"off_reason={off.get('decline_reason')} "
        f"cch_reason={'cleared' if not cch_decl else (cch or {}).get('reason')}")

    # 2) 消息级 (单侧放行 → 任何差异都是行为分歧)
    outcome_diverged = off_decl != cch_decl
    msg_diverged = False
    if not off_decl and not cch_decl:
        ids_union = sorted(set(off["clearedIds"])
                           | set(cch["clearedToolUseIds"]))
        if sorted(off["clearedIds"]) != sorted(cch["clearedToolUseIds"]):
            msg_diverged = True
            row("clearedIds", off["clearedIds"], cch["clearedToolUseIds"],
                MSG_DIVERGENCE_CLASS.get(name, "SEMANTIC"))
        else:
            row("clearedIds", off["clearedIds"], cch["clearedToolUseIds"],
                "ALIGNED")
        for cid in ids_union:
            # 口径同步: 官方 clearedContent(E) 是 lMo 的 P??Ct, 未含 EFt 的
            # Tt 包装 (包装只出现在 EFt 生成的消息内容里, _ALL.js:4544);
            # CCH 的 clearedReplacements 即投影消息内容本身
            # (syncProjectionToMutableMessages 逐字节复用)。占位符字段因此
            # 以双侧投影消息中的 tool_result 内容为准 (同位同字)。
            off_ph = projected_block_content(off_msgs, cid)
            cch_ph = projected_block_content(cch["messages"], cid)
            same = off_ph == cch_ph
            if not same:
                msg_diverged = True
            verdict = "ALIGNED" if same else \
                MSG_DIVERGENCE_CLASS.get(name, "SEMANTIC")
            note = "" if same else ""     # 修复后预期恒等位
            row(f"placeholder[{cid}]", off_ph, cch_ph, verdict, note)
        off_eq = dump(off_msgs) == dump(cch["messages"])
        if not off_eq:
            msg_diverged = True
        row("messages", off_eq, True,
            "ALIGNED" if off_eq else MSG_DIVERGENCE_CLASS.get(name,
                                                              "SEMANTIC"),
            "投影消息 JSON 全量比对"
            + ("" if off_eq else " (不一致)"))

    # 3) 报告字段
    def cmp_count(field, ov, cv):
        if off_decl and cch_decl:
            return
        if ov == cv:
            row(field, ov, cv, "ALIGNED")
        else:
            cls = "SEMANTIC" if (outcome_diverged or msg_diverged) \
                else FIELD_OVERRIDE.get((name, field), "SEMANTIC")
            row(field, ov, cv, cls)

    cmp_count("toolsCleared", 0 if off_decl else off["toolsCleared"],
              0 if cch_decl else cch["telemetryPayload"]["toolsCleared"])
    cmp_count("toolsKept", 0 if off_decl else off["toolsKept"],
              0 if cch_decl else cch["telemetryPayload"]["toolsKept"])
    if not (off_decl and cch_decl):
        row("keepRecent", off["keepRecent"],
            (cch or {}).get("keepRecent", CCH_KEEP),
            "ALIGNED" if off["keepRecent"] == CCH_KEEP else "SEMANTIC")

        off_ts = off["tokensSaved"]
        cch_ts = (cch or {}).get("telemetryPayload", {}).get("tokensSaved", 0)
        if off_ts == cch_ts:
            row("tokensSaved", off_ts, cch_ts, "ALIGNED")
        else:
            cls = "SEMANTIC" if (outcome_diverged or msg_diverged) else \
                FIELD_OVERRIDE.get((name, "tokensSaved"), "BASIS")
            note = ("口径差: 官方=预览ΣHl(gross); CCH 已同口径 gross "
                    "(净额仅 debug 日志, MC.ts:954/981-983)" if cls != "SEMANTIC"
                    else "导致结果分歧")
            row("tokensSaved", off_ts, cch_ts, cls, note)
        row("trigger", off["trigger"], None if cch_decl else "context_hint",
            "ALIGNED" if not cch_decl else "NAMING",
            "CCH 遥测无 trigger 字段" if cch_decl else "")
        row("telemetryEvent", om.TELEMETRY_EVENT,
            None if cch_decl else CCH_TELEMETRY,
            "ALIGNED" if not cch_decl else "NAMING",
            "事件名不同, 语义等价 (CCH 侧实为本地投影)")
        row("log", off["log"], (cch or {}).get("log"),
            "ALIGNED" if (off["log"] == (cch or {}).get("log")) else "NAMING",
            "日志串字面量不同 (官方 KEEP-RECENT MC)")
        row("persistCalls", sorted(off.get("persistCalls", [])),
            sorted((cch or {}).get("persistCalls", [])),
            "ALIGNED" if sorted(off.get("persistCalls", [])) ==
            sorted((cch or {}).get("persistCalls", []))
            else FIELD_OVERRIDE.get((name, "persistCalls"), "SEMANTIC"))

    # 4) CCH 独有遥测字段
    if cch and not cch_decl:
        for k in ("totalToolUses", "grossTokens", "idleAdmitted",
                  "gapMinutes"):
            rows.append({"vector": name, "field": f"cchOnly.{k}",
                         "official": None,
                         "cch": cch["telemetryPayload"].get(k),
                         "verdict": "NAMING",
                         "note": "CCH 遥测独有字段, 无行为影响",
                         "evidence": "CCH MC.ts:1002-1021"})
    return rows, selfcheck


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=os.path.join(
        HERE, "..", "..", "tests", "fixtures", "pyref",
        "microcompact_vectors.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "compare_report.json"))
    args = ap.parse_args()

    with open(os.path.abspath(args.fixture), encoding="utf-8") as f:
        fixture = json.load(f)

    all_rows = []
    selfchecks = {}
    for vec in fixture["vectors"]:
        rows, sc = compare_vector(vec)
        all_rows.extend(rows)
        selfchecks[vec["name"]] = sc

    diverged = [r for r in all_rows if r["verdict"] not in ("ALIGNED",)]
    by_class = {}
    for r in diverged:
        by_class.setdefault(r["verdict"], []).append(
            f"{r['vector']}:{r['field']}")

    report = {
        "generatedBy": "scripts/pyref/compare_cch.py",
        "fixture": os.path.abspath(args.fixture),
        "vectorsRun": len(fixture["vectors"]),
        "fieldsCompared": len(all_rows),
        "aligned": len(all_rows) - len(diverged),
        "diverged": len(diverged),
        "verdictLegend": {
            "SEMANTIC": "行为/语义分歧 (结果消息或放行决策不同)",
            "LITERAL": "字面量分歧 (占位文本差异, 行为路径相同位置)",
            "BASIS": "口径差 (tokensSaved 预览 vs 净额, 行为不受影响)",
            "NAMING": "仅命名/字段差异 (事件名、日志串、遥测字段)",
            "EDGE": "边缘路径差 (persist 调用次数等, 结果占位一致)",
        },
        "byVerdict": by_class,
        "fixtureSelfcheckFailures":
            {k: v for k, v in selfchecks.items() if v},
        "rows": all_rows,
    }
    out_path = os.path.abspath(args.out)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"vectors={report['vectorsRun']} fields={len(all_rows)} "
          f"aligned={report['aligned']} diverged={len(diverged)}")
    for vec in fixture["vectors"]:
        rows = [r for r in all_rows if r["vector"] == vec["name"]]
        bad = [r for r in rows if r["verdict"] not in ("ALIGNED",)]
        print(f"[{'OK    ' if not bad else 'DIFF  '}] {vec['name']}")
        for r in bad:
            print(f"         - {r['field']} [{r['verdict']}]")
            print(f"             official: {str(r['official'])[:90]}")
            print(f"             cch     : {str(r['cch'])[:90]}")
            if r["note"]:
                print(f"             note    : {r['note'][:150]}")
    failed = {k: v for k, v in selfchecks.items() if v}
    print("fixture selfcheck:", "PASS" if not failed else failed)
    print(f"report -> {out_path}")


if __name__ == "__main__":
    main()
