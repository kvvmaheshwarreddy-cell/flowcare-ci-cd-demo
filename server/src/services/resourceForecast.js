/**
 * Resource demand forecasting (PRD extension, section 15).
 *
 * Consumables (quantity-tracked items): blended moving average of daily issues
 *   predicted daily = 0.6 × mean(last 7 days) + 0.4 × mean(last 28 days)
 *   with a day-of-week factor when ≥ 28 days of history exist.
 *   Uncertainty: ±1.96 × std(daily) × √horizon (approximate 95% interval).
 *   Evaluation: hold out the last 7 days, forecast them from earlier data, report MAE and MAPE.
 *   Items with < 14 days of history are reported as "insufficient data" — no forecast is invented.
 *
 * Oxygen (gas quantity): coverage hours = litres remaining ÷ (consumption L/min × 60),
 *   using validated measurements only.
 *
 * Ventilators (equipment capacity): compares operational units against expected workload
 *   (ICU/ER patients currently admitted) — a capacity check, not a consumption forecast.
 */
const { dailyConsumption, MIN_HISTORY_DAYS } = require('./inventoryEngine');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Predicts the next `horizon` days from a daily series (oldest first). */
function predictSeries(series, horizon, startDate) {
  const last7 = series.slice(-7);
  const last28 = series.slice(-28);
  const base = 0.6 * mean(last7) + 0.4 * mean(last28);
  // Day-of-week factors (only with ≥ 4 weeks of data)
  const dow = new Array(7).fill(1);
  if (series.length >= 28 && mean(last28) > 0) {
    const sums = new Array(7).fill(0);
    const counts = new Array(7).fill(0);
    last28.forEach((v, i) => {
      const d = new Date(startDate.getTime() - (last28.length - i) * 86400000).getDay();
      sums[d] += v;
      counts[d] += 1;
    });
    for (let d = 0; d < 7; d++) dow[d] = counts[d] ? sums[d] / counts[d] / mean(last28) : 1;
  }
  const daily = [];
  for (let h = 0; h < horizon; h++) {
    const d = new Date(startDate.getTime() + h * 86400000).getDay();
    daily.push(base * dow[d]);
  }
  return daily;
}

/** Back-test: forecast the last `holdout` days from the data before them. */
function evaluate(series, holdout = 7, now = new Date()) {
  if (series.length < holdout + MIN_HISTORY_DAYS) return null;
  const train = series.slice(0, -holdout);
  const actual = series.slice(-holdout);
  const start = new Date(now.getTime() - (holdout - 1) * 86400000);
  const pred = predictSeries(train, holdout, start);
  const errors = actual.map((a, i) => Math.abs(a - pred[i]));
  const pctErrors = actual.map((a, i) => (a > 0 ? Math.abs(a - pred[i]) / a : null)).filter((x) => x !== null);
  return { mae: round(mean(errors), 2), mape: pctErrors.length ? round(mean(pctErrors) * 100, 1) : null, holdoutDays: holdout };
}

function forecastItem({ item, summary, transactions, horizonDays = 14, now = new Date() }) {
  const { series, historyDays } = dailyConsumption(transactions, 56, now);
  const used = series.slice(-Math.max(historyDays, 1));
  const result = {
    item: item._id,
    resourceName: item.name,
    category: item.category,
    unit: item.unit,
    horizonDays,
    method: 'Blended moving average (7d/28d) with day-of-week factors',
    available: summary.available,
    historyDays,
    insufficientData: historyDays < MIN_HISTORY_DAYS,
  };
  if (result.insufficientData) {
    return { ...result, note: `Only ${historyDays} days of consumption history; at least ${MIN_HISTORY_DAYS} are needed.` };
  }
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const daily = predictSeries(used, horizonDays, tomorrow);
  const predicted = daily.reduce((a, b) => a + b, 0);
  const margin = 1.96 * std(used.slice(-28)) * Math.sqrt(horizonDays);
  const avgDaily = predicted / horizonDays;
  const coverage = avgDaily > 0 ? summary.available / avgDaily : null;
  return {
    ...result,
    avgDaily: round(avgDaily, 2),
    predictedDemand: round(predicted),
    lower: round(Math.max(0, predicted - margin)),
    upper: round(predicted + margin),
    coverageDays: coverage === null ? null : round(coverage),
    expectedShortage: predicted > summary.available + summary.incoming,
    evaluation: evaluate(used, 7, now),
    recommendedAction:
      predicted > summary.available + summary.incoming
        ? `Order at least ${Math.ceil(predicted - summary.available - summary.incoming)} ${item.unit} within ${item.leadTimeDays} days`
        : 'No action needed within horizon',
  };
}

/** Oxygen supply coverage using the latest validated measurement per source. */
function oxygenCoverage(measurements) {
  const latest = {};
  for (const m of measurements) {
    if (!m.validated) continue;
    const prev = latest[m.sourceName];
    if (!prev || new Date(m.recordedAt) > new Date(prev.recordedAt)) latest[m.sourceName] = m;
  }
  return Object.values(latest).map((m) => ({
    sourceName: m.sourceName,
    source: m.source,
    litersRemaining: m.litersRemaining,
    consumptionLpm: m.consumptionLpm,
    recordedAt: m.recordedAt,
    coverageHours: m.consumptionLpm > 0 ? round(m.litersRemaining / (m.consumptionLpm * 60)) : null,
  }));
}

/** Ventilator capacity vs expected workload. */
function ventilatorCapacity(equipment, admittedCriticalPatients) {
  const vents = equipment.filter((e) => e.type === 'ventilator');
  const operational = vents.filter((e) => e.status === 'available' || e.status === 'in_use').length;
  const free = vents.filter((e) => e.status === 'available').length;
  return {
    total: vents.length,
    operational,
    free,
    inMaintenance: vents.filter((e) => e.status === 'maintenance').length,
    expectedDemand: admittedCriticalPatients,
    shortage: admittedCriticalPatients > operational,
  };
}

module.exports = { predictSeries, evaluate, forecastItem, oxygenCoverage, ventilatorCapacity };
