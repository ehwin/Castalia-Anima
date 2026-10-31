// Regression checks for the deployed NPU sensor parser.
// This reads the real deployment file without starting the sensor or loading a model.
import fs from 'node:fs';
import vm from 'node:vm';

const deployed = process.env.PSYCHE_SENSOR_SCRIPT || 'D:/castalia/run/Castalia/scripts/psyche_npu.mjs';
if (!fs.existsSync(deployed)) {
  // The sensor is deployed outside this repo (it belongs to the runtime tree),
  // so a missing path must be an explicit skip, not an ENOENT crash that looks
  // like a failing regression on a fresh machine.
  console.log(`SKIP psyche parse regression: sensor not found at ${deployed} (set PSYCHE_SENSOR_SCRIPT to point at it)`);
  process.exit(0);
}
const source = fs.readFileSync(deployed, 'utf8');
const start = source.indexOf('function parseVal(txt)');
const end = source.indexOf('function loadCfg', start);
if (start < 0 || end < 0) throw new Error('parseVal function not found in deployed script');
const parseVal = vm.runInNewContext(`(${source.slice(start, end).trim()})`);

const cases = [
  ['VAL=-2', { band: -2, abstain: false }],
  ['VAL=-1', { band: -1, abstain: false }],
  ['VAL=0', { band: 0, abstain: false }],
  ['VAL=1', { band: 1, abstain: false }],
  ['VAL=2', { band: 2, abstain: false }],
  ['VAL=?', { band: null, abstain: true }],
  [' VAL = -1 ', { band: -1, abstain: false }],
  ['VAL=12', null],
  ['VAL=9', null],
  ['-1', null],
  ['text VAL=1', null],
  ['VAL=1\nreason', null],
];

for (const [input, expected] of cases) {
  const actual = parseVal(input);
  const ok = expected === null
    ? actual === null
    : actual?.band === expected.band && actual?.abstain === expected.abstain;
  if (!ok) throw new Error(`${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
}

console.log(`psyche parse regression passed (${cases.length} cases)`);
