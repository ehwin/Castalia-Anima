/**
 * 事实类型：事实路不能靠"来源过滤"代替"类型判断"。
 *
 * 为什么需要这一层（2026-11-02）：
 * facts 表里同时存着三类东西 ——
 *   1) 用户现实侧的陈述（姓名、职业、健康事件…）；
 *   2) 角色与世界设定（agent 的身份/外貌/背景、environment 的世界观）；
 *   3) 从行为里归纳出来的判断（习惯、社交模式、对用户态度…）。
 * 旧注入块把三类一起写成"以下是已经确认过的稳定事实"，等于给角色设定和推测发了
 * 一张现实事实的证书。生产库实测（airi/airi/general，88 条）里 `agent·身份`
 * 是"七丘四方殿谕女，预言能力最强"、`user·社交模式` 是"需要陪伴欲望时强时弱"——
 * 前者是虚构设定，后者是模型归纳，两者都不是"已确认的事实"。
 *
 * 另一个原因：provenance 过滤（排除 agent_diary / agent_state）只能挡住"来源是日记"，
 * 挡不住"来源是对话、但内容是模型猜的"。类型判断必须独立于来源判断。
 *
 * 命名沿用本项目已有的品类实验（技能 references/fact-kind-injection-gates.md 的五类
 * user_fact / meta / divination_record / hypothesis / canon），不另造第四套词：
 *   user_fact 用户现实陈述 · meta 实现/能力状态 · canon 角色/世界设定（虚构）
 *   hypothesis 行为归纳 · unknown 不下判断。
 * meta 靠**谓词**落（具备能力/能力缺口/获授权/运行界面/组件/项目…）：主语是 agent 也照样是
 * 系统事实，生产库 `agent·具备能力 能读取屏幕` 就是被主语规则误判成设定的那一类。
 * 这里**不产** divination_record（盘面/卦例）：那类要求逐字保真并按谓词表 + 干支判定，
 * 不属于这条 300ms 预算的注入路径，目前会落到 user_fact，宁可低报也不冒充。
 * 文档里"规则不能上生产"说的是**用规则决定谁进注入**（判错即删资产）；这里规则只决定
 * 行首标签、不剔除任何一条，判错的代价是多一个词。
 *
 * 这里是**纯函数、无 IO**：写入时打标、读取时兜底（老行没有 fact_type 就现算），
 * 两条路径用同一套规则，避免回填与在线写入给出不同答案。
 */
/** 主语是角色/世界的那一侧 → 一律是设定（虚构），不论谓词。 */
const CANON_SUBJECTS = new Set(['agent', 'self', 'character', 'environment', 'world']);
/** 用户侧的别名。上游 reflect 只会写 'user'，这里兜旧数据与手工写入。 */
const USER_SUBJECTS = new Set(['user', '用户', '我']);
/**
 * 行为归纳类谓词：内容是一次概括/评价，而不是用户当面陈述的可核属性。
 * 只收**已经被 reflect 实际产出过**的谓词（生产库 38 个谓词里挑出来的），
 * 不预设一套想象出来的词表；新谓词默认按主语归类（用户侧陈述），不会静默升级成"设定"。
 */
const META_PREDICATES = new Set([
    '具备能力',
    '能力缺口',
    '获授权',
    '运行界面',
    '组件',
    '项目',
    '版本',
    '端口',
    '路径',
    '依赖',
    '模型',
    '硬件',
    '部署',
]);
const ENV_META_PREDICATES = new Set(['版本', '端口', '路径', '依赖', '模型', '硬件', '部署']);
const HYPOTHESIS_PREDICATES = new Set([
    '习惯',
    '交互习惯',
    '社交模式',
    '社交需求',
    '行为',
    '性格',
    '态度',
    '对用户态度',
    '期望',
    '状态',
    '当日状态',
    '能力缺口',
    '打趣方式',
    '沟通风格',
    '说话风格',
]);
/** 判定一条事实的类型。确定性规则，写入与读取共用。 */
export function classifyFactType(fact) {
    const subject = String(fact.subject ?? '').trim().toLowerCase();
    const predicate = String(fact.predicate ?? '').trim();
    const source = String(fact.source ?? '').trim();
    if (!subject)
        return 'unknown';
    // 派生来源即使写成主语事实，也只能当推测 —— 日记是引擎对对话的再加工。
    if (source === 'agent_diary' || source === 'agent_state')
        return 'hypothesis';
    // 主语是角色/世界，但谓词讲的是实现与授权（能力、界面、组件、项目…）：
    // 这类是系统事实，不是虚构设定。生产库里 'agent·具备能力 能读取屏幕' 就属于这一类。
    if (CANON_SUBJECTS.has(subject)) {
        // environment 的「项目」是世界观条目（'七丘世界存在黑潮灾难'），不是部署信息；
        // 环境侧只承认纯技术谓词，宁可归到设定也不把 lore 标成系统事实。
        const metaSet = subject === 'environment' ? ENV_META_PREDICATES : META_PREDICATES;
        return metaSet.has(predicate) ? 'meta' : 'canon';
    }
    if (USER_SUBJECTS.has(subject)) {
        return HYPOTHESIS_PREDICATES.has(predicate) ? 'hypothesis' : 'user_fact';
    }
    return 'unknown';
}
/** 库里存的字符串是不是合法类型；非法/空值 → false，交给 classifyFactType 现算。 */
export function isFactType(value) {
    return value === 'user_fact' || value === 'meta' || value === 'canon'
        || value === 'hypothesis' || value === 'unknown';
}
/** 注入时行首的类型标签（短，2 字）。 */
export const FACT_TYPE_TAG = {
    user_fact: '用户',
    meta: '系统',
    canon: '设定',
    hypothesis: '推测',
    unknown: '未分类',
};
/**
 * 注入块的抬头。旧抬头是"以下是已经确认过的稳定事实"——掩盖了三类的差别。
 * 这里给每一类一个使用约束，而不是给它们统一的可信度背书。
 */
export const FACT_BLOCK_LEGEND = '记忆库既有记录（不是本轮对话）：[用户]用户侧陈述，可能过时；'
    + '[设定]角色/世界设定，以人设和当前对话为准；[推测]行为归纳，未确认；'
    + '[系统]实现与能力状态，可能随版本变化。';
/**
 * 谓词族 → 应当优先取的类型。
 *
 * 为什么需要排序偏移：事实按 confidence 取前 N，而设定类事实的置信度普遍更高
 * （`agent·身份` 0.95、`agent·对用户态度` 0.9 高于 `user·习惯` 0.7），
 * 于是问"我有什么习惯"时前 N 条会先被角色设定占满。这里只做**同分优先**，
 * 不改变取数上限，也不剔除任何类型 —— 只是让问句问的那一侧排在前面。
 */
const FAMILY_TYPE_AFFINITY = {
    习惯: ['user_fact', 'hypothesis'],
    喜好: ['user_fact'],
    关系: ['user_fact', 'canon'],
    姓名: ['user_fact', 'canon'],
    职业: ['user_fact'],
    目标: ['user_fact'],
    承诺: ['user_fact'],
    健康: ['user_fact'],
    身份: ['canon', 'user_fact'],
};
/** 该类型是否是这个谓词族首选的答案侧。 */
export function isPreferredFactType(family, type) {
    if (!family)
        return false;
    const preferred = FAMILY_TYPE_AFFINITY[family];
    if (!preferred || preferred.length === 0)
        return false;
    return preferred.includes(type);
}
//# sourceMappingURL=factType.js.map