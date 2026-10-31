#!/usr/bin/env node
/**
 * Full pipeline plugin — cross-library reflection ("总反思") for one memory body.
 *
 * This used to be an MCP tool (`reflect_all`) baked into the server. It is now
 * an opt-in add-on: the memory body keeps zero aggregate-reflection code in its
 * request path, and a host that wants the pipeline runs this CLI against the
 * banks it wants to fold together.
 *
 * Contract (unchanged from the tool):
 *  - reads active memories from this instance's libraries + FEDERATION_DIRS
 *    external instances, opened read-only;
 *  - asks the configured REFLECT LLM channel to merge duplicates and distill
 *    high-value insights;
 *  - writes results into the dedicated project=reflect library, skipping texts
 *    that already exist there.
 *
 * Usage:
 *   node dist/plugins/fullPipeline/cli.js [--max-total=300] [--max-per-lib=100]
 *        [--projects=shared,notes] [--dry-run] [--all] [--json]
 *
 * Exit codes: 0 success, 1 failure (error message on stderr), 2 bad arguments.
 */
import { runReflectAll } from './reflectAll.js';
function parseArgs(argv) {
    const out = { dryRun: false, all: false, json: false };
    for (const raw of argv) {
        if (raw === '--dry-run' || raw === '--dryRun') {
            out.dryRun = true;
            continue;
        }
        if (raw === '--all') {
            out.all = true;
            continue;
        }
        if (raw === '--json') {
            out.json = true;
            continue;
        }
        if (raw === '-h' || raw === '--help') {
            console.log('usage: node dist/plugins/fullPipeline/cli.js [--max-total=N] [--max-per-lib=N] [--projects=a,b] [--dry-run] [--all] [--json]');
            process.exit(0);
        }
        const m = /^--([a-z-]+)=(.*)$/.exec(raw);
        if (!m)
            throw Object.assign(new Error(`unknown argument: ${raw}`), { code: 2 });
        const [, key, value] = m;
        if (key === 'max-total' || key === 'maxTotal')
            out.maxTotal = Number(value);
        else if (key === 'max-per-lib' || key === 'maxPerLib')
            out.maxPerLib = Number(value);
        else if (key === 'projects')
            out.projects = value.split(',').map(s => s.trim()).filter(Boolean);
        else
            throw Object.assign(new Error(`unknown option: --${key}`), { code: 2 });
    }
    for (const [k, v] of [['max-total', out.maxTotal], ['max-per-lib', out.maxPerLib]]) {
        if (v !== undefined && (!Number.isFinite(v) || v <= 0))
            throw Object.assign(new Error(`--${k} must be a positive number`), { code: 2 });
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));
try {
    const result = await runReflectAll({
        maxTotal: args.maxTotal,
        maxPerLib: args.maxPerLib,
        projects: args.projects,
        dryRun: args.dryRun,
        all: args.all,
    });
    if (args.json) {
        console.log(JSON.stringify(result, null, 2));
    }
    else {
        const scanned = result.scanned || { libraries: 0, memories: 0 };
        const llm = result.llm || { insights: 0, skipped: 0, saved: 0 };
        console.error(`[full-pipeline] libraries=${scanned.libraries} memories=${scanned.memories} `
            + `insights=${llm.insights} written=${llm.saved} skipped=${llm.skipped} dryRun=${result.dryRun === true}`);
        if (result.skipReason)
            console.error(`[full-pipeline] skipReason=${result.skipReason}`);
        for (const msg of result.errors || [])
            console.error(`[full-pipeline] error: ${msg}`);
        for (const ins of (result.insightList || []).slice(0, 20)) {
            const text = String(ins?.text || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`- ${text}`);
        }
        if (!result.ok)
            process.exitCode = result.errors?.length ? 1 : 0;
    }
}
catch (e) {
    console.error('[full-pipeline] failed:', e?.message || e);
    process.exit(e?.code === 2 ? 2 : 1);
}
//# sourceMappingURL=cli.js.map