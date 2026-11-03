/**
 * 事实路注入：把 facts 表里"已经确认过的稳定事实"带进本轮上下文。
 *
 * 为什么需要这一路（2026-10-29）：
 * 反刍抽出来的事实落在 `facts` 表里（subject=user/agent，predicate=习惯/喜好/关系/姓名/目标/承诺…），
 * 但注入路径只读 memory 表 —— 事实只有被改写成摘要行之后才可能被召回。实测库里 76 条事实、
 * 76 个实体完全没有参与注入（对应 Zep 的 +18.5%、HippoRAG 的多跳：图/事实路由是独立一路）。
 *
 * 为什么不按实体名匹配：实测本库 `entities.name` 是一整句话（"会主动寻求情感联系，常询问想念"），
 * 用户问句里几乎不可能出现。真正稳定的是"谓词"，所以这里是**谓词触发 + 人称触发**，
 * 而不是硬套别的系统的实体链接。
 *
 * 门槛（宁缺勿滥）：问句必须同时(a)提到我/你, (b)命中谓词词表；然后只取
 * valid_to IS NULL 且未被推翻(superseded_by IS NULL) 的事实，按 confidence 取前 N 条。
 * 8 条噪音问句因此一条都进不来（它们不含这类谓词），实测见 eval_injection。
 *
 * 类型（2026-11-02）：来源过滤 ≠ 类型判断。排除日记/心力快照只回答"这条从哪来"，
 * 回答不了"这条是现实陈述、角色设定，还是模型归纳"。旧实现把三类一起写成
 * "以下是已经确认过的稳定事实"，等于给虚构设定与推测发事实证书。现在每条按
 * factType.ts 的确定性规则打标（写入时落 `facts.fact_type`，老行读取时现算），
 * 抬头只承诺"记忆库既有记录"，并对三类分别给出使用约束。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { CHAR_ID, normalizeProject } from './env.js';
import { FACT_BLOCK_LEGEND, FACT_TYPE_TAG, classifyFactType, isFactType, isPreferredFactType } from './factType.js';
import type { FactType } from './factType.js';

/** 问句 -> 谓词族。命中任一即认为"在问关于人/关系的稳定事实" */
const PREDICATE_TRIGGERS: Array<{ family: string[]; hit: RegExp }> = [
  { family: ['习惯', '作息', '规律'], hit: /习惯|作息|规律|一般几点|每天都/ },
  { family: ['喜好', '偏好', '喜欢'], hit: /喜欢|偏好|爱好|爱吃|讨厌|不喜欢/ },
  { family: ['关系', '感情'], hit: /关系|我们|感情|对我|亲近|疏远/ },
  { family: ['姓名', '名字', '称呼'], hit: /名字|叫什么|怎么称呼|生日/ },
  { family: ['职业', '工作', '技能'], hit: /工作|职业|做什么的|会什么|擅长|技能/ },
  { family: ['目标', '计划'], hit: /目标|计划|打算|想要什么|愿望/ },
  { family: ['承诺', '约定'], hit: /答应|承诺|约定|说好|保证/ },
  { family: ['健康', '身体'], hit: /身体|健康|病|疼|牙|睡|失眠/ },
  { family: ['身份'], hit: /身份|你是谁|你是什么/ },
];

/** 问句必须指向"人"，否则不触发（避免"帮我写个快速排序"这类任务句） */
const PERSON_HINT = /我|你|咱|自己/;

export interface FactHit {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  updatedAt: string;
  /** 现实陈述 / 角色设定 / 行为归纳 / 未分类 */
  type: FactType;
  /** 类型来自库里的 fact_type（写入时判定）还是读取时现算（老行） */
  typeStored: boolean;
}

export interface FactRecallResult {
  text: string;
  facts: FactHit[];
  chars: number;
  /** 触发了哪些谓词族（诊断用） */
  families: string[];
}

function familiesFor(query: string): string[] {
  const q = String(query || '');
  if (!PERSON_HINT.test(q)) return [];
  const out = new Set<string>();
  for (const t of PREDICATE_TRIGGERS) if (t.hit.test(q)) out.add(t.family[0]);
  return [...out];
}

/**
 * 取本轮要注入的事实。纯本地查询，不调 LLM、不算向量，所以它可以在 300ms 的注入预算里跑。
 */
export function recallFactsForQuery(
  query: string,
  options: { project?: string; characterId?: string; limit?: number; maxChars?: number } = {},
): FactRecallResult {
  const empty: FactRecallResult = { text: '', facts: [], chars: 0, families: [] };
  const families = familiesFor(query);
  if (families.length === 0) return empty;

  const proj = normalizeProject(options.project);
  const cid = options.characterId || CHAR_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 4, 8));
  const maxChars = options.maxChars ?? 420;

  const collected: FactHit[] = [];
  const placeholders = families.map(() => '?').join(',');
  for (const mt of listMemTypeDirs(proj)) {
    let db: any;
    try { db = DatabaseManager.getInstance(proj, mt); } catch { continue; }
    try {
      const rows = db.prepare(`
        SELECT f.id, f.subject, f.predicate, f.object, f.confidence,
               f.fact_type, f.source_memory_source AS source,
               COALESCE(f.updated_at, f.created_at) AS updated_at
        FROM facts f
        LEFT JOIN memory source_memory ON source_memory.id = f.source_memory_id
        WHERE f.is_active = 1
          AND f.valid_to IS NULL
          AND (f.superseded_by IS NULL OR f.superseded_by = '')
          AND f.project = ?
          AND f.character_id = ?
          AND f.predicate IN (${placeholders})
          AND COALESCE(f.source_memory_source, source_memory.source, '') NOT IN ('agent_diary', 'agent_state')
        ORDER BY f.confidence DESC, updated_at DESC
        LIMIT ?
      `).all(proj, cid, ...families, limit * 3) as any[];
      for (const row of rows) {
        const text = String(row.object || '').trim();
        if (!text) continue;
        const stored = String(row.fact_type ?? '').trim();
        const type: FactType = isFactType(stored)
          ? stored
          : classifyFactType({ subject: row.subject, predicate: row.predicate, source: row.source });
        collected.push({
          id: String(row.id),
          subject: String(row.subject || ''),
          predicate: String(row.predicate || ''),
          object: text,
          confidence: Number(row.confidence) || 0,
          updatedAt: String(row.updated_at || ''),
          type,
          typeStored: isFactType(stored),
        });
      }
    }
    catch { /* 该分类库没有 facts 表:跳过 */ }
  }

  if (collected.length === 0) return { ...empty, families };

  // 去重（同一 subject+predicate+object 只会出现一次），再取前 N，最后守字数预算。
  // 排序 = confidence + 问句侧优先：设定类事实的置信度普遍更高（身份 0.95 / 态度 0.9
  // 高于用户习惯 0.7），纯按 confidence 取前 N 时，"我有什么习惯"会先被角色设定占满。
  // 偏移 0.3 只影响取哪几条，不改变取数上限，也不剔除任何类型：它表达的判断是
  // "问句问的那一侧"比"置信度差 0.3 以内"更值得占一个槽位。
  const FAMILY_MATCH_BONUS = 0.3;
  const score = (fact: FactHit) =>
    fact.confidence + (families.some(f => isPreferredFactType(f, fact.type)) ? FAMILY_MATCH_BONUS : 0);
  const seen = new Set<string>();
  const picked: FactHit[] = [];
  let chars = 0;
  for (const fact of [...collected].sort((a, b) => score(b) - score(a))) {
    const key = `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = renderLine(fact);
    if (chars + line.length > maxChars) continue;
    picked.push(fact);
    chars += line.length;
    if (picked.length >= limit) break;
  }
  if (picked.length === 0) return { ...empty, families };

  const body = picked.map(renderLine).join('\n');
  const text = `${FACT_BLOCK_LEGEND}\n${body}`;
  return { text, facts: picked, chars: text.length, families };
}

function renderLine(fact: FactHit): string {
  const who = fact.subject === 'agent' ? '她' : fact.subject === 'user' ? '用户' : fact.subject;
  const tag = FACT_TYPE_TAG[fact.type] ?? FACT_TYPE_TAG.unknown;
  return `- [${tag}] ${who}·${fact.predicate}：${fact.object}（conf ${fact.confidence.toFixed(2)}）`;
}
