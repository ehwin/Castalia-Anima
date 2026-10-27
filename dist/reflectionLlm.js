export function makeLlmChannel(prefix) {
    // 环境变量前缀统一大写；调用方使用 triage/reflect 小写时也必须命中
    const envPrefix = String(prefix || '').toUpperCase();
    const get = (suffix, fallback) => {
        const v = process.env[`${envPrefix}_${suffix}`];
        return v && v.trim().length > 0 ? v.trim() : fallback;
    };
    return {
        name: String(prefix || 'reflect').toLowerCase(),
        url: get('LLM_URL', process.env.REFLECT_LLM_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
        apiKey: get('LLM_API_KEY', process.env.REFLECT_LLM_API_KEY || ''),
        model: get('LLM_MODEL', process.env.REFLECT_LLM_MODEL || 'deepseek-chat'),
    };
}
export function parseJsonRobust(raw) {
    let s = (raw || '').trim();
    // 剥离 markdown 代码围栏
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence)
        s = fence[1].trim();
    // 提取最外层 {...} 或 [...] 块
    const body = (() => {
        if (s.startsWith('{') || s.startsWith('['))
            return s;
        const obj = s.match(/\{[\s\S]*\}/);
        if (obj)
            return obj[0];
        const arr = s.match(/\[[\s\S]*\]/);
        if (arr)
            return arr[0];
        return null;
    })();
    if (!body)
        return null;
    const strategies = [
        (x) => JSON.parse(x),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
        (x) => JSON.parse(x.replace(/"\s*\n\s*"/g, '",\n"')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"').replace(/[\x00-\x1f]+/g, ' ')),
    ];
    for (const fn of strategies) {
        try {
            const r = fn(body);
            if (Array.isArray(r))
                return { actions: r };
            if (r && typeof r === 'object')
                return r;
        }
        catch { /* try next */ }
    }
    return null;
}
/**
 * v1.11.3 重路径(总反思/深度反思/整合)的输出预算 —— 与浅层(triage 临时反思 / reflect_auto)分开。
 * 为什么需要:推理模型(如 deepseek-v4-pro)的**思考 token 也计入 max_tokens**,8192 会被"想"吃光,
 * 返回 finish_reason=length 且 content 为空 → 整合报 `未找到有效 JSON 结果`(实测 reasoning 18600 字符)。
 * 浅层仍走 callLlm 的 8192 默认值,不受此影响。config.json 的 `reflect.maxTokens` 可覆盖。
 */
export const REFLECT_DEEP_MAX_TOKENS = (() => {
    const v = parseInt(process.env.REFLECT_DEEP_MAX_TOKENS || '32768', 10);
    return Number.isFinite(v) && v >= 1024 ? v : 32768;
})();
/**
 * 调用 LLM(OpenAI 兼容,非流式)。
 * 通道:缺省用 reflect(REFLECT_*);传 channel 则用指定通道(triage/reflect)。
 */
export async function callLlm(systemPrompt, userPrompt, channel, maxTokens = 8192) {
    const ch = channel ?? makeLlmChannel('reflect');
    if (!ch.apiKey)
        return null;
    const startedAt = Date.now();
    try {
        const resp = await fetch(`${ch.url}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
            body: JSON.stringify({
                model: ch.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                max_tokens: maxTokens,
                stream: false,
            }),
        });
        if (!resp.ok)
            throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const data = await resp.json();
        const msg = data?.choices?.[0]?.message || {};
        const finishReason = data?.choices?.[0]?.finish_reason || undefined;
        // 每次调用都要能看到账：usage 此前被丢弃，导致"pro 开销大"无从归因。
        const usage = data?.usage || {};
        const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
        console.error(`[llm] ts=${new Date().toISOString()} channel=${ch.name || 'reflect'} model=${ch.model}` +
            ` prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'}` +
            ` reasoning=${reasoning} cached=${cached}` +
            ` finish=${finishReason || 'n/a'} ms=${Date.now() - startedAt}`);
        if (finishReason === 'length') {
            console.error(`[llm] 警告：输出撞到 max_tokens=${maxTokens} 被截断，prompt+completion 仍全额计费`);
        }
        return {
            content: msg.content || '',
            reasoning: msg.reasoning_content || '',
            finishReason,
        };
    }
    catch (e) {
        console.error('[reflect-driver] LLM call failed:', e.message);
        return null;
    }
}
//# sourceMappingURL=reflectionLlm.js.map