const { test } = require('node:test');
const assert = require('node:assert');
const cron = require('../api/cron');

const at = (s) => new Date(s); // local time strings
const fmt = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('every five minutes', () => {
  assert.strictEqual(fmt(cron.next('*/5 * * * *', at('2026-03-10T10:02:30'))), '2026-03-10 10:05');
  assert.strictEqual(fmt(cron.next('*/5 * * * *', at('2026-03-10T10:55:00'))), '2026-03-10 11:00');
});

test('daily, weekly, monthly', () => {
  assert.strictEqual(fmt(cron.next('30 2 * * *', at('2026-03-10T02:30:00'))), '2026-03-11 02:30');
  assert.strictEqual(fmt(cron.next('0 9 * * MON', at('2026-03-10T10:00:00'))), '2026-03-16 09:00'); // 2026-03-10 is a Tuesday
  assert.strictEqual(fmt(cron.next('0 0 1 * *', at('2026-12-15T00:00:00'))), '2027-01-01 00:00');
  assert.strictEqual(fmt(cron.next('@hourly', at('2026-03-10T10:20:00'))), '2026-03-10 11:00');
});

test('lists, ranges, steps, names, Sunday as 0 or 7', () => {
  assert.strictEqual(fmt(cron.next('0 8-10/2 * * 1-5', at('2026-03-13T08:30:00'))), '2026-03-13 10:00'); // Friday
  assert.strictEqual(fmt(cron.next('0 8-10/2 * * 1-5', at('2026-03-13T10:30:00'))), '2026-03-16 08:00');
  assert.strictEqual(fmt(cron.next('15 6 * JAN,JUN *', at('2026-03-10T00:00:00'))), '2026-06-01 06:15');
  assert.strictEqual(fmt(cron.next('0 12 * * 7', at('2026-03-10T00:00:00'))), '2026-03-15 12:00');
  assert.strictEqual(fmt(cron.next('0 12 * * 0', at('2026-03-10T00:00:00'))), '2026-03-15 12:00');
});

test('day-of-month and day-of-week together match either', () => {
  assert.strictEqual(fmt(cron.next('0 0 13 * 5', at('2026-03-10T00:00:00'))), '2026-03-13 00:00'); // the 13th is a Friday too
  assert.strictEqual(fmt(cron.next('0 0 14 * 5', at('2026-03-10T00:00:00'))), '2026-03-13 00:00'); // Friday comes first
});

test('bad expressions are rejected with a reason', () => {
  for (const bad of ['', '* * * *', '61 * * * *', '* 24 * * *', '*/0 * * * *', 'a b c d e', '5-1 * * * *', '* * 32 * *']) assert.throws(() => cron.validate(bad), undefined, bad);
  assert.strictEqual(cron.validate('  0   3 * * *  '), '0 3 * * *');
});

test('an impossible date gives null', () => {
  assert.strictEqual(cron.next('0 0 31 2 *', at('2026-03-10T00:00:00')), null);
});
