'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeLayout, validateStructure, validateRules } = require('../src/layout');

const RULES = { max_chars: 10, min_duration_ms: 1000, max_cps: 10 };

function W(list) {
  // [[text, start, end], ...] -> words
  return list.map(([text, start_ms, end_ms], idx) => ({ idx, text, start_ms, end_ms }));
}

test('基本排版：覆盖全部词、不重叠、含词时段', () => {
  const words = W([
    ['hello', 0, 400], ['world', 450, 900],
    ['foo', 1500, 1900], ['bar', 1950, 2400],
  ]);
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 12, min_duration_ms: 500, max_cps: 20 }, locked: [] });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  // 覆盖：每词恰好一次
  const covered = new Array(words.length).fill(0);
  for (const c of r.cues) for (let k = c.word_start; k <= c.word_end; k++) covered[k]++;
  assert.deepEqual(covered, [1, 1, 1, 1]);
  // 不重叠 & 词时段未被缩短
  for (let i = 0; i < r.cues.length; i++) {
    const c = r.cues[i];
    if (i > 0) assert.ok(r.cues[i - 1].end_ms <= c.start_ms, '字幕重叠');
    assert.ok(c.start_ms <= words[c.word_start].start_ms);
    assert.ok(c.end_ms >= words[c.word_end].end_ms);
  }
  assert.equal(validateStructure(r.cues, words, []).length, 0);
});

test('最大字数：超出即断，不跨 max_chars', () => {
  const words = W([
    ['aaaa', 0, 300], ['bbbb', 350, 700], ['cccc', 750, 1100], ['dddd', 1150, 1500],
  ]);
  // max_chars=10：'aaaa bbbb' = 9，再加 ' cccc' 变 14 > 10 → 两条
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 10, min_duration_ms: 0, max_cps: 20 }, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, 'aaaa bbbb');
  assert.equal(r.cues[1].text, 'cccc dddd');
});

test('CJK 拼接不加空格', () => {
  const words = W([['你好', 0, 500], ['世界', 550, 1000]]);
  const r = computeLayout({ words, cuts: [], rules: RULES, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues[0].text, '你好世界');
});

test('镜头切点：强制断开，不跨切点', () => {
  const words = W([
    ['aaa', 0, 500], ['bbb', 550, 1000], ['ccc', 1500, 2000], ['ddd', 2050, 2500],
  ]);
  const r = computeLayout({ words, cuts: [1200], rules: RULES, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues.length, 2);
  assert.deepEqual([r.cues[0].word_start, r.cues[0].word_end], [0, 1]);
  assert.deepEqual([r.cues[1].word_start, r.cues[1].word_end], [2, 3]);
  for (const c of r.cues) assert.ok(!(c.start_ms < 1200 && 1200 < c.end_ms), '跨切点');
});

test('切点落在词内部 → 报告冲突，不输出结果', () => {
  const words = W([['hello', 0, 1000], ['world', 1050, 1500]]);
  const r = computeLayout({ words, cuts: [500], rules: RULES, locked: [] });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, 'cut_inside_word');
  assert.equal(r.conflicts[0].word_start, 0);
  assert.match(r.conflicts[0].message, /500ms/);
  assert.match(r.conflicts[0].message, /跨镜头切点/);
});

test('相邻字幕时间分配：前条向前借，不挤占后条切点前显示（回归）', () => {
  // A[1000,1100]、B[1500,1600]，1700 切点；每词一条、最短 600ms。
  // 旧算法让 A 一味向后顶到 1500，B 只剩 [1500,1700]=200ms → 误报时长冲突；
  // 正确排法：A[500,1100]、B[1100,1700]（前条向前借空闲间隙）。
  const words = W([['A', 1000, 1100], ['B', 1500, 1600]]);
  const r = computeLayout({
    words, cuts: [1700],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[500, 1100], [1100, 1700]],
  );
  assert.equal(validateStructure(r.cues, words, [1700]).length, 0);
});

test('三段链：前条只借到恰好满足，中间间隙留给后续字幕', () => {
  // 三词各 100ms、最短 600ms；切点 2100；0..2100 恰好容纳三条 600ms。
  // 旧贪心把 A 顶到 1000、B 顶到 1500，C 在切点前只剩 600 看似够，
  // 但 B 默认后顶会直接吃掉 C 的空间 → 误报冲突；
  // 正确链解：A[300,900]、B[900,1500]、C[1500,2100]（各 600ms、首尾相接）。
  const words = W([['甲', 800, 900], ['乙', 1400, 1500], ['丙', 2000, 2100]]);
  const r = computeLayout({
    words, cuts: [2100],
    rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[300, 900], [900, 1500], [1500, 2100]],
  );
  assert.equal(validateStructure(r.cues, words, [2100]).length, 0);
});

test('无需扩展时保持词时段，不前移也不后占', () => {
  // 词本身时长已达最短要求、间隙充足：字幕就用 [sDef, eDef]，相邻间隙原样保留
  const words = W([['甲', 0, 1000], ['乙', 3000, 4000]]);
  const r = computeLayout({
    words, cuts: [], rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[0, 1000], [3000, 4000]],
  );
});

test('确实无解：双侧都被锁死时仍按词段报 duration 冲突', () => {
  // 两条锁定字幕把唯一未锁定词夹在 1000..1200（200ms），最短需 600ms → 无解
  const words = W([['锁一', 0, 300], ['挤', 1050, 1150], ['锁二', 2000, 2300]]);
  const locked = [
    { word_start: 0, word_end: 0, text: '锁一', start_ms: 0, end_ms: 1000 },
    { word_start: 2, word_end: 2, text: '锁二', start_ms: 1200, end_ms: 2400 },
  ];
  const r = computeLayout({
    words, cuts: [], rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked,
  });
  assert.equal(r.ok, false);
  const c = r.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, '应有 duration 冲突');
  assert.equal(c.word_start, 1);
  assert.equal(c.word_end, 1);
  assert.match(c.message, /600ms/);
});

test('间隙切点限制前条结束：不得跨过切点向后借', () => {
  // 甲[0,100] 需 600ms；间隙切点 1000 要求甲结束 <=1000（实际只需 600，故 [0,600]），
  // 乙在 2000 之后，自身 [2000,2600]；切点不得落在任何字幕内
  const words = W([['甲', 0, 100], ['乙', 2000, 2400]]);
  const r = computeLayout({
    words, cuts: [1000], rules: { max_chars: 1, min_duration_ms: 600, max_cps: 100 }, locked: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  assert.deepEqual(
    r.cues.map((c) => [c.start_ms, c.end_ms]),
    [[0, 600], [2000, 2600]],
  );
  assert.equal(validateStructure(r.cues, words, [1000]).length, 0);
});

test('锁定字幕给出区域下界：后续未锁定行从锁定结束之后排起', () => {
  const words = W([['锁', 0, 100], ['后', 2000, 2100]]);
  const locked = [{ word_start: 0, word_end: 0, text: '锁', start_ms: 0, end_ms: 1000, locked: 1 }];
  const r = computeLayout({
    words, cuts: [], rules: { max_chars: 1, min_duration_ms: 500, max_cps: 100 }, locked,
  });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  const fresh = r.cues.filter((c) => c.locked === 0);
  assert.deepEqual(fresh.map((c) => [c.start_ms, c.end_ms]), [[2000, 2500]]);
});

test('最短时长：向后扩展空闲间隙', () => {
  // max_chars=1 → 每词一条；第一条 [0,300] 需扩到 1000ms，后方间隙足够
  const words = W([['短', 0, 300], ['词', 2000, 2400]]);
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 10 }, locked: [] });
  assert.equal(r.ok, true);
  assert.equal(r.cues[0].end_ms - r.cues[0].start_ms, 1000); // 300 扩到 1000
  assert.ok(r.cues[0].end_ms <= r.cues[1].start_ms);
});

test('最短时长无法满足 → 报告受影响词段与条件', () => {
  // 两词紧贴，各 300ms，最短 1000ms → 第一条最多扩到 1000ms（第二词 start），刚好够；
  // 把第二词提前到 500ms：第一条可用空间只有 500ms < 1000ms → 冲突
  const words = W([['甲', 0, 300], ['乙', 500, 800]]);
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 1, min_duration_ms: 1000, max_cps: 10 }, locked: [] });
  assert.equal(r.ok, false);
  const c = r.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, '应有 duration 冲突');
  assert.equal(c.word_start, 0);
  assert.match(c.message, /1000ms/);
});

test('每秒字数：密集词段无法拆分 → 冲突', () => {
  // 一个词 10 字占 500ms = 20 字/秒，上限 10 → 需要 1000ms；后无空间（被切点卡住）
  const words = W([['一二三四五六七八九十', 0, 500], ['尾', 1500, 1800]]);
  const r = computeLayout({
    words, cuts: [600], rules: { max_chars: 30, min_duration_ms: 0, max_cps: 10 }, locked: [],
  });
  assert.equal(r.ok, false);
  const c = r.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, '应有 duration/cps 冲突');
  assert.match(c.message, /每秒最多 10 字/);
});

test('单词超过最大字数 → 冲突', () => {
  const words = W([['超长的词超过限制', 0, 1000]]);
  const r = computeLayout({ words, cuts: [], rules: { ...RULES, max_chars: 4 }, locked: [] });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].type, 'max_chars');
});

test('锁定字幕原样保留，只重排未锁定词段', () => {
  const words = W([
    ['a', 0, 400], ['b', 450, 900],           // 锁定区间
    ['c', 2000, 2400], ['d', 2450, 2900],     // 未锁定
    ['e', 4000, 4400], ['f', 4450, 4900],     // 未锁定
  ]);
  const locked = [{ word_start: 0, word_end: 1, text: '手工校对 a b', start_ms: 0, end_ms: 1200 }];
  const r = computeLayout({ words, cuts: [], rules: { max_chars: 5, min_duration_ms: 500, max_cps: 20 }, locked });
  assert.equal(r.ok, true, JSON.stringify(r.conflicts));
  const lockedCue = r.cues.find((c) => c.locked === 1);
  assert.equal(lockedCue.text, '手工校对 a b');
  assert.equal(lockedCue.end_ms, 1200); // 未被改动
  // 未锁定部分被重排（max_chars=5 → 'c d' 一条、'e f' 一条）
  const fresh = r.cues.filter((c) => c.locked === 0);
  assert.equal(fresh.length, 2);
  // 重排结果不得与锁定字幕重叠
  assert.ok(fresh[0].start_ms >= 1200);
});

test('锁定字幕互相重叠 → 冲突', () => {
  const words = W([['a', 0, 400], ['b', 450, 900], ['c', 1000, 1400]]);
  const locked = [
    { word_start: 0, word_end: 1, text: 'x', start_ms: 0, end_ms: 900 },
    { word_start: 1, word_end: 2, text: 'y', start_ms: 800, end_ms: 1400 },
  ];
  const r = computeLayout({ words, cuts: [], rules: RULES, locked });
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.type === 'locked_overlap'));
});

test('validateRules 检出锁定字幕的规则违例（导出前把关）', () => {
  const cues = [{ word_start: 0, word_end: 0, text: '十二个字的一段字幕文本内容', start_ms: 0, end_ms: 500, locked: 1 }];
  const problems = validateRules(cues, { max_chars: 5, min_duration_ms: 1000, max_cps: 10 });
  assert.equal(problems.length, 3); // 字数、时长、cps 各一
  assert.ok(problems.every((p) => p.message.includes('已锁定')));
});
