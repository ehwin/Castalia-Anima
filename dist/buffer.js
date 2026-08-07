/**
 * SessionMemoryBuffer — 渐进式临时反思的缓冲触发器(吸收 Claude Code bufferController.ts)
 *
 * v1.11 Part2:每轮对话 onNewMessage() → pendingCount++,达到 BUFFER_SIZE(默认 5)后
 * 后台异步触发 runIncrementalReflection(绝不 await,不阻塞主流程;错误静默 console.error)。
 * 进程内单例 per (project, sessionId):getBuffer 工厂缓存。
 */
import { runIncrementalReflection } from './triage.js';
import { normalizeProject, CHAR_ID } from './env.js';
const DEFAULT_BUFFER_SIZE = (() => {
    const v = parseInt(process.env.BUFFER_SIZE || '5', 10);
    return Number.isFinite(v) && v > 0 ? v : 5; // 非法值兜底 5
})();
const buffers = new Map();
export class SessionMemoryBuffer {
    project;
    sessionId;
    characterId;
    threshold;
    pendingCount = 0;
    history = [];
    constructor(project, sessionId, characterId = CHAR_ID, threshold = DEFAULT_BUFFER_SIZE) {
        this.project = project;
        this.sessionId = sessionId;
        this.characterId = characterId;
        this.threshold = threshold > 0 ? threshold : DEFAULT_BUFFER_SIZE;
    }
    onNewMessage(messages) {
        if (Array.isArray(messages))
            this.history.push(...messages);
        this.pendingCount++;
        if (this.pendingCount >= this.threshold) {
            this.flush(messages);
        }
    }
    flush(messages) {
        this.pendingCount = 0;
        const recent = (this.history.length > 0 ? this.history : (messages || [])).slice(-10);
        this.history = [];
        // 后台异步执行,绝不 await 阻塞主流程;错误静默捕获
        Promise.resolve().then(async () => {
            try {
                await runIncrementalReflection(this.project, this.sessionId, recent, this.characterId);
            }
            catch (e) {
                console.error(`[buffer] 增量反思失败: ${e.message}`);
            }
        });
    }
}
/** 进程内单例工厂:key = `${project}|${sessionId}`,同会话复用同一 buffer */
export function getBuffer(project, sessionId, characterId) {
    const proj = normalizeProject(project);
    const key = `${proj}|${sessionId}`;
    let b = buffers.get(key);
    if (!b) {
        b = new SessionMemoryBuffer(proj, sessionId, characterId);
        buffers.set(key, b);
    }
    return b;
}
