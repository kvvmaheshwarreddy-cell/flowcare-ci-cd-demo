const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('./error');

const ROLES = ['admin', 'doctor', 'nurse', 'receptionist', 'resource_manager'];

/** Permission map: which roles may perform each action. Admin may do everything. */
const PERMISSIONS = {
  'patients:write': ['doctor', 'nurse', 'receptionist'],
  'beds:write': ['doctor', 'nurse', 'resource_manager'],
  'staff:write': ['resource_manager'],
  'inventory:read': ['doctor', 'nurse', 'resource_manager'],
  'inventory:manage': ['resource_manager'],
  'inventory:issue': ['doctor', 'nurse', 'resource_manager'],
  'oxygen:write': ['nurse', 'resource_manager'],
  'equipment:write': ['resource_manager'],
  'equipment:allocate': ['doctor', 'nurse', 'resource_manager'],
  'procurement:manage': ['resource_manager'],
  'users:manage': [],
  'audit:read': [],
};

function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (PERMISSIONS[permission] || []).includes(user.role);
}

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role, name: user.name }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Authentication required'));
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, role: payload.role, name: payload.name };
    next();
  } catch (e) {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

function requirePermission(permission) {
  return (req, res, next) =>
    can(req.user, permission) ? next() : next(new HttpError(403, 'You do not have permission for this action'));
}

module.exports = { ROLES, PERMISSIONS, can, signToken, authenticate, requirePermission };
