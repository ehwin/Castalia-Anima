/**
 * test_filler_query —— 短查询早退的边界断言（2026-10-31）
 *
 * 背景：注入证据门对 `嗯 / 好 / 在吗 / 为什么` 这类短句无效（词法相似度是命中比例，
 * 单 bigram 命中即 1.0），实测五个真实库噪音注入率 25~70%。修法是在入口拦"没有实指"
 * 的短句。本测试守的是**误杀**：有实指的短问句一条都不能被拦。
 *
 * 纯函数，无 IO、无库、无 LLM。
 */
import { isFillerQuery } from '../dist/recallForInjection.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL', msg); } };

// 必须拦：纯语气词 / 寒暄 / 泛问
const MUST_BLOCK = [
  '嗯', '好', '在吗', '继续', '然后呢', '为什么', '你好', '测试一下', '嗯嗯', '好的', '是', '对的', '唉', '在', '行了',
  // 2026-10-31 评审 P2-5：同类形态但被 5 字上限/字符集漏掉的
  '在不在', '还在吗', '哈哈哈哈哈哈', '嗯嗯嗯嗯嗯嗯', '不要', '好吧', '还是不了',
];
for (const q of MUST_BLOCK) ok(isFillerQuery(q) === true, `应拦: ${q}`);

// 不能拦：短但有实指（人名、物件、身体、情绪、指代）
const MUST_PASS = [
  '她生日', '牙疼', '手镯呢', '那次约定', '黑潮', '我妈', '你说过', '睡不着', '好想你', '它', '疼', '你母亲的死',
  '还记得那天吗', '三年前的交易', '为什么你会这样', '生日是哪天', '约定还算数吗',
  // 8 字上限提高后仍不能被误杀：含实指字、或超过上限的寒暄+实指
  '不了解', '不想去上班', '不安', '不喜欢他', '哈哈哈哈她好可爱',
];
for (const q of MUST_PASS) ok(isFillerQuery(q) === false, `不该拦: ${q}`);

// 含数字/时间/回指的一律放行，哪怕很短
for (const q of ['27号', '上周三', '上次', '以前'] ) ok(isFillerQuery(q) === false, `放行(时间/回指): ${q}`);

// 空与纯标点按"无查询"处理（等价于原来的 length===0 分支）
for (const q of ['', '   ', '。。。', '？']) ok(isFillerQuery(q) === true, `空/纯标点应拦: ${JSON.stringify(q)}`);

console.log(JSON.stringify({ checks: pass + fail, pass, fail, ok: fail === 0 }));
process.exit(fail === 0 ? 0 : 1);
