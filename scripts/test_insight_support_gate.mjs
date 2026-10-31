/**
 * 洞察支持关系回归（2026-10-31）。
 *
 * 对应审计 `docs/research/anima-paper-feasibility-2026-10-31.md` §4.2：
 * 引文是真实子串 ≠ 结论被引文支持。旧闸只做子串检查，于是
 *   「来源：只喝无糖咖啡，不接受加糖」→「结论：必须加糖」被接收。
 *
 * 本测试锁住三条新闸（1b 极性冲突 / 1c 无依据因果 / 1d 缺引文的事实断言），
 * 同时锁住"不许过度拒绝"：合法的改写型、整合型洞察必须仍然通过。
 *
 * 跑法：node --test scripts/test_insight_support_gate.mjs（需先 npm run build）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modPath = path.join(root, 'dist', 'insightQuality.js');
if (!fs.existsSync(modPath)) {
  console.error('[insight-support] dist/insightQuality.js missing; run npm run build first');
  process.exit(2);
}
const q = await import(pathToFileURL(modPath).href);

const SOURCE = { id: 's1', text: '用户明确表示：我只喝无糖咖啡，不接受加糖。' };
const src = [SOURCE];
const TRUTH = '我只喝无糖咖啡';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
};
const verdict = (text, evidence) => q.evaluateInsight({ text, evidence, sources: src, srcImportance: 0.6 });

// ── 审计 §4.2 的五行原样复现 ──
check('audit row 1: grounded restatement stays accepted', () => {
  const v = verdict('以后提供咖啡必须无糖', TRUTH);
  assert.equal(v.ok, true, `unexpected reject: ${v.reasons.join(',')}`);
  assert.equal(v.evidenceOk, true);
});

check('audit row 2: reversed claim with a REAL quote is rejected', () => {
  const v = verdict('必须加糖，因为用户最喜欢甜味', TRUTH);
  assert.equal(v.ok, false);
  assert.equal(v.evidenceOk, true, 'evidence itself is genuine — the support check is what must fire');
  assert.ok(v.reasons.some(r => r.startsWith('evidence-contradicts-claim')),
    `expected polarity conflict, got ${v.reasons.join(',')}`);
});

check('audit row 3: fabricated cause with a REAL quote is rejected', () => {
  const v = verdict('因为患严重糖尿病，所以必须胰岛素治疗', TRUTH);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('unsupported-cause'), `expected unsupported-cause, got ${v.reasons.join(',')}`);
});

check('audit row 4: preference claim with no quote is rejected', () => {
  const v = verdict('必须加糖，因为最喜欢甜味', '');
  assert.equal(v.ok, false);
  assert.equal(v.evidenceOk, null);
  assert.ok(v.reasons.some(r => r.startsWith('evidence-contradicts-claim') || r === 'evidence-missing'),
    `expected a support reason, got ${v.reasons.join(',')}`);
});

check('audit row 5: forged quote is still rejected by the substring gate', () => {
  const v = verdict('必须加糖，因为最喜欢甜味', '每天加三勺糖');
  assert.equal(v.ok, false);
  assert.equal(v.evidenceOk, false);
  assert.ok(v.reasons.includes('evidence-not-in-source'));
});

// ── 不许过度拒绝：合法洞察的对照组 ──
check('paraphrased but faithful insight stays accepted', () => {
  const v = verdict('用户排斥加糖饮品，因此提供咖啡时应默认无糖', TRUTH);
  assert.equal(v.ok, true, `over-rejected: ${v.reasons.join(',')}`);
});

check('negated form that AGREES with the source stays accepted', () => {
  // 结论说"不要加糖"，来源说"不接受加糖" —— 极性一致，不是冲突
  const v = verdict('用户不接受加糖，因此不要主动加糖', TRUTH);
  assert.equal(v.ok, true, `over-rejected: ${v.reasons.join(',')}`);
});

check('weak modal (建议/可以) is not treated as an unsupported mandate', () => {
  const v = verdict('可以建议用户尝试无糖拿铁，观察接受度', TRUTH);
  assert.equal(v.ok, true, `over-rejected: ${v.reasons.join(',')}`);
});

// ── 谓词单元 ──
check('termPolarity ignores negators inside the term itself', () => {
  assert.equal(q.termPolarity('我只喝无糖咖啡', '无糖'), 1, '"无糖" carries its own 无 — not a negation of itself');
  assert.equal(q.termPolarity('不接受加糖', '加糖'), -1);
  assert.equal(q.termPolarity('必须加糖', '加糖'), 1);
  assert.equal(q.termPolarity('完全不相关', '加糖'), 0);
});

check('claimSourceConflict returns the conflicting term', () => {
  assert.equal(q.claimSourceConflict('必须加糖', '不接受加糖'), '加糖');
  assert.equal(q.claimSourceConflict('必须无糖', '只喝无糖咖啡'), null);
});

// ── 2026-10-31 评审 P2-3/P2-4：否定式改写不该被拒，缺来源不该判编造 ──
check('negated rewrite of a NEGATIVE evaluation stays accepted', () => {
  const src = [{ id: 's9', text: '用户说熬夜对身体不好，第二天总是没精神' }];
  const quote = '熬夜对身体不好';
  for (const claim of ['不要熬夜', '别再熬夜了', '她不该熬夜']) {
    const v = q.evaluateInsight({ text: claim, evidence: quote, sources: src, srcImportance: 0.6 });
    const blocking = v.reasons.filter(r => r.startsWith('evidence-contradicts-claim'));
    assert.equal(blocking.length, 0, `over-rejected "${claim}": ${v.reasons.join(',')}`);
  }
  // 反面：来源是中性/正面评价时，同样的否定仍然是翻转
  assert.equal(q.claimSourceConflict('不要熬夜', '用户喜欢熬夜写代码'), '熬夜');
});

check('missing source text is not treated as a fabricated cause', () => {
  assert.equal(q.unsupportedCausalClaim('必须加糖', ''), false);
  assert.equal(q.unsupportedCausalClaim('因为糖尿病所以必须胰岛素', ''), false);
  // 有来源且真的没有词面依据时仍然要拦
  assert.equal(q.unsupportedCausalClaim('因为糖尿病所以必须胰岛素', '她喜欢喝拿铁'), true);
});

if (failures) { console.error(`\n[insight-support] ${failures} failed`); process.exit(1); }
console.log('\n[insight-support] all checks passed');
