#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const cursor = await import(pathToFileURL(path.join(root, 'dist', 'selfCycleCursor.js')).href);

const first = { createdAt: '2026-10-30T10:00:00.900Z', rowid: 10 };
const second = { createdAt: '2026-10-30 10:00:01', rowid: 11 };
const third = { createdAt: '2026-10-30T10:00:01.100Z', rowid: 12 };

assert.ok(cursor.compareEvidenceCursor(first, second) < 0, 'ISO and SQLite timestamps keep chronology');
assert.ok(cursor.isAfterEvidenceCursor(second, first), 'later row passes cursor');
assert.ok(cursor.isAfterEvidenceCursor(third, second), 'same SQLite second uses rowid/timestamp tie break');
assert.equal(cursor.isAfterEvidenceCursor(first, second), false, 'older row does not pass cursor');

const pageOne = [
  { createdAt: '2026-10-30T10:00:00.000Z', rowid: 1 },
  { createdAt: '2026-10-30T10:00:01.000Z', rowid: 2 },
];
const pageTwo = [
  { createdAt: '2026-10-30T10:00:02.000Z', rowid: 3 },
  { createdAt: '2026-10-30T10:00:03.000Z', rowid: 4 },
];
const cursorAfterPageOne = cursor.maxEvidenceCursor(pageOne);
assert.deepEqual(cursorAfterPageOne, pageOne[1], 'page watermark is the last chronological row');
assert.deepEqual(
  pageTwo.filter(row => cursor.isAfterEvidenceCursor(row, cursorAfterPageOne)),
  pageTwo,
  'a later page remains readable when page size is smaller than the burst',
);

// Regression: the first run must take the oldest page in the recent window.
// Taking the newest page would advance the watermark past the older backlog
// and make those conversations permanently invisible to self-cycle.
const backlog = [
  { id: 'newest', createdAt: '2026-10-30T10:00:04.000Z', rowid: 5 },
  { id: 'oldest', createdAt: '2026-10-30T10:00:00.000Z', rowid: 1 },
  { id: 'middle', createdAt: '2026-10-30T10:00:02.000Z', rowid: 3 },
  { id: 'same-time-later-row', createdAt: '2026-10-30T10:00:02.000Z', rowid: 4 },
];
const firstPage = backlog
  .slice()
  .sort((a, b) => cursor.compareEvidenceCursor(a, b))
  .slice(0, 2);
assert.deepEqual(
  firstPage.map(row => row.id),
  ['oldest', 'middle'],
  'first self-cycle page starts at the oldest evidence instead of the newest',
);
const firstWatermark = cursor.maxEvidenceCursor(firstPage);
assert.deepEqual(
  backlog
    .filter(row => cursor.isAfterEvidenceCursor(row, firstWatermark))
    .sort((a, b) => cursor.compareEvidenceCursor(a, b))
    .map(row => row.id),
  ['same-time-later-row', 'newest'],
  'the next page drains the rows after the first-run watermark',
);
console.log('PASS self-cycle cursor');
