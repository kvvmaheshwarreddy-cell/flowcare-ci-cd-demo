const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { User } = require('../models/ops');
const { requirePermission, ROLES } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { audit } = require('../services/audit');

router.use(requirePermission('users:manage'));

router.get('/', wrap(async (req, res) => res.json(await User.find().select('-passwordHash').sort('name'))));

router.post('/', wrap(async (req, res) => {
  validate(req.body, { name: { required: true }, email: { required: true }, password: { required: true }, role: { required: true, enum: ROLES } });
  const u = await User.create({ ...req.body, passwordHash: await bcrypt.hash(req.body.password, 10) });
  await audit(req.user, 'user.create', 'User', u._id, { role: u.role });
  res.status(201).json({ id: u._id, name: u.name, email: u.email, role: u.role });
}));

router.patch('/:id', wrap(async (req, res) => {
  if (req.params.id === req.user.id && req.body.role && req.body.role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role');
  const update = {};
  if (req.body.role) {
    validate(req.body, { role: { enum: ROLES } });
    update.role = req.body.role;
  }
  if ('active' in req.body) update.active = !!req.body.active;
  const u = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-passwordHash');
  if (!u) throw new HttpError(404, 'User not found');
  await audit(req.user, 'user.update', 'User', u._id, update);
  res.json(u);
}));

module.exports = router;
