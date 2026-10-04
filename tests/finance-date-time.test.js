const test = require('node:test');
const assert = require('node:assert/strict');
const { manilaWeekStartDate } = require('../src/utils/financeDateTime');

test('Manila report week shortcut uses Monday calendar dates across timezone and calendar boundaries', () => {
  assert.equal(manilaWeekStartDate('2026-10-05'), '2026-10-05', 'a Monday starts its own week');
  assert.equal(manilaWeekStartDate('2026-10-04'), '2026-09-28', 'Sunday belongs to the preceding Monday week');
  assert.equal(manilaWeekStartDate('2026-11-01'), '2026-10-26', 'month boundary uses the same Monday-start rule');
  assert.equal(manilaWeekStartDate('2027-01-01'), '2026-12-28', 'year boundary uses the same Monday-start rule');
  assert.equal(manilaWeekStartDate('2024-02-29'), '2024-02-26', 'leap day remains in its calendar week');
});

test('Manila report week shortcut rejects impossible and non-date values', () => {
  for (const value of ['2026-02-29', '2026-13-01', '2026-10-5', '', null, new Date()]) {
    assert.equal(manilaWeekStartDate(value), null);
  }
});
