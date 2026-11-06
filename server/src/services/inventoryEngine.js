/**
 * Unified Inventory Engine (PRD extension, section 14).
 * One shared engine for every quantity-tracked resource: medicines, IV fluids, PPE,
 * lab reagents, emergency supplies, etc. Pure calculation helpers are exported
 * separately so they can be unit-tested without a database.
 */
const mongoose = require('mongoose');
const { InventoryItem, InventoryBatch, InventoryTransaction, PurchaseOrder } = require('../models/resources');
const { HttpError } = require('../middleware/error');
const { audit } = require('./audit');

const DAY = 24 * 3600 * 1000;
const MIN_HISTORY_DAYS = 14; // minimum days of consumption history before coverage is shown

// ---------- Pure calculations ----------

/** A batch is usable only if its status is "usable" and it has not passed its expiry date. */
function isUsable(batch, now = new Date()) {
  if (batch.status !== 'usable') return false;
  if (batch.expiryDate && new Date(batch.expiryDate) <= now) return false;
  return batch.quantity > 0;
}

/** Usable on-hand, unusable, reserved and available quantities. */
function computeBalances(batches, reservedQuantity = 0, now = new Date()) {
  let onHand = 0;
  let usable = 0;
  for (const b of batches) {
    onHand += b.quantity;
    if (isUsable(b, now)) usable += b.quantity;
  }
  const reserved = Math.min(reservedQuantity, usable);
  return { onHand, usable, unusable: onHand - usable, reserved, available: usable - reserved };
}

/** Builds a daily consumption series (issues only) for the last `days` days, oldest first. */
function dailyConsumption(transactions, days, now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = end.getTime() - (days - 1) * DAY;
  const series = new Array(days).fill(0);
  let firstSeen = null;
  for (const t of transactions) {
    if (t.type !== 'issue') continue;
    const ts = new Date(t.timestamp).getTime();
    if (firstSeen === null || ts < firstSeen) firstSeen = ts;
    const idx = Math.floor((ts - start) / DAY);
    if (idx >= 0 && idx < days) series[idx] += t.quantity;
  }
  const historyDays = firstSeen === null ? 0 : Math.min(days, Math.ceil((end.getTime() + DAY - firstSeen) / DAY));
  return { series, historyDays };
}

/** Estimated days of coverage = available / average daily consumption (only when reliable). */
function coverageDays(available, avgDaily, historyDays) {
  if (!(avgDaily > 0) || historyDays < MIN_HISTORY_DAYS) return null;
  return Math.round((available / avgDaily) * 10) / 10;
}

/** Reorder qty = demand during lead time + safety stock − available − incoming; never negative. */
function reorderQuantity({ avgDaily, leadTimeDays, safetyStock, available, incoming }) {
  const need = avgDaily * leadTimeDays + safetyStock - available - incoming;
  return need > 0 ? Math.ceil(need) : 0;
}

/** Stock status against configured thresholds. */
function stockStatus(available, item) {
  if (available <= 0) return 'out';
  if (available <= item.safetyStock) return 'critical';
  if (available <= item.reorderThreshold) return 'low';
  return 'ok';
}

// ---------- Database operations ----------

function newTxnId() {
  return 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

async function itemSummary(item, now = new Date()) {
  const [batches, txns, incomingAgg] = await Promise.all([
    InventoryBatch.find({ item: item._id }).lean(),
    InventoryTransaction.find({ item: item._id, type: 'issue', timestamp: { $gte: new Date(now - 60 * DAY) } }).lean(),
    PurchaseOrder.aggregate([
      { $match: { item: item._id, status: { $in: ['approved', 'ordered'] } } },
      { $group: { _id: null, qty: { $sum: '$quantity' } } },
    ]),
  ]);
  const bal = computeBalances(batches, item.reservedQuantity, now);
  const { series, historyDays } = dailyConsumption(txns, 28, now);
  const window = Math.max(1, Math.min(28, historyDays));
  const avgDaily = historyDays ? series.slice(-window).reduce((a, b) => a + b, 0) / window : 0;
  const incoming = incomingAgg[0]?.qty || 0;
  const soon = new Date(now.getTime() + 30 * DAY);
  return {
    ...bal,
    incoming,
    avgDaily: Math.round(avgDaily * 100) / 100,
    historyDays,
    coverageDays: coverageDays(bal.available, avgDaily, historyDays),
    reorderQuantity: reorderQuantity({ avgDaily, leadTimeDays: item.leadTimeDays, safetyStock: item.safetyStock, available: bal.available, incoming }),
    status: stockStatus(bal.available, item),
    expiringSoon: batches
      .filter((b) => isUsable(b, now) && b.expiryDate && new Date(b.expiryDate) <= soon)
      .reduce((a, b) => a + b.quantity, 0),
  };
}

/**
 * Records a stock movement. Quantities are changed only through this function,
 * and every change writes an append-only transaction.
 */
async function recordTransaction(input, user) {
  const item = await InventoryItem.findById(input.item);
  if (!item) throw new HttpError(404, 'Inventory item not found');
  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty === 0) throw new HttpError(400, 'quantity must be a non-zero number');
  if (input.type !== 'adjustment' && qty < 0) throw new HttpError(400, 'quantity must be positive');
  if (input.unit && input.unit !== item.unit) throw new HttpError(400, `Unit must be "${item.unit}" for this item`);

  const base = {
    item: item._id,
    unit: item.unit,
    user: user?.id,
    userName: user?.name,
    reason: input.reason || '',
    reference: input.reference,
    department: input.department,
  };
  const written = [];

  if (input.type === 'receipt') {
    if (!input.batchNo) throw new HttpError(400, 'batchNo is required for receipts');
    const location = input.destinationLocation || 'Main store';
    const batch = await InventoryBatch.findOneAndUpdate(
      { item: item._id, batchNo: input.batchNo, location },
      { $inc: { quantity: qty }, $setOnInsert: { expiryDate: input.expiryDate || undefined, status: 'usable' } },
      { upsert: true, new: true, runValidators: true },
    );
    written.push(await InventoryTransaction.create({ ...base, txnId: newTxnId(), type: 'receipt', quantity: qty, batch: batch._id, batchNo: batch.batchNo, destinationLocation: location }));
  } else if (input.type === 'issue') {
    // FEFO: first-expiring usable batches first. Each decrement is atomic and guarded against going negative.
    const summary = await itemSummary(item);
    if (qty > summary.available) throw new HttpError(400, `Only ${summary.available} ${item.unit} available to issue`);
    const filter = { item: item._id, status: 'usable', quantity: { $gt: 0 }, $or: [{ expiryDate: null }, { expiryDate: { $gt: new Date() } }] };
    if (input.batch) filter._id = input.batch;
    if (input.sourceLocation) filter.location = input.sourceLocation;
    const batches = await InventoryBatch.find(filter).sort({ expiryDate: 1, receivedAt: 1 });
    let remaining = qty;
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.quantity, remaining);
      const res = await InventoryBatch.updateOne({ _id: b._id, quantity: { $gte: take } }, { $inc: { quantity: -take } });
      if (res.modifiedCount !== 1) continue; // concurrent change; try next batch
      remaining -= take;
      written.push(await InventoryTransaction.create({ ...base, txnId: newTxnId(), type: 'issue', quantity: take, batch: b._id, batchNo: b.batchNo, sourceLocation: b.location }));
    }
    if (remaining > 0) throw new HttpError(409, `Could not issue the full quantity; ${remaining} ${item.unit} short. Partial issue was recorded.`);
  } else if (input.type === 'transfer') {
    if (!input.batch || !input.destinationLocation) throw new HttpError(400, 'batch and destinationLocation are required for transfers');
    const src = await InventoryBatch.findOneAndUpdate({ _id: input.batch, item: item._id, quantity: { $gte: qty } }, { $inc: { quantity: -qty } }, { new: true });
    if (!src) throw new HttpError(400, 'Not enough stock in the source batch');
    await InventoryBatch.findOneAndUpdate(
      { item: item._id, batchNo: src.batchNo, location: input.destinationLocation },
      { $inc: { quantity: qty }, $setOnInsert: { expiryDate: src.expiryDate, status: src.status } },
      { upsert: true, new: true },
    );
    written.push(await InventoryTransaction.create({ ...base, txnId: newTxnId(), type: 'transfer', quantity: qty, batch: src._id, batchNo: src.batchNo, sourceLocation: src.location, destinationLocation: input.destinationLocation }));
  } else if (input.type === 'adjustment') {
    if (!input.batch) throw new HttpError(400, 'batch is required for adjustments');
    if (!input.reason) throw new HttpError(400, 'A reason is required for adjustments');
    const filter = { _id: input.batch, item: item._id };
    if (qty < 0) filter.quantity = { $gte: -qty };
    const b = await InventoryBatch.findOneAndUpdate(filter, { $inc: { quantity: qty } }, { new: true });
    if (!b) throw new HttpError(400, 'Adjustment would make inventory negative');
    written.push(await InventoryTransaction.create({ ...base, txnId: newTxnId(), type: 'adjustment', quantity: qty, batch: b._id, batchNo: b.batchNo, sourceLocation: b.location }));
  } else {
    throw new HttpError(400, 'type must be receipt, issue, transfer or adjustment');
  }

  await audit(user, `inventory.${input.type}`, 'InventoryItem', item._id, { quantity: qty, reason: input.reason });
  return written;
}

/** Changes a batch's status (e.g. quarantine) — also recorded as a transaction. */
async function setBatchStatus(batchId, status, reason, user) {
  if (!['usable', 'quarantined', 'damaged', 'expired'].includes(status)) throw new HttpError(400, 'Invalid batch status');
  if (!reason) throw new HttpError(400, 'A reason is required');
  const b = await InventoryBatch.findById(batchId);
  if (!b) throw new HttpError(404, 'Batch not found');
  const item = await InventoryItem.findById(b.item);
  const from = b.status;
  b.status = status;
  await b.save();
  await InventoryTransaction.create({ txnId: newTxnId(), item: b.item, type: 'status_change', quantity: b.quantity, unit: item.unit, batch: b._id, batchNo: b.batchNo, sourceLocation: b.location, user: user?.id, userName: user?.name, reason: `${from} → ${status}: ${reason}` });
  await audit(user, 'inventory.batch_status', 'InventoryBatch', b._id, { from, to: status, reason });
  return b;
}

module.exports = {
  MIN_HISTORY_DAYS,
  isUsable,
  computeBalances,
  dailyConsumption,
  coverageDays,
  reorderQuantity,
  stockStatus,
  itemSummary,
  recordTransaction,
  setBatchStatus,
  mongoose,
};
