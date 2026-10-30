/** Sources produced by the runtime itself rather than by an external or user interaction. */
export const DERIVED_MEMORY_SOURCES = ['agent_diary', 'agent_state'];
export function isDerivedMemorySource(source) {
    return DERIVED_MEMORY_SOURCES.includes(String(source || ''));
}
/** SQL predicate for public memory paths. NULL/empty sources remain ordinary legacy evidence. */
export function publicMemorySourceSql(alias = '') {
    const column = alias ? `${alias}.source` : 'source';
    return `COALESCE(${column}, '') NOT IN ('agent_diary', 'agent_state')`;
}
/** SQL predicate for paths that may explicitly browse diary rows but never state snapshots. */
export function memorySourceWithoutStateSql(alias = '') {
    const column = alias ? `${alias}.source` : 'source';
    return `COALESCE(${column}, '') <> 'agent_state'`;
}
//# sourceMappingURL=memoryProvenance.js.map