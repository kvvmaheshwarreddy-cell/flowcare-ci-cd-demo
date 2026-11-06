const router = require('express').Router();
const { wrap } = require('../middleware/error');
const { loadOps } = require('./dashboard');
const { forecastDepartment, departmentStatus, recommendations } = require('../services/patientForecast');

// GET /api/forecast/patients?hours=6 — per-department arrival forecasts + last 48h actuals
router.get('/patients', wrap(async (req, res) => {
  const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 6));
  const ops = await loadOps();
  const cutoff = Date.now() - 48 * 3600000;
  res.json({
    method: 'Hour-of-day seasonal average (14 days, same weekday weighted ×2) × recent 3h trend factor',
    departments: ops.departments.map((d) => ({
      id: d._id,
      name: d.name,
      history: ops.history
        .filter((h) => String(h.department) === String(d._id) && new Date(h.hourStart).getTime() >= cutoff)
        .sort((a, b) => new Date(a.hourStart) - new Date(b.hourStart))
        .map((h) => ({ hour: h.hourStart, arrivals: h.arrivals })),
      forecast: forecastDepartment(ops.history, d._id, new Date(), hours),
    })),
  });
}));

// GET /api/forecast/recommendations — staff/bed allocation advice and bottlenecks
router.get('/recommendations', wrap(async (req, res) => {
  const ops = await loadOps();
  const statuses = departmentStatus(ops);
  res.json({
    bottlenecks: statuses.filter((s) => s.load > 1 || s.occupancy >= 0.85),
    recommendations: recommendations(statuses, ops.staff),
  });
}));

module.exports = router;
