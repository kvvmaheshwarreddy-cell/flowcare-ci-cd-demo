/**
 * Patient-demand forecasting and allocation recommendations (original PRD).
 * Method: hour-of-day seasonal average from 14 days of arrivals (same weekday weighted ×2),
 * multiplied by a trend factor = recent 3h actual ÷ expected (clamped 0.5–2).
 */
const OCCUPANCY_ALERT = 0.85;

function seasonalProfile(history, deptId) {
  const sums = {};
  for (const h of history) {
    if (String(h.department) !== String(deptId)) continue;
    const d = new Date(h.hourStart);
    for (const key of [`h${d.getHours()}`, `d${d.getDay()}h${d.getHours()}`]) {
      sums[key] = sums[key] || { total: 0, n: 0 };
      sums[key].total += h.arrivals;
      sums[key].n += 1;
    }
  }
  return (date) => {
    const hk = sums[`h${date.getHours()}`];
    const dk = sums[`d${date.getDay()}h${date.getHours()}`];
    const hAvg = hk ? hk.total / hk.n : 0;
    const dAvg = dk ? dk.total / dk.n : hAvg;
    return (hAvg + 2 * dAvg) / 3;
  };
}

function trendFactor(history, deptId, now, lookback = 3) {
  const profile = seasonalProfile(history, deptId);
  let actual = 0;
  let expected = 0;
  for (let i = 1; i <= lookback; i++) {
    const t = new Date(now);
    t.setMinutes(0, 0, 0);
    t.setHours(t.getHours() - i);
    const pt = history.find((h) => String(h.department) === String(deptId) && new Date(h.hourStart).getTime() === t.getTime());
    actual += pt ? pt.arrivals : 0;
    expected += profile(t);
  }
  if (expected <= 0) return 1;
  return Math.min(2, Math.max(0.5, actual / expected));
}

function forecastDepartment(history, deptId, now = new Date(), hours = 6) {
  const profile = seasonalProfile(history, deptId);
  const trend = trendFactor(history, deptId, now);
  const out = [];
  for (let i = 0; i < hours; i++) {
    const t = new Date(now);
    t.setMinutes(0, 0, 0);
    t.setHours(t.getHours() + i);
    out.push({ hour: t, predicted: Math.round(profile(t) * trend * 10) / 10 });
  }
  return out;
}

const estimateWaitMinutes = (waiting, avgService, doctors) =>
  waiting <= 0 ? 0 : Math.round((waiting * avgService) / Math.max(doctors, 1));
const capacity = (avgService, doctors, hours) => Math.floor((60 / avgService) * doctors * hours);

function departmentStatus({ departments, beds, staff, patients, history, now = new Date() }) {
  return departments.map((dept) => {
    const id = String(dept._id);
    const db = beds.filter((b) => String(b.department) === id);
    const ds = staff.filter((s) => String(s.department) === id && s.onDuty);
    const waitingList = patients.filter((p) => String(p.department) === id && p.status === 'waiting');
    const doctors = ds.filter((s) => s.role === 'doctor').length;
    const predicted3h = Math.round(forecastDepartment(history, id, now, 3).reduce((a, b) => a + b.predicted, 0));
    const cap = capacity(dept.avgServiceMinutes, doctors, 3);
    const demand = waitingList.length + predicted3h;
    return {
      department: { id, name: dept.name, code: dept.code },
      avgServiceMinutes: dept.avgServiceMinutes,
      waiting: waitingList.length,
      critical: waitingList.filter((p) => p.priority === 'critical').length,
      doctors,
      nurses: ds.filter((s) => s.role === 'nurse').length,
      bedsTotal: db.length,
      bedsAvailable: db.filter((b) => b.status === 'available').length,
      bedsCleaning: db.filter((b) => b.status === 'cleaning').length,
      occupancy: db.length ? db.filter((b) => b.status === 'occupied').length / db.length : 0,
      waitMinutes: estimateWaitMinutes(waitingList.length, dept.avgServiceMinutes, doctors),
      predicted3h,
      capacity3h: cap,
      load: cap > 0 ? demand / cap : demand > 0 ? 9 : 0,
    };
  });
}

function recommendations(statuses, staff) {
  const recs = [];
  const surplus = statuses.filter((s) => s.load < 0.6 && s.doctors > 1).sort((a, b) => a.load - b.load);
  for (const s of [...statuses].sort((a, b) => b.load - a.load)) {
    if (s.load > 1) {
      const perDoc = Math.max(capacity(s.avgServiceMinutes, 1, 3), 1);
      const needed = Math.max(1, Math.ceil((s.waiting + s.predicted3h) / perDoc) - s.doctors);
      const donor = surplus.find((d) => d.department.id !== s.department.id);
      const offDuty = staff.filter((x) => x.role === 'doctor' && !x.onDuty).length;
      recs.push({
        severity: s.load > 1.5 ? 'critical' : 'warning',
        title: `${s.department.name} needs ${needed} more doctor${needed > 1 ? 's' : ''}`,
        detail:
          `${s.waiting} waiting and ~${s.predicted3h} expected in 3h vs capacity of ${s.capacity3h}. ` +
          (donor
            ? `Reassign a doctor from ${donor.department.name} (${Math.round(donor.load * 100)}% load).`
            : offDuty
              ? `Call in one of ${offDuty} off-duty doctors.`
              : 'Consider extending the current shift.'),
        metrics: { waiting: s.waiting, predicted3h: s.predicted3h, capacity3h: s.capacity3h, load: Math.round(s.load * 100) / 100 },
      });
    }
    if (s.occupancy >= OCCUPANCY_ALERT) {
      recs.push({
        severity: s.bedsAvailable === 0 ? 'critical' : 'warning',
        title: `${s.department.name} beds at ${Math.round(s.occupancy * 100)}% occupancy`,
        detail: `${s.bedsAvailable} of ${s.bedsTotal} available. Review discharges${s.bedsCleaning ? ` and expedite cleaning of ${s.bedsCleaning} beds` : ''}.`,
        metrics: { occupancy: Math.round(s.occupancy * 100) / 100, bedsAvailable: s.bedsAvailable },
      });
    }
    if (s.critical > 0) {
      recs.push({
        severity: 'critical',
        title: `${s.critical} critical patient(s) waiting in ${s.department.name}`,
        detail: 'Fast-track to consultation ahead of the queue.',
        metrics: { critical: s.critical },
      });
    }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return recs.sort((a, b) => order[a.severity] - order[b.severity]);
}

module.exports = { OCCUPANCY_ALERT, seasonalProfile, trendFactor, forecastDepartment, estimateWaitMinutes, capacity, departmentStatus, recommendations };
