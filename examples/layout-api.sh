#!/usr/bin/env bash
# 相邻未锁定字幕时间分配（自动重排）调用示例。
#
# 本轮修复：自动重排时前一条字幕默认只覆盖自身词时段，确需延长时优先**向前**
# 借用空闲间隙，而不是一味向后顶到后一条首词开始、挤占后一条在镜头切点前的
# 显示时间——能排出的不再误报时长冲突；确实无解时仍按词段返回 422 duration
# 冲突且现有字幕不变。成功重排沿用既有约定：词区间相同的行保留 ID，文本/时间
# 变化的行行版本 +1（译文转待复核），消失行删除、新行新 ID；归属与逐词区间
# 复核意见按词区间同步，锁定行原样保留。
#
# 依赖：bash + curl + python3（仅用于解析 JSON）。
# 用法：
#   bash examples/layout-api.sh [BASE_URL]
# 例如：bash examples/layout-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }
show_cues() { python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in d["subtitles"]:
    print("  id={id} v{version} 词{word_start} [{start_ms},{end_ms}] \"{text}\" locked={locked}".format(**s))'; }

echo "=== 0. 新建项目：词 A[1000,1100]、B[1500,1600]，1700ms 切点 ==="
echo "规则：每条最多 1 字、最短 600ms、字速上限 100；字幕集版本 sub_version 从 0 起"
out="$(req POST /api/projects '{
  "name":"相邻字幕时间分配 API 示例",
  "words":[
    {"text":"A","start_ms":1000,"end_ms":1100},
    {"text":"B","start_ms":1500,"end_ms":1600}
  ],
  "cuts":[1700],
  "rules":{"max_chars":1,"min_duration_ms":600,"max_cps":100}
}')"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"

echo
echo "=== 1. 重排（POST /layout，携带 sub_version）→ 200 ==="
echo "期望：A[500,1100]、B[1100,1700]——A 向前借到 500，把切点前的空间留给 B"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
echo "HTTP $(echo "$out" | code_of)，新 sub_version=$(echo "$out" | body_of | jget sub_version)"
echo "$out" | body_of | show_cues
SID_A="$(echo "$out" | body_of | jget subtitles.0.id)"
SID_B="$(echo "$out" | body_of | jget subtitles.1.id)"
VER_A="$(echo "$out" | body_of | jget subtitles.0.version)"

echo
echo "=== 2. 再次重排结果幂等：时间未变的行保留 ID 与行版本 ==="
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":1}')"
echo "HTTP $(echo "$out" | code_of)；A 仍为 id=$SID_A v$(echo "$out" | body_of | jget subtitles.0.version)"

echo
echo "=== 3. 行身份与译文联动：给 A 存译文 → 放宽最短时长 → 重排（行 ID 不变、行版本 +1） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID_A" \
  "{\"text\":\"X\",\"cue_version\":$VER_A,\"version\":0}" >/dev/null
echo "已为 A 保存 en 译文 \"X\"（cue_version=$VER_A；译文仍受 max_chars=1 限制）"
# 最短时长 600→500：A 从 [500,1100] 变为 [700,1200]、B 变为 [1200,1700]（仍可行，故不冲突）
# 注：改规则只推进规则版本、不推进字幕集版本；但每次重排都会推进 sub_version
# （上一步幂等重排已 1→2），故此步携带 2
req PUT "/api/projects/$PID/rules" '{"version":1,"max_chars":1,"min_duration_ms":500,"max_cps":100}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":2}')"
echo "HTTP $(echo "$out" | code_of)（词区间不变 → 行 ID 沿用；时间变化 → 行版本 +1）"
echo "$out" | body_of | show_cues
echo "A 行 id 沿用：实际 $(echo "$out" | body_of | jget subtitles.0.id)，期望 $SID_A"
echo "并列查询译文：A 源行时间已变 → review 待复核；B 无译文 → missing"
req GET "/api/projects/$PID/translations/en" | body_of | python3 -c '
import json,sys
for e in json.load(sys.stdin)["entries"]:
    t=e["translation"]
    extra=(" 译文 v{0}".format(t["version"]) if t else "")
    print("  词{0}: {1}{2}".format(e["cue"]["word_start"], e["state"], extra))'

echo
echo "=== 4. 锁定行原样保留：锁定 B 在 [1200,1700]，恢复最短 600ms 后重排 ==="
VER_B="$(echo "$out" | body_of | jget subtitles.1.version)"
req PATCH "/api/projects/$PID/subtitles/$SID_B" "{\"version\":$VER_B,\"locked\":true}" >/dev/null
req PUT "/api/projects/$PID/rules" '{"version":2,"max_chars":1,"min_duration_ms":600,"max_cps":100}' >/dev/null
# 上一步重排 2→3，PATCH 锁定 3→4，改规则不推进，故此步携带 4
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":4}')"
echo "HTTP $(echo "$out" | code_of)（锁定 B 时间一个毫秒都不变，只重排未锁定的 A）"
echo "$out" | body_of | show_cues

echo
echo "=== 5. 确实无解：两条锁定字幕把单词夹在 200ms 内（最短 600ms）→ 422，现有字幕不变 ==="
out="$(req POST /api/projects '{
  "name":"相邻字幕时间分配-无解示例",
  "words":[
    {"text":"甲","start_ms":0,"end_ms":300},
    {"text":"挤","start_ms":1050,"end_ms":1150},
    {"text":"乙","start_ms":2000,"end_ms":2300}
  ],
  "cuts":[],
  "rules":{"max_chars":1,"min_duration_ms":0,"max_cps":100}
}')"
PID2="$(echo "$out" | body_of | jget id)"
out="$(req POST "/api/projects/$PID2/layout" '{"sub_version":0}')"
L1="$(echo "$out" | body_of | jget subtitles.0.id)"
L2="$(echo "$out" | body_of | jget subtitles.2.id)"
# 初始行时间为 甲[0,300] / 挤[1050,1150] / 乙[2000,2300]，逐条 PATCH 改时间+锁定
# （相邻行编辑互不重叠，校验通过）：夹出 1000..1200 的 200ms 空档
req PATCH "/api/projects/$PID2/subtitles/$L1" \
  '{"version":1,"start_ms":0,"end_ms":1000,"locked":true}' >/dev/null
req PATCH "/api/projects/$PID2/subtitles/$L2" \
  '{"version":1,"start_ms":1200,"end_ms":2400,"locked":true}' >/dev/null
# 现行规则恢复最短 600ms（规则 v1→v2，不推进字幕集版本）后重排：
# 中间词段只有 200ms，必报 duration；字幕集版本 = 排版1→PATCH2→PATCH3
req PUT "/api/projects/$PID2/rules" '{"version":1,"max_chars":1,"min_duration_ms":600,"max_cps":100}' >/dev/null
out="$(req POST "/api/projects/$PID2/layout" '{"sub_version":3}')"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(" ", d["error"])
for c in d["conflicts"]:
    print("  {type} 词段[{a}..{b}]：{m}".format(
        type=c["type"], a=c["word_start"], b=c["word_end"], m=c["message"]))'
echo "现有字幕未改动（GET 复核，锁定两行仍为手工时间）："
req GET "/api/projects/$PID2" | body_of | python3 -c '
import json,sys
for s in json.load(sys.stdin)["subtitles"]:
    print("  id={id} [{start_ms},{end_ms}] locked={locked}".format(**s))'

echo
echo "完成。"
