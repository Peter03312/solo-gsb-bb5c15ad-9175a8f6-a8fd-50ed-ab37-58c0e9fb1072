'use strict';

/**
 * 字幕排版引擎（纯函数，不依赖数据库）。
 *
 * 输入：
 *   words  : [{ idx, text, start_ms, end_ms }]  按 idx 升序、互不重叠（导入时已校验）
 *   cuts   : [ms, ...]                          镜头切点，升序
 *   rules  : { max_chars, min_duration_ms, max_cps }
 *   locked : [{ word_start, word_end, text, start_ms, end_ms }] 已锁定字幕（原样保留）
 *
 * 输出（二选一）：
 *   { ok: true,  cues: [{ word_start, word_end, text, start_ms, end_ms, locked }] } 按时间升序
 *   { ok: false, conflicts: [{ type, word_start, word_end, message }] }
 *
 * 硬性约束：
 *   1. 按原词序覆盖全部词，每词恰好属于一条字幕；
 *   2. 字幕互不重叠（允许首尾相接）；
 *   3. 字幕时段内部不得包含镜头切点；
 *   4. 不得缩短任何词本身的时段（字幕必须完整包含其所有词的时段）；
 *   5. 文本字数 <= max_chars；显示时长 >= min_duration_ms；字数/秒 <= max_cps。
 * 无法满足时返回冲突列表（受影响词段 + 冲突条件），绝不输出貌似完整的结果。
 */

// 中日韩字符范围：拼接词时 CJK 之间不加空格，西文词之间加空格
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

function needsSpace(prevLastChar, nextFirstChar) {
  return !CJK.test(prevLastChar) && !CJK.test(nextFirstChar);
}

function joinWords(texts) {
  let out = '';
  for (const t of texts) {
    if (!out) { out = t; continue; }
    out += needsSpace(out[out.length - 1], t[0]) ? ' ' + t : t;
  }
  return out;
}

function preview(words, a, b, max = 24) {
  const t = joinWords(words.slice(a, b + 1).map((w) => w.text));
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 第一个 end_ms >= c 的词下标；不存在则返回 words.length */
function firstWordWithEndGE(words, c) {
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end_ms >= c) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** <= t 的最大切点；无则 null */
function lastCutAtOrBelow(cuts, t) {
  let lo = 0, hi = cuts.length; // 找第一个 > t 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 ? cuts[lo - 1] : null;
}

/** >= t 的最小切点；无则 null */
function firstCutAtOrAbove(cuts, t) {
  let lo = 0, hi = cuts.length; // 找第一个 >= t 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] >= t) hi = mid; else lo = mid + 1;
  }
  return lo < cuts.length ? cuts[lo] : null;
}

/**
 * 由镜头切点计算强制断点与"切点落在词内"冲突。
 * 词 k 与 k+1 之间必须断开  <=>  存在切点 c 满足 end_k <= c <= start_{k+1}。
 * 若 start_k < c < end_k，则切点落在词 k 内部，任何含该词的字幕都会跨切点 → 冲突。
 */
function analyzeCuts(words, cuts, conflicts) {
  const forcedBreaks = new Set(); // 元素 k 表示词 k 与 k+1 之间必须断开
  const n = words.length;
  for (const c of cuts) {
    const k = firstWordWithEndGE(words, c);
    if (k >= n) continue; // 切点在全部词之后，无影响
    const w = words[k];
    if (w.start_ms < c && c < w.end_ms) {
      conflicts.push({
        type: 'cut_inside_word',
        word_start: k,
        word_end: k,
        message:
          `镜头切点 ${c}ms 落在词 "${w.text}" 的时段 [${w.start_ms}, ${w.end_ms}] 内部：` +
          `字幕不得跨镜头切点，也不得缩短词本身的时段，两个条件无法同时满足`,
      });
    } else if (c <= w.start_ms) {
      if (k >= 1) forcedBreaks.add(k - 1);
    } else {
      // c == w.end_ms（start < c <= end 且非内部，只可能等于 end）
      if (k + 1 <= n - 1) forcedBreaks.add(k);
    }
  }
  return forcedBreaks;
}

/** 在一个词区间 [a, b] 内按 max_chars 与强制断点做贪心最大装填切分 */
function segmentRegion(words, a, b, forcedBreaks, rules, conflicts) {
  const segs = [];
  let segStart = a;
  let curText = '';
  for (let k = a; k <= b; k++) {
    const wtext = words[k].text;
    if (wtext.length > rules.max_chars) {
      conflicts.push({
        type: 'max_chars',
        word_start: k,
        word_end: k,
        message:
          `词 "${wtext}" 本身长 ${wtext.length} 字，超过单条字幕最大字数 ${rules.max_chars}：` +
          `词不可拆分，无法同时满足"覆盖全部词"与"最大字数"两个条件`,
      });
    }
    const sep = curText && needsSpace(curText[curText.length - 1], wtext[0]) ? 1 : 0;
    if (curText !== '' &&
        (forcedBreaks.has(k - 1) || curText.length + sep + wtext.length > rules.max_chars)) {
      segs.push([segStart, k - 1]);
      segStart = k;
      curText = wtext;
    } else {
      curText = curText ? (sep ? curText + ' ' + wtext : curText + wtext) : wtext;
    }
  }
  if (segStart <= b) segs.push([segStart, b]);
  return segs;
}

/**
 * 为一个区域内的分段分配时间。
 * lowerBound / upperBound：区域两端由锁定字幕（或视频边界）给出的时间界限。
 *
 * 每条字幕 i 的需求时长 need_i = max(词段本身时长, 最短时长, 字速时长)，起点 S_i
 * 与终点 E_i = S_i + need_i 受以下约束：
 *   - 完整覆盖词时段：S_i <= 首词.start、E_i >= 末词.end（即 S_i >= 末词.end-need）；
 *   - 相邻不重叠（可首尾相接）：E_i <= S_{i+1}；
 *   - 不跨切点：右侧间隙切点 c 要求 E_i <= c，左侧间隙切点要求 S_i >= c；
 *   - 区域边界：S_0 >= lowerBound，E_末 <= upperBound。
 *
 * 这是一条区间链：先反向求出"后缀仍排得下的最迟起点" L_i（前一条若顶到 L_i
 * 之后就会挤占后一条在切点/边界前的显示时间），再正向求出"前缀放得下的最早
 * 起点" F_i。可行当且仅当每段 F_i <= L_i。
 *
 * 落点偏好：S_i = min(首词.start, L_i)——默认从首词开始、**优先向后延长**，
 * 只有向后会顶到后一条/切点（L_i < 首词.start）时才向前借，且只借到 L_i 为止，
 * 把剩余空闲间隙留给真正需要的后续字幕。
 */
function timeRegion(words, segs, cuts, rules, lowerBound, upperBound, conflicts) {
  const cues = [];

  // 1. 逐段计算需求时长
  const specs = segs.map(([p, q]) => {
    const text = joinWords(words.slice(p, q + 1).map((w) => w.text));
    const sDef = words[p].start_ms;
    const eDef = words[q].end_ms;
    const span = eDef - sDef;
    const cpsNeed = Math.ceil((text.length / rules.max_cps) * 1000);
    const need = Math.max(span, rules.min_duration_ms, cpsNeed);
    return { p, q, text, sDef, eDef, span, cpsNeed, need };
  });
  const m = specs.length;

  // 2. 反向求最迟起点 L_i：后缀（含本段）仍可行时 S_i 的最大值
  for (let i = m - 1; i >= 0; i--) {
    const g = specs[i];
    // S <= 首词开始（不得把起点推到首词之后）；末段不得越过区域上界/右侧切点
    let L = g.sDef;
    if (i === m - 1) L = Math.min(L, upperBound - g.need);
    const cutAbove = firstCutAtOrAbove(cuts, g.eDef);
    if (cutAbove !== null) L = Math.min(L, cutAbove - g.need);
    // E_i <= S_{i+1}：后一条起点本身 <= 其首词开始，且 <= L_{i+1}
    if (i + 1 < m) {
      L = Math.min(L, specs[i + 1].sDef - g.need, specs[i + 1].L - g.need);
    }
    g.L = L;
  }

  // 3. 正向求最早起点 F_i：前缀（含本段）可行时 S_i 的最小值；顺带检测无解
  let prevE = lowerBound;
  for (let i = 0; i < m; i++) {
    const g = specs[i];
    let F = Math.max(lowerBound, 0, g.eDef - g.need, prevE);
    const cutBelow = lastCutAtOrBelow(cuts, g.sDef);
    if (cutBelow !== null) F = Math.max(F, cutBelow);
    g.F = F;

    if (F > g.L) {
      // 该段在切点/相邻字幕/锁定边界夹出的空间内确实放不下
      const reasons = [];
      if (rules.min_duration_ms > g.span) reasons.push(`最短显示时长 ${rules.min_duration_ms}ms`);
      if (g.cpsNeed > g.span) {
        reasons.push(
          `每秒最多 ${rules.max_cps} 字（该段 ${g.text.length} 字 / ${(g.span / 1000).toFixed(2)}s` +
          ` = ${(g.text.length / (g.span / 1000)).toFixed(1)} 字/秒）`
        );
      }
      conflicts.push({
        type: 'duration',
        word_start: g.p,
        word_end: g.q,
        message:
          `词段 [${g.p}..${g.q}] "${preview(words, g.p, g.q)}" 需要至少 ${g.need}ms 才能满足` +
          `${reasons.join(' 与 ')}，但受相邻字幕/镜头切点限制，可用空间只有 ${Math.max(0, g.L + g.need - F)}ms`,
      });
    }

    // 落点：默认起于首词开始（优先向后延长）；会挤占后条/切点时前移到最迟可行点
    const S = Math.min(g.sDef, g.L);
    const E = S + g.need;
    cues.push({ word_start: g.p, word_end: g.q, text: g.text, start_ms: S, end_ms: E, locked: 0 });
    prevE = E;
  }
  return cues;
}

/**
 * 计算整版字幕。locked 中的字幕原样保留，只重排未锁定词段。
 */
function computeLayout({ words, cuts, rules, locked }) {
  const conflicts = [];
  const n = words.length;

  // 1. 锁定字幕自身一致性：词区间不相交、时间不重叠
  const lockedSorted = [...locked].sort((x, y) => x.word_start - y.word_start);
  for (let i = 0; i < lockedSorted.length; i++) {
    const L = lockedSorted[i];
    if (L.word_start < 0 || L.word_end >= n || L.word_start > L.word_end) {
      conflicts.push({
        type: 'locked_invalid', word_start: L.word_start, word_end: L.word_end,
        message: `锁定字幕覆盖的词区间 [${L.word_start}..${L.word_end}] 超出转写范围`,
      });
    }
    if (i > 0) {
      const P = lockedSorted[i - 1];
      if (L.word_start <= P.word_end) {
        conflicts.push({
          type: 'locked_overlap', word_start: L.word_start, word_end: L.word_end,
          message: `两条锁定字幕的词区间重叠：[${P.word_start}..${P.word_end}] 与 [${L.word_start}..${L.word_end}]`,
        });
      } else if (L.start_ms < P.end_ms) {
        conflicts.push({
          type: 'locked_overlap', word_start: L.word_start, word_end: L.word_end,
          message: `锁定字幕时间重叠：[${P.start_ms}, ${P.end_ms}] 与 [${L.start_ms}, ${L.end_ms}]`,
        });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  if (n === 0) return { ok: true, cues: [] };

  // 2. 切点分析：强制断点 + 切点落词内冲突
  const forcedBreaks = analyzeCuts(words, cuts, conflicts);

  // 3. 求未锁定词区域（被锁定字幕覆盖的词排除在外）
  const regions = [];
  let cursor = 0;
  let prevLockedEnd = 0;
  for (const L of lockedSorted) {
    if (cursor <= L.word_start - 1) {
      regions.push({ a: cursor, b: L.word_start - 1, lower: prevLockedEnd, upper: L.start_ms });
    }
    prevLockedEnd = L.end_ms;
    cursor = L.word_end + 1;
  }
  if (cursor <= n - 1) {
    regions.push({ a: cursor, b: n - 1, lower: prevLockedEnd, upper: Infinity });
  }

  // 4. 逐区域切分 + 定时（即使已有冲突也继续，尽量收集完整报告）
  const newCues = [];
  for (const r of regions) {
    const segs = segmentRegion(words, r.a, r.b, forcedBreaks, rules, conflicts);
    const timed = timeRegion(words, segs, cuts, rules, r.lower, r.upper, conflicts);
    newCues.push(...timed);
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // 5. 合并固定字幕，按时间升序（入参固定行一般为锁定行；逐词修正重排时也会
  //    传入未受影响的未锁定行——此时显式携带 locked: 0）
  const cues = [
    ...lockedSorted.map((L) => ({
      word_start: L.word_start, word_end: L.word_end, text: L.text,
      start_ms: L.start_ms, end_ms: L.end_ms, locked: L.locked === 0 ? 0 : 1,
    })),
    ...newCues,
  ].sort((x, y) => x.start_ms - y.start_ms || x.word_start - y.word_start);

  // 6. 兜底自检（防御性）：结构不变量必须成立
  const structural = validateStructure(cues, words, cuts);
  if (structural.length > 0) return { ok: false, conflicts: structural };

  return { ok: true, cues };
}

/**
 * 结构不变量校验（供排版自检与导出前校验共用）：
 * 覆盖全部词且每词一次、顺序、不重叠、不跨切点、不缩短词时段。
 */
function validateStructure(cues, words, cuts) {
  const problems = [];
  const n = words.length;
  const covered = new Array(n).fill(0);
  const sorted = [...cues].sort((x, y) => x.start_ms - y.start_ms);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.word_start < 0 || c.word_end >= n || c.word_start > c.word_end) {
      problems.push({
        type: 'structure', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1} 词区间 [${c.word_start}..${c.word_end}] 非法`,
      });
      continue;
    }
    for (let k = c.word_start; k <= c.word_end; k++) covered[k]++;
    const ws = words[c.word_start], we = words[c.word_end];
    if (c.start_ms > ws.start_ms || c.end_ms < we.end_ms) {
      problems.push({
        type: 'word_span_shortened', word_start: c.word_start, word_end: c.word_end,
        message:
          `字幕 #${i + 1} [${c.start_ms}, ${c.end_ms}] 缩短了词本身的时段` +
          `（词区间要求 [${ws.start_ms}, ${we.end_ms}] 被完整包含）`,
      });
    }
    for (const cut of cuts) {
      if (c.start_ms < cut && cut < c.end_ms) {
        problems.push({
          type: 'cut_crossed', word_start: c.word_start, word_end: c.word_end,
          message: `字幕 #${i + 1} [${c.start_ms}, ${c.end_ms}] 跨过镜头切点 ${cut}ms`,
        });
      }
    }
    if (i > 0 && sorted[i - 1].end_ms > c.start_ms) {
      problems.push({
        type: 'overlap', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i} 与 #${i + 1} 时间重叠：[${sorted[i - 1].start_ms}, ${sorted[i - 1].end_ms}] 与 [${c.start_ms}, ${c.end_ms}]`,
      });
    }
  }
  for (let k = 0; k < n; k++) {
    if (covered[k] === 0) {
      problems.push({
        type: 'coverage', word_start: k, word_end: k,
        message: `词 #${k} "${words[k].text}" 未被任何字幕覆盖`,
      });
    } else if (covered[k] > 1) {
      problems.push({
        type: 'coverage', word_start: k, word_end: k,
        message: `词 #${k} "${words[k].text}" 被 ${covered[k]} 条字幕重复覆盖`,
      });
    }
  }
  return problems;
}

/**
 * 规则校验（导出前对全部字幕执行，含锁定字幕）。
 */
function validateRules(cues, rules) {
  const problems = [];
  const sorted = [...cues].sort((x, y) => x.start_ms - y.start_ms);
  sorted.forEach((c, i) => {
    const len = c.text.length;
    const dur = c.end_ms - c.start_ms;
    if (len > rules.max_chars) {
      problems.push({
        type: 'max_chars', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1}${c.locked ? '（已锁定）' : ''} ${len} 字，超过最大字数 ${rules.max_chars}`,
      });
    }
    if (dur < rules.min_duration_ms) {
      problems.push({
        type: 'min_duration', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1}${c.locked ? '（已锁定）' : ''} 显示 ${dur}ms，短于最短时长 ${rules.min_duration_ms}ms`,
      });
    }
    const cps = len / (dur / 1000);
    if (cps > rules.max_cps + 1e-9) {
      problems.push({
        type: 'max_cps', word_start: c.word_start, word_end: c.word_end,
        message: `字幕 #${i + 1}${c.locked ? '（已锁定）' : ''} ${cps.toFixed(1)} 字/秒，超过上限 ${rules.max_cps}`,
      });
    }
  });
  return problems;
}

module.exports = { computeLayout, validateStructure, validateRules, joinWords };
