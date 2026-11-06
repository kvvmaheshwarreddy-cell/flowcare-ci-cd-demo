const { AuditLog } = require('../models/resources');

async function audit(user, action, entity, entityId, details) {
  try {
    await AuditLog.create({ user: user?.id, userName: user?.name, action, entity, entityId: entityId && String(entityId), details });
  } catch (e) {
    console.error('Audit log failed', e.message);
  }
}

module.exports = { audit };
