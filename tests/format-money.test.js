const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMoney } = require('../src/utils/formatMoney');

test('peso display groups whole digits without changing decimal ledger precision', () => {
  assert.equal(formatMoney('4990.00'), '4,990.00');
  assert.equal(formatMoney('19960.5'), '19,960.50');
  assert.equal(formatMoney('-1234567.89'), '-1,234,567.89');
  assert.equal(formatMoney(0), '0.00');
  assert.equal(formatMoney('not-a-balance'), '—');
});
