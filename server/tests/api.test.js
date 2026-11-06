// API tests against an in-memory MongoDB, seeded with the demo data.
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const { seed, DEMO_PASSWORD } = require('../src/seed/seed');
const { InventoryTransaction } = require('../src/models/resources');

let mongo;
const tokens = {};
const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await seed({ log: () => {} });
  for (const who of ['admin', 'doctor', 'nurse', 'reception', 'resources']) {
    const r = await request(app).post('/api/auth/login').send({ email: `${who}@demo.local`, password: DEMO_PASSWORD });
    tokens[who] = r.body.token;
  }
});
afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('auth and roles', () => {
  test('rejects wrong password and missing token', async () => {
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@demo.local', password: 'nope' })).status).toBe(401);
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
  });
  test('receptionist cannot read inventory; nurse can', async () => {
    expect((await request(app).get('/api/inventory/items').set(as('reception'))).status).toBe(403);
    expect((await request(app).get('/api/inventory/items').set(as('nurse'))).status).toBe(200);
  });
  test('restricted items are hidden from nurses', async () => {
    const r = await request(app).get('/api/inventory/items').set(as('nurse'));
    expect(r.body.some((i) => i.sku === 'MED-MORPH10')).toBe(false);
  });
});

describe('patient flow', () => {
  test('register, admit (auto bed) and discharge', async () => {
    const depts = (await request(app).get('/api/departments').set(as('reception'))).body;
    const p = await request(app).post('/api/patients').set(as('reception')).send({ fullName: 'Test Patient', age: 30, department: depts[0]._id, priority: 'urgent' });
    expect(p.status).toBe(201);
    const admitted = await request(app).patch(`/api/patients/${p.body._id}/status`).set(as('doctor')).send({ status: 'admitted' });
    expect(admitted.body.bed.label).toBeTruthy();
    const out = await request(app).patch(`/api/patients/${p.body._id}/status`).set(as('doctor')).send({ status: 'discharged' });
    expect(out.body.bed).toBeNull();
  });
  test('dashboard and forecasts return data', async () => {
    const d = await request(app).get('/api/dashboard').set(as('admin'));
    expect(d.body.departments).toHaveLength(6);
    const f = await request(app).get('/api/forecast/patients').set(as('admin'));
    expect(f.body.departments[0].forecast).toHaveLength(6);
  });
});

describe('inventory engine via API', () => {
  let item;
  test('register item, receive stock, issue it', async () => {
    const r = await request(app).post('/api/inventory/items').set(as('resources')).send({ sku: 'TEST-1', name: 'Test bandage', category: 'iv_fluids', unit: 'roll', reorderThreshold: 5, safetyStock: 2 });
    expect(r.status).toBe(201);
    item = r.body;
    expect((await request(app).post('/api/inventory/transactions').set(as('resources')).send({ item: item._id, type: 'receipt', quantity: 10, batchNo: 'B1', expiryDate: '2030-01-01' })).status).toBe(201);
    expect((await request(app).post('/api/inventory/transactions').set(as('nurse')).send({ item: item._id, type: 'issue', quantity: 4 })).status).toBe(201);
    const detail = await request(app).get(`/api/inventory/items/${item._id}`).set(as('nurse'));
    expect(detail.body.summary.available).toBe(6);
  });
  test('cannot issue more than available (no negative stock)', async () => {
    const r = await request(app).post('/api/inventory/transactions').set(as('nurse')).send({ item: item._id, type: 'issue', quantity: 7 });
    expect(r.status).toBe(400);
  });
  test('quarantined stock is excluded from available', async () => {
    const detail = await request(app).get(`/api/inventory/items/${item._id}`).set(as('resources'));
    await request(app).patch(`/api/inventory/batches/${detail.body.batches[0]._id}/status`).set(as('resources')).send({ status: 'quarantined', reason: 'Packaging damage' });
    const after = await request(app).get(`/api/inventory/items/${item._id}`).set(as('resources'));
    expect(after.body.summary.available).toBe(0);
    expect(after.body.summary.onHand).toBe(6);
  });
  test('nurses cannot record receipts', async () => {
    expect((await request(app).post('/api/inventory/transactions').set(as('nurse')).send({ item: item._id, type: 'receipt', quantity: 1, batchNo: 'X' })).status).toBe(403);
  });
  test('transaction history cannot be modified', async () => {
    await expect(InventoryTransaction.updateMany({}, { quantity: 0 })).rejects.toThrow(/append-only/);
    await expect(InventoryTransaction.deleteMany({})).rejects.toThrow(/append-only/);
  });
  test('low-stock, expiring, recommendations, reports', async () => {
    expect((await request(app).get('/api/inventory/low-stock').set(as('resources'))).body.length).toBeGreaterThan(0);
    const exp = (await request(app).get('/api/inventory/expiring?days=30').set(as('resources'))).body;
    expect(exp.some((b) => b.expired)).toBe(true);
    const rec = (await request(app).get('/api/procurement/recommendations').set(as('resources'))).body;
    expect(rec.every((r) => r.recommendedQuantity >= 0)).toBe(true);
    expect((await request(app).get('/api/resources/reports').set(as('resources'))).body.rows.length).toBeGreaterThan(0);
  });
});

describe('oxygen', () => {
  test('cylinder ids are unique and status changes are validated', async () => {
    const dup = await request(app).post('/api/oxygen/cylinders').set(as('resources')).send({ cylinderId: 'O2-001', capacityLiters: 340, location: 'ER' });
    expect(dup.status).toBe(409);
    const list = (await request(app).get('/api/oxygen/cylinders?status=empty').set(as('nurse'))).body;
    const bad = await request(app).patch(`/api/oxygen/cylinders/${list[0]._id}/status`).set(as('nurse')).send({ status: 'in_use' });
    expect(bad.status).toBe(400);
    const ok = await request(app).patch(`/api/oxygen/cylinders/${list[0]._id}/status`).set(as('nurse')).send({ status: 'refilling' });
    expect(ok.status).toBe(200);
  });
  test('summary ignores unvalidated readings', async () => {
    const s = (await request(app).get('/api/oxygen/summary').set(as('nurse'))).body;
    const er = s.supply.find((x) => x.sourceName === 'ER manifold');
    expect(er.litersRemaining).toBe(9000);
  });
});

describe('equipment', () => {
  test('unavailable equipment cannot be allocated', async () => {
    const list = (await request(app).get('/api/equipment?type=ventilator').set(as('doctor'))).body;
    const inMaint = list.find((e) => e.status === 'maintenance');
    expect((await request(app).post(`/api/equipment/${inMaint._id}/allocate`).set(as('doctor')).send({})).status).toBe(409);
    const free = list.find((e) => e.status === 'available');
    expect((await request(app).post(`/api/equipment/${free._id}/allocate`).set(as('doctor')).send({})).status).toBe(200);
  });
  test('completing maintenance returns equipment to service and keeps history', async () => {
    const list = (await request(app).get('/api/equipment?status=maintenance').set(as('resources'))).body;
    const r = await request(app).post(`/api/equipment/${list[0]._id}/maintenance`).set(as('resources')).send({ kind: 'repair', status: 'completed', notes: 'Sensor replaced' });
    expect(r.body.equipment.status).toBe('available');
    expect((await request(app).get(`/api/equipment/${list[0]._id}/maintenance`).set(as('resources'))).body.length).toBeGreaterThanOrEqual(2);
  });
});

describe('forecasts, alerts, overview, procurement', () => {
  test('generate forecasts with evaluation metrics', async () => {
    const r = await request(app).post('/api/resources/forecasts/generate').set(as('resources')).send({ horizonDays: 14 });
    expect(r.status).toBe(201);
    const withData = r.body.find((f) => !f.insufficientData);
    expect(withData.evaluation.mae).toBeGreaterThanOrEqual(0);
    expect(r.body.find((f) => f.resourceName === 'Test bandage').insufficientData).toBe(true);
    expect((await request(app).get('/api/resources/forecasts').set(as('resources'))).body.ventilators.total).toBe(5);
  });
  test('alerts distinguish confirmed and forecasted', async () => {
    const a = (await request(app).get('/api/resources/alerts').set(as('resources'))).body;
    expect(a.length).toBeGreaterThan(0);
    expect(a.filter((x) => x.kind === 'forecasted').every((x) => x.severity !== 'critical')).toBe(true);
  });
  test('overview cards come from the database', async () => {
    const o = (await request(app).get('/api/resources/overview').set(as('admin'))).body;
    expect(o.cards.trackedCategories).toBe(13);
    expect(o.cards.expiredOrQuarantinedBatches).toBeGreaterThan(0);
  });
  test('purchase order received books a receipt', async () => {
    const items = (await request(app).get('/api/inventory/items').set(as('resources'))).body;
    const target = items.find((i) => i.sku === 'LAB-GLU');
    const before = target.summary.available;
    const po = (await request(app).post('/api/procurement/purchase-orders').set(as('resources')).send({ item: target._id, quantity: 10 })).body;
    for (const status of ['approved', 'ordered']) await request(app).patch(`/api/procurement/purchase-orders/${po._id}/status`).set(as('resources')).send({ status });
    const recv = await request(app).patch(`/api/procurement/purchase-orders/${po._id}/status`).set(as('resources')).send({ status: 'received', batchNo: 'GLU-NEW', expiryDate: '2030-01-01' });
    expect(recv.status).toBe(200);
    const after = (await request(app).get(`/api/inventory/items/${target._id}`).set(as('resources'))).body;
    expect(after.summary.available).toBe(before + 10);
  });
  test('audit log is admin-only', async () => {
    expect((await request(app).get('/api/audit-logs').set(as('resources'))).status).toBe(403);
    expect((await request(app).get('/api/audit-logs').set(as('admin'))).body.length).toBeGreaterThan(0);
  });
});
