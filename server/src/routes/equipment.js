const router = require('express').Router();
const { MedicalEquipment, EquipmentMaintenance } = require('../models/resources');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { audit } = require('../services/audit');

const TYPES = ['ventilator', 'bipap', 'monitor', 'defibrillator', 'infusion_pump', 'oxygen_concentrator', 'other'];

router.get('/', wrap(async (req, res) => {
  const q = {};
  for (const k of ['type', 'status', 'department']) if (req.query[k]) q[k] = req.query[k];
  const now = new Date();
  const list = await MedicalEquipment.find(q).populate('department', 'name code').populate('assignedTo', 'fullName').sort('assetTag').lean();
  res.json(list.map((e) => ({ ...e, maintenanceOverdue: !!(e.nextMaintenanceDue && new Date(e.nextMaintenanceDue) < now) })));
}));

router.post('/', requirePermission('equipment:write'), wrap(async (req, res) => {
  validate(req.body, { assetTag: { required: true, type: 'string' }, name: { required: true, type: 'string' }, type: { required: true, enum: TYPES } });
  const e = await MedicalEquipment.create(req.body);
  await audit(req.user, 'equipment.create', 'MedicalEquipment', e._id);
  res.status(201).json(e);
}));

router.get('/:id/maintenance', wrap(async (req, res) => {
  res.json(await EquipmentMaintenance.find({ equipment: req.params.id }).sort({ performedAt: -1 }));
}));

// POST /api/equipment/:id/maintenance — records maintenance; status "open" takes the unit out of service
router.post('/:id/maintenance', requirePermission('equipment:write'), wrap(async (req, res) => {
  validate(req.body, { kind: { required: true, enum: ['maintenance', 'inspection', 'repair', 'calibration'] }, status: { enum: ['open', 'completed'] } });
  const e = await MedicalEquipment.findById(req.params.id);
  if (!e) throw new HttpError(404, 'Equipment not found');
  if (req.body.status === 'open' && e.status === 'in_use') throw new HttpError(409, 'Release the equipment from its patient before starting maintenance');
  const rec = await EquipmentMaintenance.create({ ...req.body, equipment: e._id, performedBy: req.user.name });
  if (rec.status === 'open') {
    e.status = 'maintenance';
  } else {
    if (rec.kind === 'inspection') e.nextInspectionDue = rec.nextDue || new Date(Date.now() + 90 * 86400000);
    else {
      e.lastMaintenance = rec.performedAt;
      e.nextMaintenanceDue = rec.nextDue || new Date(Date.now() + 180 * 86400000);
    }
    if (e.status === 'maintenance') e.status = 'available';
  }
  await e.save();
  await audit(req.user, 'equipment.maintenance', 'MedicalEquipment', e._id, { kind: rec.kind, status: rec.status });
  res.status(201).json({ record: rec, equipment: e });
}));

// POST /api/equipment/:id/allocate — only "available" equipment can be allocated (atomic)
router.post('/:id/allocate', requirePermission('equipment:allocate'), wrap(async (req, res) => {
  const e = await MedicalEquipment.findOneAndUpdate(
    { _id: req.params.id, status: 'available' },
    { status: 'in_use', assignedTo: req.body.patient || null, ...(req.body.department ? { department: req.body.department } : {}) },
    { new: true },
  );
  if (!e) throw new HttpError(409, 'This equipment is not available for allocation');
  await audit(req.user, 'equipment.allocate', 'MedicalEquipment', e._id, { patient: req.body.patient });
  res.json(e);
}));

router.post('/:id/release', requirePermission('equipment:allocate'), wrap(async (req, res) => {
  const e = await MedicalEquipment.findOneAndUpdate({ _id: req.params.id, status: 'in_use' }, { status: 'available', assignedTo: null }, { new: true });
  if (!e) throw new HttpError(409, 'Equipment is not in use');
  await audit(req.user, 'equipment.release', 'MedicalEquipment', e._id);
  res.json(e);
}));

module.exports = router;
