const router = require('express').Router();
const { Bed } = require('../models/ops');
const { requirePermission } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { audit } = require('../services/audit');

router.get('/', wrap(async (req, res) => {
  const q = {};
  if (req.query.department) q.department = req.query.department;
  if (req.query.status) q.status = req.query.status;
  res.json(await Bed.find(q).populate('department', 'name code').sort('label'));
}));

router.patch('/:id/status', requirePermission('beds:write'), wrap(async (req, res) => {
  validate(req.body, { status: { required: true, enum: ['available', 'occupied', 'cleaning', 'maintenance'] } });
  const bed = await Bed.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true, runValidators: true });
  if (!bed) throw new HttpError(404, 'Bed not found');
  await audit(req.user, 'bed.status', 'Bed', bed._id, { status: bed.status });
  res.json(bed);
}));

module.exports = router;
