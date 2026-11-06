const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { User } = require('../models/ops');
const { signToken, authenticate } = require('../middleware/auth');
const { wrap, validate, HttpError } = require('../middleware/error');
const { audit } = require('../services/audit');

// POST /api/auth/login
router.post('/login', wrap(async (req, res) => {
  validate(req.body, { email: { required: true, type: 'string' }, password: { required: true, type: 'string' } });
  const user = await User.findOne({ email: req.body.email.toLowerCase() });
  if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
    throw new HttpError(401, 'Incorrect email or password');
  }
  await audit({ id: user._id, name: user.name }, 'auth.login', 'User', user._id);
  res.json({ token: signToken(user), user: { id: user._id, name: user.name, email: user.email, role: user.role } });
}));

// POST /api/auth/register — public sign-up always creates a receptionist; admins assign other roles.
router.post('/register', wrap(async (req, res) => {
  validate(req.body, { name: { required: true, type: 'string' }, email: { required: true, type: 'string' }, password: { required: true, type: 'string' } });
  if (req.body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const user = await User.create({ name: req.body.name, email: req.body.email, passwordHash: await bcrypt.hash(req.body.password, 10), role: 'receptionist' });
  res.status(201).json({ token: signToken(user), user: { id: user._id, name: user.name, email: user.email, role: user.role } });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const user = await User.findById(req.user.id).select('-passwordHash');
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
}));

module.exports = router;
