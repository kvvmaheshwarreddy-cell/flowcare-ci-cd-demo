const router = require('express').Router();
const { InventoryItem, InventoryBatch, InventoryTransaction } = require('../models/resources');
const { requirePermission, can } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const engine = require('../services/inventoryEngine');
const { audit } = require('../services/audit');

router.use(requirePermission('inventory:read'));

/** Restricted items (e.g. controlled medicines) are hidden from roles without manage rights. */
const visibleFilter = (user) => (can(user, 'inventory:manage') || user.role === 'doctor' ? {} : { restricted: { $ne: true } });

async function withSummaries(items) {
  return Promise.all(items.map(async (i) => ({ ...i, summary: await engine.itemSummary(i) })));
}

// GET /api/inventory/items?category=&department=&status=
router.get('/items', wrap(async (req, res) => {
  const q = { ...visibleFilter(req.user) };
  if (req.query.category) q.category = req.query.category;
  if (req.query.department) q.department = req.query.department;
  let list = await withSummaries(await InventoryItem.find(q).populate('department', 'name code').sort('name').lean());
  if (req.query.status) list = list.filter((i) => i.summary.status === req.query.status);
  res.json(list);
}));

router.post('/items', requirePermission('inventory:manage'), wrap(async (req, res) => {
  validate(req.body, {
    sku: { required: true, type: 'string' },
    name: { required: true, type: 'string' },
    category: { required: true, type: 'string' },
    unit: { required: true, type: 'string' },
    reorderThreshold: { type: 'number', min: 0 },
    safetyStock: { type: 'number', min: 0 },
    leadTimeDays: { type: 'number', min: 0 },
    criticality: { enum: ['essential', 'important', 'routine'] },
  });
  const item = await InventoryItem.create(req.body);
  await audit(req.user, 'inventory.item_create', 'InventoryItem', item._id);
  res.status(201).json(item);
}));

router.get('/items/:id', wrap(async (req, res) => {
  const item = await InventoryItem.findOne({ _id: req.params.id, ...visibleFilter(req.user) }).populate('department', 'name code').lean();
  if (!item) throw new HttpError(404, 'Item not found');
  const [batches, transactions] = await Promise.all([
    InventoryBatch.find({ item: item._id }).sort({ expiryDate: 1 }).lean(),
    InventoryTransaction.find({ item: item._id }).sort({ timestamp: -1 }).limit(50).lean(),
  ]);
  const now = new Date();
  res.json({ ...item, summary: await engine.itemSummary(item), batches: batches.map((b) => ({ ...b, usable: engine.isUsable(b, now) })), transactions });
}));

// PATCH /api/inventory/items/:id — settings only; quantities change via transactions
router.patch('/items/:id', requirePermission('inventory:manage'), wrap(async (req, res) => {
  const allowed = {};
  for (const k of ['reorderThreshold', 'safetyStock', 'leadTimeDays', 'criticality', 'reservedQuantity', 'supplier', 'department']) if (k in req.body) allowed[k] = req.body[k];
  const item = await InventoryItem.findByIdAndUpdate(req.params.id, allowed, { new: true, runValidators: true });
  if (!item) throw new HttpError(404, 'Item not found');
  await audit(req.user, 'inventory.item_settings', 'InventoryItem', item._id, allowed);
  res.json(item);
}));

router.get('/low-stock', wrap(async (req, res) => {
  const list = await withSummaries(await InventoryItem.find(visibleFilter(req.user)).populate('department', 'name code').lean());
  res.json(list.filter((i) => i.summary.status !== 'ok').sort((a, b) => a.summary.available - b.summary.available));
}));

// GET /api/inventory/expiring?days=30 — includes already-expired batches
router.get('/expiring', wrap(async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const until = new Date(Date.now() + days * 86400000);
  const batches = await InventoryBatch.find({ expiryDate: { $lte: until }, quantity: { $gt: 0 } }).populate('item', 'name sku unit category restricted').sort({ expiryDate: 1 }).lean();
  const restrictedOk = Object.keys(visibleFilter(req.user)).length === 0;
  res.json(batches.filter((b) => restrictedOk || !b.item?.restricted).map((b) => ({ ...b, expired: new Date(b.expiryDate) <= new Date() })));
}));

router.post('/transactions', wrap(async (req, res) => {
  validate(req.body, { item: { required: true }, type: { required: true, enum: ['receipt', 'issue', 'transfer', 'adjustment'] }, quantity: { required: true, type: 'number' } });
  const perm = req.body.type === 'issue' ? 'inventory:issue' : 'inventory:manage';
  if (!can(req.user, perm)) throw new HttpError(403, 'You do not have permission for this transaction type');
  res.status(201).json(await engine.recordTransaction(req.body, req.user));
}));

router.get('/transactions', wrap(async (req, res) => {
  const q = {};
  if (req.query.item) q.item = req.query.item;
  if (req.query.type) q.type = req.query.type;
  if (req.query.from || req.query.to) q.timestamp = {};
  if (req.query.from) q.timestamp.$gte = new Date(req.query.from);
  if (req.query.to) q.timestamp.$lte = new Date(req.query.to);
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  res.json(await InventoryTransaction.find(q).populate('item', 'name sku').sort({ timestamp: -1 }).limit(limit));
}));

// PATCH /api/inventory/batches/:id/status — quarantine / damaged / expired / usable
router.patch('/batches/:id/status', requirePermission('inventory:manage'), wrap(async (req, res) => {
  res.json(await engine.setBatchStatus(req.params.id, req.body.status, req.body.reason, req.user));
}));

module.exports = router;
