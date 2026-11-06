const router = require('express').Router();
const { OxygenCylinder, OxygenMeasurement } = require('../models/resources');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { oxygenCoverage } = require('../services/resourceForecast');
const { audit } = require('../services/audit');

const STATUSES = ['full', 'in_use', 'empty', 'refilling', 'maintenance', 'quarantined'];
/** Allowed cylinder status transitions. */
const TRANSITIONS = {
  full: ['in_use', 'maintenance', 'quarantined'],
  in_use: ['empty', 'full', 'quarantined'],
  empty: ['refilling', 'maintenance', 'quarantined'],
  refilling: ['full', 'quarantined'],
  maintenance: ['empty', 'full', 'quarantined'],
  quarantined: ['maintenance', 'empty'],
};
const USABLE = ['full', 'in_use'];

router.get('/cylinders', wrap(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  if (req.query.department) q.department = req.query.department;
  const list = await OxygenCylinder.find(q).populate('department', 'name code').sort('cylinderId').lean();
  const now = new Date();
  res.json(list.map((c) => ({ ...c, usable: USABLE.includes(c.status), inspectionOverdue: !!(c.nextInspectionDue && new Date(c.nextInspectionDue) < now) })));
}));

router.get('/summary', wrap(async (req, res) => {
  const cylinders = await OxygenCylinder.find().lean();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, cylinders.filter((c) => c.status === s).length]));
  const usable = cylinders.filter((c) => USABLE.includes(c.status));
  const measurements = await OxygenMeasurement.find({ recordedAt: { $gte: new Date(Date.now() - 2 * 86400000) } }).lean();
  res.json({
    total: cylinders.length,
    byStatus,
    usableCount: usable.length,
    fullLiters: cylinders.filter((c) => c.status === 'full').reduce((a, c) => a + c.capacityLiters, 0),
    inspectionsOverdue: cylinders.filter((c) => c.nextInspectionDue && new Date(c.nextInspectionDue) < new Date()).length,
    supply: oxygenCoverage(measurements),
    note: 'Coverage uses validated measurements only. Unvalidated readings are stored but ignored.',
  });
}));

router.post('/cylinders', requirePermission('oxygen:write'), wrap(async (req, res) => {
  validate(req.body, { cylinderId: { required: true, type: 'string' }, capacityLiters: { required: true, type: 'number', min: 1 }, location: { required: true, type: 'string' }, status: { enum: STATUSES } });
  const c = await OxygenCylinder.create(req.body);
  await audit(req.user, 'oxygen.cylinder_create', 'OxygenCylinder', c._id);
  res.status(201).json(c);
}));

router.patch('/cylinders/:id/status', requirePermission('oxygen:write'), wrap(async (req, res) => {
  validate(req.body, { status: { required: true, enum: STATUSES } });
  const c = await OxygenCylinder.findById(req.params.id);
  if (!c) throw new HttpError(404, 'Cylinder not found');
  if (!TRANSITIONS[c.status].includes(req.body.status)) {
    throw new HttpError(400, `Cannot change a cylinder from "${c.status}" to "${req.body.status}". Allowed: ${TRANSITIONS[c.status].join(', ')}`);
  }
  const from = c.status;
  c.status = req.body.status;
  if (req.body.location) c.location = req.body.location;
  if (req.body.inspected) {
    c.lastInspection = new Date();
    c.nextInspectionDue = new Date(Date.now() + 180 * 86400000);
  }
  await c.save();
  await audit(req.user, 'oxygen.cylinder_status', 'OxygenCylinder', c._id, { from, to: c.status, location: c.location });
  res.json(c);
}));

router.post('/measurements', requirePermission('oxygen:write'), wrap(async (req, res) => {
  validate(req.body, {
    source: { required: true, enum: ['central_tank', 'manifold', 'concentrator'] },
    sourceName: { required: true, type: 'string' },
    litersRemaining: { required: true, type: 'number', min: 0 },
    consumptionLpm: { required: true, type: 'number', min: 0 },
  });
  const m = await OxygenMeasurement.create({
    ...req.body,
    validated: !!req.body.validated,
    validatedBy: req.body.validated ? req.user.name : undefined,
    recordedBy: req.user.name,
    recordedAt: new Date(),
  });
  await audit(req.user, 'oxygen.measurement', 'OxygenMeasurement', m._id, { validated: m.validated });
  res.status(201).json(m);
}));

router.get('/measurements', wrap(async (req, res) => {
  res.json(await OxygenMeasurement.find().sort({ recordedAt: -1 }).limit(100));
}));

module.exports = router;
module.exports.TRANSITIONS = TRANSITIONS;
