#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(process.argv[2] || '.', 'src', 'emotion.ts'), 'utf8');
assert.match(
  source,
  /: updateWithoutVad\.run\([\s\S]*?\n\s*'abstain', analyzedAt,/,
  'rows without VAD must remain abstain even when psyche finalization is deferred',
);
assert.doesNotMatch(
  source,
  /deferPsycheFinalize \? 'pending_psyche' : 'abstain'/,
  'no-VAD rows must not enter the psyche pending state',
);
console.log('PASS emotion status source regression');
