// Unit tests for the pure calculations (no database needed).
const { describe, it: test } = require('node:test');
const assert = require('node:assert/strict');
const expect = (actual) => ({
  toBe: (expected) => assert.strictEqual(actual, expected),
  toEqual: (expected) => assert.deepStrictEqual(actual, expected),
  toBeNull: () => assert.strictEqual(actual, null),
  toBeUndefined: () => assert.strictEqual(actual, undefined),
});
const { computeBalances, coverageDays, reorderQuantity, stockStatus, dailyConsumption } = require('../src/services/inventoryEngine');
const { estimateWaitMinutes, capacity } = require('../src/services/patientForecast');
const { oxygenCoverage, evaluate, forecastItem } = require('../src/services/resourceForecast');
const { stockAlert, forecastAlert } = require('../src/services/alerts');

const now = new Date('2026-10-12T12:00:00Z');

describe('inventory calculations', () => {
  test('available = usable on-hand − reserved; expired, quarantined and damaged are excluded', () => {
    const batches = [
      { quantity: 100, status: 'usable', expiryDate: new Date('2027-01-01') },
      { quantity: 40, status: 'quarantined' },
      { quantity: 30, status: 'damaged' },
      { quantity: 25, status: 'usable', expiryDate: new Date('2026-10-01') }, // expired by date
    ];
    expect(computeBalances(batches, 20, now)).toEqual({ onHand: 195, usable: 100, unusable: 95, reserved: 20, available: 80 });
  });

  test('coverage days = available ÷ average daily use, hidden without 14 days of history', () => {
    expect(coverageDays(100, 10, 28)).toBe(10);
    expect(coverageDays(100, 10, 5)).toBeNull();
    expect(coverageDays(100, 0, 28)).toBeNull();
  });

  test('reorder = lead-time demand + safety stock − available − incoming, never negative', () => {
    expect(reorderQuantity({ avgDaily: 10, leadTimeDays: 7, safetyStock: 30, available: 50, incoming: 20 })).toBe(30);
    expect(reorderQuantity({ avgDaily: 1, leadTimeDays: 2, safetyStock: 0, available: 500, incoming: 0 })).toBe(0);
  });

  test('stock status thresholds', () => {
    const item = { safetyStock: 10, reorderThreshold: 30 };
    expect(stockStatus(0, item)).toBe('out');
    expect(stockStatus(10, item)).toBe('critical');
    expect(stockStatus(30, item)).toBe('low');
    expect(stockStatus(31, item)).toBe('ok');
  });

  test('daily consumption counts issues only', () => {
    const t = (d, type, q) => ({ type, quantity: q, timestamp: new Date(now.getTime() - d * 86400000) });
    const { series, historyDays } = dailyConsumption([t(1, 'issue', 5), t(1, 'receipt', 100), t(2, 'issue', 3)], 7, now);
    expect(series.reduce((a, b) => a + b, 0)).toBe(8);
    expect(historyDays).toBe(3);
  });
});

describe('patient flow rules', () => {
  test('wait = waiting × service minutes ÷ doctors', () => {
    expect(estimateWaitMinutes(4, 15, 2)).toBe(30);
    expect(estimateWaitMinutes(3, 20, 0)).toBe(60);
  });
  test('3-hour capacity with 2 doctors at 20 minutes is 18', () => {
    expect(capacity(20, 2, 3)).toBe(18);
  });
});

describe('forecasting and alerts', () => {
  test('oxygen coverage uses validated readings only', () => {
    const cov = oxygenCoverage([
      { sourceName: 'ER', litersRemaining: 2100, consumptionLpm: 35, validated: true, recordedAt: new Date(1) },
      { sourceName: 'ER', litersRemaining: 10, consumptionLpm: 35, validated: false, recordedAt: new Date(2) },
    ]);
    expect(cov[0].coverageHours).toBe(1);
  });

  test('forecast reports insufficient data instead of inventing numbers', () => {
    const f = forecastItem({ item: { _id: 'x', name: 'X', unit: 'u', leadTimeDays: 5 }, summary: { available: 10, incoming: 0 }, transactions: [], now });
    expect(f.insufficientData).toBe(true);
    expect(f.predictedDemand).toBeUndefined();
  });

  test('evaluation metrics are computed from a hold-out window', () => {
    const series = new Array(28).fill(10);
    expect(evaluate(series, 7, now)).toEqual({ mae: 0, mape: 0, holdoutDays: 7 });
  });

  test('forecasted shortage is never CRITICAL; confirmed out-of-stock of essential item is', () => {
    const item = { name: 'Adrenaline', unit: 'amp', criticality: 'essential', safetyStock: 5, reorderThreshold: 10, leadTimeDays: 7 };
    expect(forecastAlert(item, { coverageDays: 2, status: 'ok', historyDays: 30 }).severity).toBe('high');
    expect(stockAlert(item, { status: 'out', available: 0 }).severity).toBe('critical');
    expect(stockAlert({ ...item, criticality: 'routine' }, { status: 'out', available: 0 }).severity).toBe('high');
  });
});
