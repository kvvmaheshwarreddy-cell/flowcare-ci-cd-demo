const router = require('express').Router();
const { InventoryItem, PurchaseOrder } = require('../models/resources');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const engine = require('../services/inventoryEngine');
const { audit } = require('../services/audit');

router.use(requirePermission('inventory:read'));

// GET /api/procurement/recommendations — items whose reorder requirement is positive
router.get('/recommendations', wrap(async (req, res) => {
  const items = await InventoryItem.find().lean();
  const out = [];
  for (const i of items) {
    const s = await engine.itemSummary(i);
    if (s.reorderQuantity > 0 || s.status !== 'ok') {
      out.push({
        item: { _id: i._id, name: i.name, sku: i.sku, unit: i.unit, category: i.category, supplier: i.supplier },
        recommendedQuantity: s.reorderQuantity,
        metrics: {
          available: s.available,
          incoming: s.incoming,
          avgDaily: s.avgDaily,
          leadTimeDays: i.leadTimeDays,
          safetyStock: i.safetyStock,
          coverageDays: s.coverageDays,
          historyDays: s.historyDays,
        },
        explanation: `Lead-time demand ${Math.round(s.avgDaily * i.leadTimeDays)} + safety stock ${i.safetyStock} − available ${s.available} − incoming ${s.incoming}`,
        status: s.status,
      });
    }
  }
  res.json(out.sort((a, b) => b.recommendedQuantity - a.recommendedQuantity));
}));

router.get('/purchase-orders', wrap(async (req, res) => {
  res.json(await PurchaseOrder.find().populate('item', 'name sku unit').sort({ createdAt: -1 }));
}));

router.post('/purchase-orders', requirePermission('procurement:manage'), wrap(async (req, res) => {
  validate(req.body, { item: { required: true }, quantity: { required: true, type: 'number', min: 1 } });
  const item = await InventoryItem.findById(req.body.item);
  if (!item) throw new HttpError(404, 'Item not found');
  const po = await PurchaseOrder.create({
    poNumber: 'PO-' + Date.now().toString(36).toUpperCase(),
    item: item._id,
    quantity: req.body.quantity,
    supplier: req.body.supplier || item.supplier,
    expectedDate: req.body.expectedDate || new Date(Date.now() + item.leadTimeDays * 86400000),
    notes: req.body.notes,
    createdBy: req.user.name,
  });
  await audit(req.user, 'procurement.po_create', 'PurchaseOrder', po._id, { quantity: po.quantity });
  res.status(201).json(po);
}));

const PO_FLOW = { draft: ['approved', 'cancelled'], approved: ['ordered', 'cancelled'], ordered: ['received', 'cancelled'], received: [], cancelled: [] };

// PATCH /api/procurement/purchase-orders/:id/status — "received" books a stock receipt
router.patch('/purchase-orders/:id/status', requirePermission('procurement:manage'), wrap(async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) throw new HttpError(404, 'Purchase order not found');
  const next = req.body.status;
  if (!PO_FLOW[po.status].includes(next)) throw new HttpError(400, `Cannot move order from "${po.status}" to "${next}"`);
  if (next === 'received') {
    if (!req.body.batchNo) throw new HttpError(400, 'batchNo is required to receive an order');
    await engine.recordTransaction(
      { item: po.item, type: 'receipt', quantity: po.quantity, batchNo: req.body.batchNo, expiryDate: req.body.expiryDate, reference: po.poNumber, reason: 'Purchase order received' },
      req.user,
    );
  }
  po.status = next;
  await po.save();
  await audit(req.user, 'procurement.po_status', 'PurchaseOrder', po._id, { status: next });
  res.json(po);
}));

module.exports = router;
