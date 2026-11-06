const router = require('express').Router();
const { Department, Bed, Staff, Patient, ArrivalHistory } = require('../models/ops');
const { wrap } = require('../middleware/error');
const { departmentStatus, recommendations } = require('../services/patientForecast');

async function loadOps() {
  const since = new Date(Date.now() - 14 * 86400000);
  const [departments, beds, staff, patients, history] = await Promise.all([
    Department.find().sort('name').lean(),
    Bed.find().lean(),
    Staff.find().lean(),
    Patient.find({ status: { $ne: 'discharged' } }).lean(),
    ArrivalHistory.find({ hourStart: { $gte: since } }).lean(),
  ]);
  return { departments, beds, staff, patients, history };
}

// GET /api/dashboard — live operations summary
router.get('/', wrap(async (req, res) => {
  const ops = await loadOps();
  const statuses = departmentStatus(ops);
  const longest = [...statuses].sort((a, b) => b.waitMinutes - a.waitMinutes)[0];
  res.json({
    totals: {
      waiting: ops.patients.filter((p) => p.status === 'waiting').length,
      criticalWaiting: ops.patients.filter((p) => p.status === 'waiting' && p.priority === 'critical').length,
      bedsAvailable: ops.beds.filter((b) => b.status === 'available').length,
      bedsTotal: ops.beds.length,
      staffOnDuty: ops.staff.filter((s) => s.onDuty).length,
      staffTotal: ops.staff.length,
      longestWait: longest ? { minutes: longest.waitMinutes, department: longest.department.name } : null,
    },
    departments: statuses,
    recommendations: recommendations(statuses, ops.staff),
  });
}));

module.exports = router;
module.exports.loadOps = loadOps;
