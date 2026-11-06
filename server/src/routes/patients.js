const router = require('express').Router();
const { Patient, Bed, ArrivalHistory } = require('../models/ops');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { audit } = require('../services/audit');

const PRIORITY = { critical: 0, urgent: 1, normal: 2, low: 3 };

// GET /api/patients?status=active|all&department=
router.get('/', wrap(async (req, res) => {
  const q = {};
  if (req.query.department) q.department = req.query.department;
  if (req.query.status !== 'all') q.status = { $ne: 'discharged' };
  const list = await Patient.find(q).populate('department', 'name code').populate('bed', 'label').lean();
  list.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || new Date(a.arrivedAt) - new Date(b.arrivedAt));
  res.json(list);
}));

router.post('/', requirePermission('patients:write'), wrap(async (req, res) => {
  validate(req.body, {
    fullName: { required: true, type: 'string' },
    department: { required: true },
    priority: { enum: ['critical', 'urgent', 'normal', 'low'] },
    age: { type: 'number', min: 0 },
  });
  const p = await Patient.create({ ...req.body, status: 'waiting', arrivedAt: new Date() });
  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  await ArrivalHistory.updateOne({ department: p.department, hourStart: hour }, { $inc: { arrivals: 1 } }, { upsert: true });
  await audit(req.user, 'patient.register', 'Patient', p._id);
  res.status(201).json(p);
}));

router.patch('/:id/status', requirePermission('patients:write'), wrap(async (req, res) => {
  validate(req.body, { status: { required: true, enum: ['waiting', 'in_consultation', 'admitted', 'discharged'] } });
  const p = await Patient.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Patient not found');
  const next = req.body.status;

  if (next === 'admitted' && !p.bed) {
    // Allocate an available bed atomically, preferring the patient's department.
    let bed = await Bed.findOneAndUpdate({ department: p.department, status: 'available' }, { status: 'occupied' }, { new: true });
    if (!bed) bed = await Bed.findOneAndUpdate({ status: 'available' }, { status: 'occupied' }, { new: true });
    if (!bed) throw new HttpError(409, 'No available beds in the hospital');
    p.bed = bed._id;
  }
  if (next === 'discharged') {
    if (p.bed) await Bed.updateOne({ _id: p.bed }, { status: 'cleaning' });
    p.bed = null;
    p.dischargedAt = new Date();
  }
  p.status = next;
  await p.save();
  await audit(req.user, 'patient.status', 'Patient', p._id, { status: next });
  res.json(await p.populate([{ path: 'bed', select: 'label' }, { path: 'department', select: 'name code' }]));
}));

module.exports = router;
