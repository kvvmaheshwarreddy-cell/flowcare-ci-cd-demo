/**
 * Resource alert engine (PRD extension, section 17).
 * - "confirmed" alerts come from actual stock / status records.
 * - "forecasted" alerts come from predictions and are capped at HIGH severity:
 *   an uncertain prediction alone never produces a CRITICAL alert.
 * Severity also considers the item's configured criticality.
 */
const { InventoryItem, InventoryBatch, OxygenCylinder, OxygenMeasurement, MedicalEquipment, ResourceAlert } = require('../models/resources');
const { itemSummary } = require('./inventoryEngine');
const { oxygenCoverage } = require('./resourceForecast');

const DAY = 86400000;
const OXYGEN_CRITICAL_HOURS = 6;
const OXYGEN_HIGH_HOURS = 24;

function stockAlert(item, s) {
  const essential = item.criticality === 'essential';
  const metrics = { available: s.available, safetyStock: item.safetyStock, reorderThreshold: item.reorderThreshold, unit: item.unit };
  if (s.status === 'out')
    return { severity: essential ? 'critical' : 'high', kind: 'confirmed', title: `${item.name} is out of stock`, detail: 'No usable stock available.', metrics };
  if (s.status === 'critical')
    return { severity: essential ? 'critical' : 'high', kind: 'confirmed', title: `${item.name} below safety stock`, detail: `${s.available} ${item.unit} available (safety stock ${item.safetyStock}).`, metrics };
  if (s.status === 'low')
    return { severity: 'medium', kind: 'confirmed', title: `${item.name} below reorder threshold`, detail: `${s.available} ${item.unit} available (reorder at ${item.reorderThreshold}).`, metrics };
  return null;
}

function forecastAlert(item, s) {
  // Forecasted shortage: lead-time demand exceeds stock + incoming. Needs reliable history.
  if (s.coverageDays === null || s.status === 'out') return null;
  if (s.coverageDays < item.leadTimeDays) {
    return {
      severity: item.criticality === 'essential' ? 'high' : 'medium',
      kind: 'forecasted',
      title: `${item.name} may run out before resupply`,
      detail: `Estimated ${s.coverageDays} days of coverage vs ${item.leadTimeDays}-day lead time (forecast, based on ${s.historyDays} days of history).`,
      metrics: { coverageDays: s.coverageDays, leadTimeDays: item.leadTimeDays, avgDaily: s.avgDaily, incoming: s.incoming },
    };
  }
  return null;
}

async function buildAlerts(now = new Date()) {
  const out = [];
  const items = await InventoryItem.find().lean();
  for (const item of items) {
    const s = await itemSummary(item, now);
    const a = stockAlert(item, s);
    if (a) out.push({ key: `stock:${item._id}`, category: item.category, ...a });
    const f = forecastAlert(item, s);
    if (f) out.push({ key: `forecast:${item._id}`, category: item.category, ...f });
    if (s.expiringSoon > 0)
      out.push({ key: `expiring:${item._id}`, category: item.category, severity: item.criticality === 'essential' ? 'high' : 'medium', kind: 'expiry', title: `${item.name}: ${s.expiringSoon} ${item.unit} expire within 30 days`, detail: 'Use first (FEFO) or arrange return.', metrics: { quantity: s.expiringSoon } });
  }

  const expiredUsable = await InventoryBatch.find({ status: 'usable', expiryDate: { $lte: now }, quantity: { $gt: 0 } }).populate('item').lean();
  for (const b of expiredUsable)
    out.push({ key: `expired:${b._id}`, category: b.item?.category, severity: 'high', kind: 'expiry', title: `Expired batch ${b.batchNo} of ${b.item?.name} still on shelf`, detail: `${b.quantity} ${b.item?.unit} at ${b.location} — excluded from usable stock; quarantine or dispose.`, metrics: { quantity: b.quantity } });

  const equipment = await MedicalEquipment.find().lean();
  for (const e of equipment) {
    if (e.nextMaintenanceDue && new Date(e.nextMaintenanceDue) < now)
      out.push({ key: `maint:${e._id}`, category: e.type, severity: 'high', kind: 'maintenance', title: `${e.name} (${e.assetTag}) maintenance overdue`, detail: `Due ${new Date(e.nextMaintenanceDue).toDateString()}.` });
    else if (e.nextInspectionDue && new Date(e.nextInspectionDue) < new Date(now.getTime() + 7 * DAY))
      out.push({ key: `insp:${e._id}`, category: e.type, severity: 'medium', kind: 'maintenance', title: `${e.name} (${e.assetTag}) inspection due soon`, detail: `Due ${new Date(e.nextInspectionDue).toDateString()}.` });
  }
  const vents = equipment.filter((e) => e.type === 'ventilator');
  if (vents.length && vents.every((v) => v.status !== 'available'))
    out.push({ key: 'vent:none-free', category: 'ventilator', severity: 'critical', kind: 'confirmed', title: 'No ventilator available for allocation', detail: `${vents.length} ventilators: all in use or unavailable.` });

  const cylinders = await OxygenCylinder.find().lean();
  const fullCyl = cylinders.filter((c) => c.status === 'full').length;
  if (cylinders.length && fullCyl === 0)
    out.push({ key: 'o2:no-full', category: 'oxygen', severity: 'critical', kind: 'confirmed', title: 'No full oxygen cylinders in stock', detail: 'All cylinders are in use, empty or unavailable.' });
  for (const c of cylinders) {
    if (c.nextInspectionDue && new Date(c.nextInspectionDue) < now)
      out.push({ key: `o2insp:${c._id}`, category: 'oxygen', severity: 'medium', kind: 'maintenance', title: `Cylinder ${c.cylinderId} inspection overdue`, detail: `Located at ${c.location}.` });
  }
  const measurements = await OxygenMeasurement.find({ recordedAt: { $gte: new Date(now.getTime() - 2 * DAY) } }).lean();
  for (const cov of oxygenCoverage(measurements)) {
    if (cov.coverageHours === null) continue;
    if (cov.coverageHours < OXYGEN_HIGH_HOURS)
      out.push({
        key: `o2cov:${cov.sourceName}`,
        category: 'oxygen',
        // Based on a validated measurement and current flow rate — still an estimate.
        severity: cov.coverageHours < OXYGEN_CRITICAL_HOURS ? 'critical' : 'high',
        kind: cov.coverageHours < OXYGEN_CRITICAL_HOURS ? 'confirmed' : 'forecasted',
        title: `${cov.sourceName}: ~${cov.coverageHours}h of oxygen left`,
        detail: `${cov.litersRemaining} L at ${cov.consumptionLpm} L/min (validated reading ${new Date(cov.recordedAt).toLocaleString()}).`,
        metrics: cov,
      });
  }
  return out;
}

/** Recomputes alerts, upserts them, and resolves alerts whose condition has cleared. */
async function refreshAlerts(now = new Date()) {
  const fresh = await buildAlerts(now);
  const keys = fresh.map((a) => a.key);
  for (const a of fresh) {
    await ResourceAlert.updateOne(
      { key: a.key },
      { $set: { ...a, lastSeenAt: now }, $setOnInsert: { status: 'open' } },
      { upsert: true },
    );
    await ResourceAlert.updateOne({ key: a.key, status: 'resolved' }, { $set: { status: 'open' } });
  }
  await ResourceAlert.updateMany({ key: { $nin: keys }, status: { $ne: 'resolved' } }, { $set: { status: 'resolved' } });
  return fresh.length;
}

module.exports = { buildAlerts, refreshAlerts, stockAlert, forecastAlert, OXYGEN_CRITICAL_HOURS, OXYGEN_HIGH_HOURS };
