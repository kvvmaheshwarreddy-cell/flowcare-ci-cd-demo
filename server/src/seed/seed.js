/**
 * Demo data loader. Run with: npm run seed   (WARNING: wipes the configured database)
 * All names and numbers are fictional and for demonstration only.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');
const ops = require('../models/ops');
const res = require('../models/resources');

const DAY = 86400000;
const DEMO_PASSWORD = 'Password123!';

// Deterministic pseudo-random generator so demo data is the same on every run.
let s = 42;
const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

async function seed({ now = new Date(), log = console.log } = {}) {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  s = 42;

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = await ops.User.insertMany([
    { name: 'Asha Admin', email: 'admin@demo.local', role: 'admin', passwordHash: hash },
    { name: 'Dr. Anika Rao', email: 'doctor@demo.local', role: 'doctor', passwordHash: hash },
    { name: 'Priya Kumar', email: 'nurse@demo.local', role: 'nurse', passwordHash: hash },
    { name: 'Ravi Front Desk', email: 'reception@demo.local', role: 'receptionist', passwordHash: hash },
    { name: 'Meena Resources', email: 'resources@demo.local', role: 'resource_manager', passwordHash: hash },
  ]);
  const rm = users[4];

  const depts = await ops.Department.insertMany([
    { name: 'Emergency', code: 'ER', avgServiceMinutes: 25 },
    { name: 'Cardiology', code: 'CARD', avgServiceMinutes: 35 },
    { name: 'Orthopedics', code: 'ORTH', avgServiceMinutes: 30 },
    { name: 'Pediatrics', code: 'PED', avgServiceMinutes: 20 },
    { name: 'General Medicine', code: 'GEN', avgServiceMinutes: 15 },
    { name: 'ICU', code: 'ICU', avgServiceMinutes: 60 },
  ]);
  const D = Object.fromEntries(depts.map((d) => [d.code, d]));

  // Beds
  const bedCounts = { ER: 14, CARD: 10, ORTH: 10, PED: 10, GEN: 16, ICU: 8 };
  const beds = [];
  for (const [code, n] of Object.entries(bedCounts)) {
    for (let g = 1; g <= n; g++) {
      const status = g % 7 === 0 ? 'cleaning' : g % 11 === 0 ? 'maintenance' : g % 3 === 0 || g % 4 === 0 || (['ER', 'ICU'].includes(code) && g % 2 === 0) ? 'occupied' : 'available';
      beds.push({ label: `${code}-${String(g).padStart(2, '0')}`, department: D[code]._id, bedType: code === 'ICU' ? 'icu' : code === 'PED' ? 'pediatric' : 'general', status });
    }
  }
  const bedDocs = await ops.Bed.insertMany(beds);

  await ops.Staff.insertMany(
    [
      ['Dr. Anika Rao', 'doctor', 'ER', 'day', true], ['Dr. Vikram Shah', 'doctor', 'ER', 'night', false],
      ['Dr. Meera Iyer', 'doctor', 'CARD', 'day', true], ['Dr. Rahul Menon', 'doctor', 'ORTH', 'day', true],
      ['Dr. Sara Thomas', 'doctor', 'PED', 'day', true], ['Dr. Arjun Nair', 'doctor', 'GEN', 'evening', false],
      ['Dr. Leela Das', 'doctor', 'ICU', 'day', true], ['Dr. Kabir Sethi', 'doctor', 'GEN', 'day', true],
      ['Priya Kumar', 'nurse', 'ER', 'day', true], ['Ravi Pillai', 'nurse', 'ER', 'day', true],
      ['Divya Reddy', 'nurse', 'CARD', 'day', true], ['Kiran Joshi', 'nurse', 'ORTH', 'evening', false],
      ['Neha Gupta', 'nurse', 'PED', 'day', true], ['Suresh Babu', 'nurse', 'GEN', 'day', true],
      ['Fatima Khan', 'nurse', 'ICU', 'day', true], ['Manoj Verma', 'nurse', 'ICU', 'night', false],
      ['Aditya Sen', 'technician', 'GEN', 'day', true], ['Lakshmi Prasad', 'support', 'ER', 'day', true],
    ].map(([fullName, role, c, shift, onDuty]) => ({ fullName, role, department: D[c]._id, shift, onDuty })),
  );

  const patients = [
    ['Rohan Mehta', 45, 'ER', 'critical', 'waiting', 'Chest pain', 12], ['Ananya Singh', 29, 'ER', 'urgent', 'waiting', 'Deep laceration', 38],
    ['Karthik R', 61, 'ER', 'normal', 'waiting', 'Dizziness', 55], ['Pooja Desai', 34, 'ER', 'normal', 'waiting', 'High fever', 72],
    ['Imran Ali', 52, 'ER', 'urgent', 'in_consultation', 'Breathing difficulty', 20], ['Sneha Patil', 8, 'PED', 'normal', 'waiting', 'Ear infection', 25],
    ['Aarav Jain', 5, 'PED', 'urgent', 'waiting', 'Persistent vomiting', 40], ['Gita Bose', 70, 'CARD', 'urgent', 'waiting', 'Palpitations', 65],
    ['Harish Kumar', 58, 'CARD', 'normal', 'waiting', 'Follow-up ECG', 90], ['Nisha Varma', 41, 'ORTH', 'normal', 'waiting', 'Knee pain', 48],
    ['Tarun Ghosh', 23, 'ORTH', 'urgent', 'waiting', 'Suspected fracture', 30], ['Zoya Sheikh', 36, 'GEN', 'low', 'waiting', 'Routine checkup', 15],
    ['Bala Krishnan', 66, 'GEN', 'normal', 'waiting', 'Diabetes review', 33], ['Ritu Malhotra', 49, 'GEN', 'normal', 'in_consultation', 'Back pain', 10],
  ].map(([fullName, age, c, priority, status, complaint, m]) => ({ fullName, age, department: D[c]._id, priority, status, complaint, arrivedAt: new Date(now - m * 60000) }));
  const icuBed = bedDocs.find((b) => b.label === 'ICU-02');
  patients.push({ fullName: 'Om Prakash', age: 77, department: D.ICU._id, priority: 'critical', status: 'admitted', complaint: 'Post-op monitoring', bed: icuBed._id, arrivedAt: new Date(now - 300 * 60000) });
  const patientDocs = await ops.Patient.insertMany(patients);

  // 14 days of hourly arrivals with daytime/evening peaks
  const base = { ER: 6, GEN: 5, PED: 3, CARD: 2.5, ORTH: 2.5, ICU: 0.8 };
  const hourNow = new Date(now);
  hourNow.setMinutes(0, 0, 0);
  const arrivals = [];
  for (const d of depts) {
    for (let h = 14 * 24; h >= 1; h--) {
      const t = new Date(hourNow.getTime() - h * 3600000);
      const hr = t.getHours();
      const shape = 0.35 + 0.9 * Math.exp(-(((hr - 11) / 4) ** 2)) + 0.4 * Math.exp(-(((hr - 19) / 3) ** 2));
      const wk = [0, 6].includes(t.getDay()) ? 0.8 : 1;
      arrivals.push({ department: d._id, hourStart: t, arrivals: Math.max(0, Math.round(base[d.code] * shape * wk + (rand() * 2 - 1))) });
    }
  }
  await ops.ArrivalHistory.insertMany(arrivals);

  // Resource categories (PRD extension section 16)
  await res.ResourceCategory.insertMany([
    ['beds', 'Beds and wards', 'capacity'], ['oxygen', 'Oxygen and medical gases', 'asset'], ['medicines', 'Medicines', 'quantity'],
    ['blood', 'Blood products', 'quantity'], ['ventilators', 'Ventilators and respiratory equipment', 'asset'],
    ['iv_fluids', 'IV fluids and consumables', 'quantity'], ['ppe', 'PPE and infection control', 'quantity'],
    ['emergency_equipment', 'Emergency equipment', 'asset'], ['surgical', 'Surgical resources', 'quantity'],
    ['laboratory', 'Laboratory resources', 'quantity'], ['ambulances', 'Ambulances and transport', 'asset'],
    ['infrastructure', 'Infrastructure and utilities', 'asset'], ['staff', 'Staff', 'capacity'],
  ].map(([code, name, tracking]) => ({ code, name, tracking })));

  // Inventory items: [sku, name, category, unit, dept, criticality, reorder, safety, lead, dailyUse, finalStock, restricted]
  const itemDefs = [
    ['MED-PARA500', 'Paracetamol 500 mg tablets', 'medicines', 'strip', 'GEN', 'important', 120, 40, 5, 22, 380],
    ['MED-AMOX250', 'Amoxicillin 250 mg capsules', 'medicines', 'strip', 'GEN', 'important', 80, 30, 7, 9, 60],
    ['MED-ADREN1', 'Adrenaline 1 mg/ml ampoule', 'medicines', 'ampoule', 'ER', 'essential', 40, 20, 5, 3, 18],
    ['MED-MORPH10', 'Morphine 10 mg injection', 'medicines', 'ampoule', 'ICU', 'essential', 30, 10, 10, 2, 45, true],
    ['MED-INSUL', 'Insulin (regular) 10 ml vial', 'medicines', 'vial', 'GEN', 'essential', 25, 10, 7, 2.5, 34],
    ['IV-NS500', 'Normal saline 0.9% 500 ml', 'iv_fluids', 'bag', 'ER', 'essential', 150, 60, 4, 35, 210],
    ['IV-RL500', "Ringer's lactate 500 ml", 'iv_fluids', 'bag', 'ER', 'important', 100, 40, 4, 18, 95],
    ['IV-SET', 'IV infusion set', 'iv_fluids', 'piece', 'GEN', 'important', 200, 80, 5, 40, 520],
    ['PPE-N95', 'N95 respirator', 'ppe', 'piece', 'ICU', 'essential', 300, 120, 7, 55, 260],
    ['PPE-GLOVE', 'Nitrile gloves (box of 100)', 'ppe', 'box', 'GEN', 'important', 60, 20, 5, 9, 140],
    ['PPE-GOWN', 'Isolation gown', 'ppe', 'piece', 'ICU', 'important', 150, 50, 7, 20, 120],
    ['LAB-CBC', 'CBC reagent kit', 'laboratory', 'kit', 'GEN', 'important', 10, 4, 14, 0.8, 22],
    ['LAB-GLU', 'Glucose test strips (box)', 'laboratory', 'box', 'GEN', 'routine', 15, 5, 7, 1.5, 8],
    ['SURG-SUT', 'Absorbable sutures 3-0', 'surgical', 'pack', 'ORTH', 'important', 40, 15, 10, 4, 75],
    ['EMR-AIRWAY', 'Adult airway kit', 'emergency_equipment', 'kit', 'ER', 'essential', 8, 4, 10, 0.3, 6],
    ['BLD-PRBC-OP', 'Packed red cells O+ (unit)', 'blood', 'unit', 'ICU', 'essential', 12, 6, 2, 1.8, 14, true],
  ];
  const items = await res.InventoryItem.insertMany(
    itemDefs.map(([sku, name, category, unit, dept, criticality, reorderThreshold, safetyStock, leadTimeDays, , , restricted]) => ({
      sku, name, category, unit, department: D[dept]._id, criticality, reorderThreshold, safetyStock, leadTimeDays, restricted: !!restricted,
      supplier: category === 'medicines' ? 'MediSupply Pvt Ltd' : category === 'blood' ? 'Regional Blood Centre' : 'CareGoods Distributors',
      reservedQuantity: sku === 'IV-NS500' ? 20 : 0,
    })),
  );

  // Batches + 35 days of synthetic issue history so balances and forecasts have real inputs.
  const batches = [];
  const txns = [];
  let n = 0;
  const id = () => `SEED-${String(++n).padStart(5, '0')}`;
  items.forEach((item, idx) => {
    const [, , , , , , , , , daily, finalStock] = itemDefs[idx];
    const firstQty = Math.round(finalStock * 0.35);
    const secondQty = finalStock - firstQty;
    const soonExpiry = idx % 4 === 0; // some batches expire within 30 days
    batches.push(
      { item: item._id, batchNo: `${item.sku}-A`, quantity: firstQty, status: 'usable', expiryDate: new Date(now.getTime() + (soonExpiry ? 12 : 120) * DAY), location: 'Main store', receivedAt: new Date(now - 40 * DAY) },
      { item: item._id, batchNo: `${item.sku}-B`, quantity: secondQty, status: 'usable', expiryDate: new Date(now.getTime() + 300 * DAY), location: 'Main store', receivedAt: new Date(now - 10 * DAY) },
    );
    txns.push({ txnId: id(), item: item._id, type: 'receipt', quantity: firstQty, unit: item.unit, batchNo: `${item.sku}-A`, destinationLocation: 'Main store', userName: rm.name, reason: 'Opening stock (demo)', timestamp: new Date(now - 40 * DAY) });
    txns.push({ txnId: id(), item: item._id, type: 'receipt', quantity: secondQty, unit: item.unit, batchNo: `${item.sku}-B`, destinationLocation: 'Main store', userName: rm.name, reason: 'Delivery (demo)', timestamp: new Date(now - 10 * DAY) });
    for (let d = 35; d >= 1; d--) {
      const t = new Date(now - d * DAY);
      const wk = [0, 6].includes(t.getDay()) ? 0.7 : 1.1;
      const trend = 1 + (35 - d) * 0.006; // gently rising use
      const q = Math.max(0, Math.round(daily * wk * trend * (0.75 + rand() * 0.5)));
      if (q > 0) txns.push({ txnId: id(), item: item._id, type: 'issue', quantity: q, unit: item.unit, batchNo: `${item.sku}-A`, sourceLocation: 'Main store', department: item.department, userName: 'Ward staff', reason: 'Ward consumption (demo)', timestamp: new Date(t.getTime() + 10 * 3600000) });
    }
  });
  // Unusable stock examples: quarantined, expired, damaged
  batches.push(
    { item: items[5]._id, batchNo: 'IV-NS500-Q', quantity: 40, status: 'quarantined', expiryDate: new Date(now.getTime() + 200 * DAY), location: 'Main store' },
    { item: items[0]._id, batchNo: 'MED-PARA500-OLD', quantity: 25, status: 'usable', expiryDate: new Date(now - 3 * DAY), location: 'ER pharmacy' },
    { item: items[8]._id, batchNo: 'PPE-N95-DMG', quantity: 30, status: 'damaged', location: 'ICU store' },
  );
  await res.InventoryBatch.insertMany(batches);
  await res.InventoryTransaction.insertMany(txns);

  // Oxygen cylinders
  const cyl = [];
  const statuses = ['full', 'full', 'full', 'in_use', 'in_use', 'empty', 'refilling', 'full', 'in_use', 'empty', 'maintenance', 'full', 'in_use', 'quarantined', 'full', 'in_use', 'empty', 'full', 'in_use', 'full'];
  const locs = ['ER', 'ICU', 'GEN', 'PED', 'CARD'];
  statuses.forEach((st, i) => {
    const size = i % 3 === 0 ? 'H' : 'D';
    const loc = locs[i % locs.length];
    cyl.push({ cylinderId: `O2-${String(i + 1).padStart(3, '0')}`, size, capacityLiters: size === 'H' ? 6900 : 340, status: st, location: `${D[loc].name} ward`, department: D[loc]._id, lastInspection: new Date(now - (60 + i * 9) * DAY), nextInspectionDue: new Date(now.getTime() + (i % 6 === 5 ? -5 : 30 + i * 5) * DAY) });
  });
  await res.OxygenCylinder.insertMany(cyl);
  await res.OxygenMeasurement.insertMany([
    { source: 'central_tank', sourceName: 'Central liquid oxygen tank', litersRemaining: 820000, consumptionLpm: 950, validated: true, validatedBy: rm.name, recordedBy: rm.name, recordedAt: new Date(now - 2 * 3600000) },
    { source: 'manifold', sourceName: 'ICU manifold', litersRemaining: 27600, consumptionLpm: 42, validated: true, validatedBy: rm.name, recordedBy: 'Fatima Khan', recordedAt: new Date(now - 3600000) },
    { source: 'manifold', sourceName: 'ER manifold', litersRemaining: 9000, consumptionLpm: 35, validated: true, validatedBy: rm.name, recordedBy: 'Priya Kumar', recordedAt: new Date(now - 1800000) },
    { source: 'manifold', sourceName: 'ER manifold', litersRemaining: 2000, consumptionLpm: 35, validated: false, recordedBy: 'Unverified sensor', recordedAt: new Date(now - 600000) },
  ]);

  // Equipment
  const eqDefs = [
    ['VEN-001', 'Hamilton C3 ventilator', 'ventilator', 'ICU', 'in_use', -20, 160], ['VEN-002', 'Hamilton C3 ventilator', 'ventilator', 'ICU', 'in_use', -40, 140],
    ['VEN-003', 'Dräger Savina ventilator', 'ventilator', 'ICU', 'available', -90, 90], ['VEN-004', 'Dräger Savina ventilator', 'ventilator', 'ER', 'maintenance', -200, -10],
    ['VEN-005', 'Transport ventilator', 'ventilator', 'ER', 'available', -30, 150], ['BIP-001', 'BiPAP machine', 'bipap', 'ICU', 'available', -15, 165],
    ['MON-001', 'Patient monitor', 'monitor', 'ICU', 'in_use', -50, 130], ['MON-002', 'Patient monitor', 'monitor', 'ER', 'available', -70, 110],
    ['MON-003', 'Patient monitor', 'monitor', 'CARD', 'available', -190, -5], ['DEF-001', 'Defibrillator', 'defibrillator', 'ER', 'available', -60, 120],
    ['DEF-002', 'Defibrillator', 'defibrillator', 'CARD', 'available', -100, 80], ['INF-001', 'Infusion pump', 'infusion_pump', 'GEN', 'in_use', -25, 155],
    ['INF-002', 'Infusion pump', 'infusion_pump', 'GEN', 'out_of_service', -300, -120], ['CON-001', 'Oxygen concentrator 10 L', 'oxygen_concentrator', 'GEN', 'available', -45, 135],
  ];
  const eq = await res.MedicalEquipment.insertMany(
    eqDefs.map(([assetTag, name, type, c, status, last, next], i) => ({
      assetTag, name, type, department: D[c]._id, status, lastMaintenance: new Date(now.getTime() + last * DAY), nextMaintenanceDue: new Date(now.getTime() + next * DAY),
      nextInspectionDue: new Date(now.getTime() + (i % 4 === 0 ? 4 : 45) * DAY), assignedTo: status === 'in_use' && type === 'ventilator' ? patientDocs[patientDocs.length - 1]._id : null,
    })),
  );
  await res.EquipmentMaintenance.insertMany([
    { equipment: eq[3]._id, kind: 'repair', status: 'open', notes: 'Flow sensor fault reported', performedBy: rm.name, performedAt: new Date(now - 2 * DAY) },
    { equipment: eq[0]._id, kind: 'maintenance', status: 'completed', notes: 'Preventive maintenance', performedBy: 'Biomed team', performedAt: new Date(now - 20 * DAY) },
    { equipment: eq[9]._id, kind: 'inspection', status: 'completed', notes: 'Battery and pads checked', performedBy: 'Biomed team', performedAt: new Date(now - 60 * DAY) },
  ]);

  await res.PurchaseOrder.insertMany([
    { poNumber: 'PO-DEMO-001', item: items[2]._id, quantity: 40, supplier: 'MediSupply Pvt Ltd', status: 'ordered', expectedDate: new Date(now.getTime() + 3 * DAY), createdBy: rm.name },
    { poNumber: 'PO-DEMO-002', item: items[8]._id, quantity: 500, supplier: 'CareGoods Distributors', status: 'draft', createdBy: rm.name },
  ]);

  log(`Seeded ${users.length} users, ${depts.length} departments, ${bedDocs.length} beds, ${patientDocs.length} patients, ${items.length} inventory items, ${cyl.length} cylinders, ${eq.length} equipment.`);
  return { users, depts, items };
}

if (require.main === module) {
  mongoose
    .connect(config.mongoUri)
    .then(() => seed())
    .then(() => {
      console.log(`\nDemo logins (password: ${DEMO_PASSWORD}):`);
      ['admin', 'doctor', 'nurse', 'reception', 'resources'].forEach((u) => console.log(`  ${u}@demo.local`));
      return mongoose.disconnect();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { seed, DEMO_PASSWORD };
