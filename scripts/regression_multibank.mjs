// 多库回归：运行期切换 MEMORY_DB_DIR（宿主 openBank 换 bank 的真实做法）后，
// 引擎必须打开**新的**库文件，而不是把上一次的连接原样返回。
// 旧实现用 `project:<项目>:<分类>` 做连接缓存键、路径另算，换库后键不变 → 写入落到旧 bank。
// 纯离线：EMBED_MODE=none，两个临时目录，不碰任何真实库。
// 跑法：node scripts/regression_multibank.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const distRoot = fs.existsSync(path.join(root, 'store.js')) ? root : path.join(root, 'dist');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anima-multibank-'));
const bankA = path.join(base, 'bank-a');
const bankB = path.join(base, 'bank-b');
const project = 'multi';

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

process.env.EMBED_MODE = 'none';
process.env.CASTALIA_PROJECT = project;
process.env.CHAR_ID = 'airi';
process.env.MEMORY_DB_DIR = bankA;

const store = await import(pathToFileURL(path.join(distRoot, 'store.js')).href);
const { DatabaseManager } = await import(pathToFileURL(path.join(distRoot, 'db.js')).href);

const a = await store.saveMemory({ text: '银行A里的记忆：灯塔在退潮时才会亮', memType: 'general', characterId: 'airi', project });
check(!!a.id, 'bank A 写入成功');

// 宿主换 bank：只改环境变量，不重启进程 —— 与 openBank() 的做法一致。
process.env.MEMORY_DB_DIR = bankB;
const b = await store.saveMemory({ text: '银行B里的记忆：船票放在抽屉第二层', memType: 'general', characterId: 'airi', project });
check(!!b.id, 'bank B 写入成功');

const fileA = path.join(bankA, 'multi', 'general', 'memory.sqlite');
const fileB = path.join(bankB, 'multi', 'general', 'memory.sqlite');
check(fs.existsSync(fileA), 'bank A 的库文件存在');
check(fs.existsSync(fileB), 'bank B 的库文件存在（旧实现根本不会创建它）');

// 当前句柄必须指向 B：B 的内容在、A 的内容不在。
const handle = DatabaseManager.getInstance(project);
const countB = handle.prepare("SELECT COUNT(*) c FROM memory WHERE is_active = 1 AND text LIKE '%船票%'").get().c;
const crossA = handle.prepare("SELECT COUNT(*) c FROM memory WHERE text LIKE '%灯塔%'").get().c;
check(countB === 1, `B 库里有 B 的写入（实际 ${countB}）`);
check(crossA === 0, `当前句柄指向 B，A 的内容不应混进来（实际 ${crossA}）`);

console.log(`multibank regression: ${checks} checks passed`);
