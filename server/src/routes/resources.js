const router = require('express').Router();
const { ResourceCategory, InventoryItem, InventoryBatch, InventoryTransaction, OxygenCylinder, MedicalEquipment, EquipmentMaintenance, PurchaseOrder, ResourceAlert, ResourceForecast } = require('../models/resources');
const { Bed, Staff, Patient } = require('../models/ops');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const engine = require('../services/inventoryEngine');
const { forecastItem, ventilatorCapacity } = require('../services/resourceForecast');
const { refreshAlerts } = require('../services/alerts');
const { audit } = require('../services/audit');

router.use(requirePermission('inventory:read'));

router.get('/categories', wrap(async (req, res) => res.json(await ResourceCategory.find().sort('name'))));

router.post('/categories', requirePermission('inventory:manage'), wrap(async (req, res) => {
  validate(req.body, { code: { required: true, type: 'string' }, name: { required: true, type: 'string' } });
  const c = await ResourceCategory.create(req.body);
  await audit(req.user, 'resource.category_create', 'ResourceCategory', c._id);
  res.status(201).json(c);
}));

// GET /api/resources/overview — every value is computed from database records
router.get('/overview', wrap(async (req, res) => {
  await refreshAlerts();
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 86400000);
  const [categories, items, beds, staff, cylinders, equipment, openMaint, alerts, expiringBatches, unusableBatches, forecasts] = await Promise.all([
    ResourceCategory.find().lean(),
    InventoryItem.find().populate('department', 'name').lean(),
    Bed.find().lean(),
    Staff.find().lean(),
    OxygenCylinder.find().lean(),
    MedicalEquipment.find().populate('department', 'name').lean(),
    EquipmentMaintenance.countDocuments({ status: 'open' }),
    ResourceAlert.find({ status: 'open' }).lean(),
    InventoryBatch.find({ status: 'usable', quantity: { $gt: 0 }, expiryDate: { $gt: now, $lte: soon } }).lean(),
    InventoryBatch.find({ quantity: { $gt: 0 }, $or: [{ status: { $in: ['quarantined', 'expired', 'damaged'] } }, { expiryDate: { $lte: now } }] }).lean(),
    ResourceForecast.find({ generatedAt: { $gte: new Date(now - 7 * 86400000) } }).lean(),
  ]);
  const summaries = await Promise.all(items.map(async (i) => ({ item: i, s: await engine.itemSummary(i, now) })));

  const byCategory = {};
  for (const { item, s } of summaries) {
    byCategory[item.category] = byCategory[item.category] || { items: 0, available: 0, low: 0 };
    byCategory[item.category].items += 1;
    byCategory[item.category].available += s.available;
    if (s.status !== 'ok') byCategory[item.category].low += 1;
  }
  const lowByDept = {};
  for (const { item, s } of summaries) if (s.status !== 'ok') {
    const d = item.department?.name || 'Central store';
    lowByDept[d] = (lowByDept[d] || 0) + 1;
  }
  const equipmentStatus = ['available', 'in_use', 'maintenance', 'out_of_service'].map((st) => ({ status: st, count: equipment.filter((e) => e.status === st).length }));
  const inspectionsDue = equipment.filter((e) => e.nextInspectionDue && new Date(e.nextInspectionDue) < new Date(now.getTime() + 7 * 86400000)).length
    + cylinders.filter((c) => c.nextInspectionDue && new Date(c.nextInspectionDue) < now).length;
  const latestForecast = {};
  for (const f of forecasts) if (!latestForecast[f.item] || f.generatedAt > latestForecast[f.item].generatedAt) latestForecast[f.item] = f;

  // Monthly consumption (issues) for the last 6 months
  const sixMonths = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const monthly = await InventoryTransaction.aggregate([
    { $match: { type: 'issue', timestamp: { $gte: sixMonths } } },
    { $lookup: { from: 'inventoryItems', localField: 'item', foreignField: '_id', as: 'i' } },
    { $unwind: '$i' },
    { $group: { _id: { m: { $dateToString: { format: '%Y-%m', date: '$timestamp' } }, c: '$i.category' }, qty: { $sum: '$quantity' } } },
    { $sort: { '_id.m': 1 } },
  ]);

  const usableCyl = cylinders.filter((c) => ['full', 'in_use'].includes(c.status)).length;
  const counts = (pred) => alerts.filter(pred).length;
  res.json({
    cards: {
      trackedCategories: categories.length,
      lowStockItems: summaries.filter((x) => x.s.status !== 'ok').length,
      criticalAlerts: counts((a) => a.severity === 'critical'),
      equipmentUnderMaintenance: equipment.filter((e) => e.status === 'maintenance').length,
      expiredOrQuarantinedBatches: unusableBatches.length,
      approachingExpiryBatches: expiringBatches.length,
      predictedShortages: Object.values(latestForecast).filter((f) => f.expectedShortage).length,
      pendingReplenishments: summaries.filter((x) => x.s.reorderQuantity > 0).length,
      openMaintenanceRequests: openMaint,
      outstandingInspections: inspectionsDue,
    },
    categories: categories.map((c) => {
      let headline;
      if (c.code === 'beds') headline = `${beds.filter((b) => b.status === 'available').length}/${beds.length} beds free`;
      else if (c.code === 'staff') headline = `${staff.filter((s) => s.onDuty).length}/${staff.length} on duty`;
      else if (c.code === 'oxygen') headline = `${usableCyl}/${cylinders.length} cylinders usable`;
      else if (c.code === 'ventilators' || c.code === 'emergency_equipment') {
        const types = c.code === 'ventilators' ? ['ventilator', 'bipap', 'oxygen_concentrator'] : ['defibrillator', 'monitor'];
        const eq = equipment.filter((e) => types.includes(e.type));
        headline = eq.length ? `${eq.filter((e) => e.status === 'available').length}/${eq.length} available` : null;
      }
      const inv = byCategory[c.code];
      if (!headline && inv) headline = `${inv.items} items · ${inv.low} low`;
      return { ...c, headline: headline || 'Not yet tracked', inventory: inv || null };
    }),
    charts: {
      quantityByCategory: Object.entries(byCategory).map(([k, v]) => ({ category: k, available: v.available })),
      lowStockByDepartment: Object.entries(lowByDept).map(([k, v]) => ({ department: k, count: v })),
      equipmentStatus,
      monthlyConsumption: monthly.map((m) => ({ month: m._id.m, category: m._id.c, quantity: m.qty })),
      shortagesBySeverity: ['critical', 'high', 'medium', 'low'].map((s) => ({ severity: s, count: counts((a) => a.severity === s) })),
      stockCoverage: summaries.filter((x) => x.s.coverageDays !== null).map((x) => ({ item: x.item.name, coverageDays: x.s.coverageDays, leadTimeDays: x.item.leadTimeDays })),
      expiringByRange: [
        { range: 'Expired', count: unusableBatches.filter((b) => b.expiryDate && new Date(b.expiryDate) <= now).length },
        { range: '0–7 days', count: expiringBatches.filter((b) => new Date(b.expiryDate) <= new Date(now.getTime() + 7 * 86400000)).length },
        { range: '8–30 days', count: expiringBatches.filter((b) => new Date(b.expiryDate) > new Date(now.getTime() + 7 * 86400000)).length },
      ],
    },
  });
}));

// POST /api/resources/forecasts/generate — computes and stores forecasts for all quantity-tracked items
router.post('/forecasts/generate', wrap(async (req, res) => {
  const horizonDays = Math.min(60, Math.max(1, Number(req.body.horizonDays) || 14));
  const now = new Date();
  const items = await InventoryItem.find().lean();
  const results = [];
  for (const item of items) {
    const summary = await engine.itemSummary(item, now);
    const transactions = await InventoryTransaction.find({ item: item._id, type: 'issue', timestamp: { $gte: new Date(now - 56 * 86400000) } }).lean();
    const f = forecastItem({ item, summary, transactions, horizonDays, now });
    await ResourceForecast.create({ ...f, generatedAt: now });
    results.push(f);
  }
  await audit(req.user, 'resource.forecast_generate', 'ResourceForecast', null, { items: results.length, horizonDays });
  res.status(201).json(results);
}));

router.get('/forecasts', wrap(async (req, res) => {
  const latest = await ResourceForecast.findOne().sort({ generatedAt: -1 }).lean();
  const consumables = latest ? await ResourceForecast.find({ generatedAt: latest.generatedAt }).lean() : [];
  const [equipment, critical] = await Promise.all([
    MedicalEquipment.find().lean(),
    Patient.countDocuments({ status: 'admitted', priority: { $in: ['critical', 'urgent'] } }),
  ]);
  res.json({ generatedAt: latest?.generatedAt || null, consumables, ventilators: ventilatorCapacity(equipment, critical) });
}));

router.get('/alerts', wrap(async (req, res) => {
  await refreshAlerts();
  const q = { status: req.query.status || { $ne: 'resolved' } };
  if (req.query.severity) q.severity = req.query.severity;
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const list = await ResourceAlert.find(q).lean();
  res.json(list.sort((a, b) => order[a.severity] - order[b.severity]));
}));

router.patch('/alerts/:id', wrap(async (req, res) => {
  validate(req.body, { status: { required: true, enum: ['acknowledged', 'open'] } });
  const a = await ResourceAlert.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (!a) throw new HttpError(404, 'Alert not found');
  await audit(req.user, 'resource.alert_status', 'ResourceAlert', a._id, { status: a.status });
  res.json(a);
}));

// GET /api/resources/reports — tabular stock report
router.get('/reports', wrap(async (req, res) => {
  const items = await InventoryItem.find().populate('department', 'name').lean();
  const rows = await Promise.all(items.map(async (i) => {
    const s = await engine.itemSummary(i);
    return { sku: i.sku, name: i.name, category: i.category, unit: i.unit, department: i.department?.name || '', onHand: s.onHand, usable: s.usable, unusable: s.unusable, reserved: s.reserved, available: s.available, avgDaily: s.avgDaily, coverageDays: s.coverageDays, status: s.status, reorderQuantity: s.reorderQuantity };
  }));
  const pos = await PurchaseOrder.countDocuments({ status: { $in: ['approved', 'ordered'] } });
  res.json({ generatedAt: new Date(), openPurchaseOrders: pos, rows });
}));

module.exports = router;
