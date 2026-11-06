const router = require('express').Router();
const { AuditLog } = require('../models/resources');
const { requirePermission } = require('../middleware/auth');
const { wrap } = require('../middleware/error');

router.get('/', requirePermission('audit:read'), wrap(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  res.json(await AuditLog.find().sort({ at: -1 }).limit(limit));
}));

module.exports = router;
