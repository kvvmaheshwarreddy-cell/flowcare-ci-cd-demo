const router = require('express').Router();
const { Staff } = require('../models/ops');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { audit } = require('../services/audit');

router.get('/', wrap(async (req, res) => res.json(await Staff.find().populate('department', 'name code').sort('fullName'))));

router.post('/', requirePermission('staff:write'), wrap(async (req, res) => {
  validate(req.body, { fullName: { required: true, type: 'string' }, role: { required: true, enum: ['doctor', 'nurse', 'technician', 'support'] } });
  const s = await Staff.create(req.body);
  await audit(req.user, 'staff.create', 'Staff', s._id);
  res.status(201).json(s);
}));

router.patch('/:id', requirePermission('staff:write'), wrap(async (req, res) => {
  const allowed = {};
  for (const k of ['department', 'shift', 'onDuty']) if (k in req.body) allowed[k] = req.body[k];
  const s = await Staff.findByIdAndUpdate(req.params.id, allowed, { new: true, runValidators: true });
  if (!s) throw new HttpError(404, 'Staff member not found');
  await audit(req.user, 'staff.update', 'Staff', s._id, allowed);
  res.json(s);
}));

module.exports = router;
