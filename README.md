# FlowCare — AI-Based Hospital Resource Allocation and Patient Flow Optimization

Starter project built on the required stack:

| Layer | Technology |
|---|---|
| Front end | HTML5, CSS3, Bootstrap 5, AngularJS 1.8.3 (ngRoute), Chart.js 4 |
| Back end | Node.js, Express.js, REST APIs |
| Database | MongoDB (Mongoose) |
| Auth | JWT + role-based access control |
| AI | JavaScript statistical forecasting and rule-based recommendations (no external AI service) |

It covers the original PRD (patient flow, beds, staff, demand forecasting, recommendations) and the
**Resource Inventory extension**, priorities 1–6: the shared inventory engine, oxygen management, medicines and
consumables, ventilators and equipment, resource forecasting, and alerts, plus procurement.

---

## 1. Prerequisites

- **Node.js 18 or newer** — https://nodejs.org (check with `node -v`)
- **MongoDB 6 or newer**, either:
  - installed locally (MongoDB Community Server — https://www.mongodb.com/try/download/community), or
  - a free MongoDB Atlas cluster (https://www.mongodb.com/atlas) — copy its connection string.
- An internet connection in the browser (Bootstrap, AngularJS and Chart.js load from public CDNs).

## 2. Setup

```bash
cd server
npm install
cp .env.example .env        # on Windows: copy .env.example .env
```

Edit `server/.env`:

```
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/flowcare     # or your Atlas connection string
JWT_SECRET=<any long random text>
JWT_EXPIRES_IN=8h
```

## 3. Load the demo data

```bash
npm run seed
```

> ⚠️ This **erases** the database in `MONGODB_URI` and loads fresh demo data. All names and numbers are fictional.

## 4. Run

```bash
npm start            # or: npm run dev   (auto-restart while editing)
```

Open **http://localhost:3000**. Express serves both the API (`/api/...`) and the AngularJS app (`/client`).

### Demo accounts — password `Password123!`

| Email | Role | Can do |
|---|---|---|
| admin@demo.local | Administrator | Everything, including users and audit logs |
| resources@demo.local | Resource manager | Inventory, receipts, oxygen, equipment, staff, purchase orders |
| doctor@demo.local | Doctor | Patients, beds, issue stock, allocate equipment, see restricted medicines |
| nurse@demo.local | Nurse | Patients, beds, issue stock, oxygen readings, allocate equipment |
| reception@demo.local | Receptionist | Register patients, dashboards (no inventory) |

The login screen has buttons to fill these in.

## 5. Tests

```bash
cd server
npm test
```

31 tests (Jest + Supertest) run against a throw-away in-memory MongoDB that downloads automatically the
first time, so no database setup is needed. They cover the inventory formulas, permissions, negative-stock
prevention, quarantined/expired stock exclusion, append-only history, cylinder status rules, equipment
allocation, forecasts with back-test metrics, alert severity rules, purchase orders and the audit log.

## 6. CI/CD demo (GitHub Actions)

The workflow in `.github/workflows/ci-cd.yml` runs automatically for pushes and pull requests targeting
`main`. It installs the backend from the committed lockfile and runs the backend test suite. After a push to
`main` passes, it packages the client and server source and publishes a downloadable `flowcare-build-*`
artifact for 14 days.

To demo it, push this repository to GitHub with a `main` branch, then open the **Actions** tab and select
**FlowCare CI/CD**. Push a commit to `main` to show a complete run; open that run and download the build
artifact from **Artifacts**. Pull requests and manual runs also demonstrate the test stage.

---

## 7. Project structure

```
server/
  src/
    app.js                  Express app, routes, static client
    server.js               Connects to MongoDB and starts the server
    config.js               Reads .env
    middleware/auth.js      JWT, roles, PERMISSIONS map
    middleware/error.js     Validation helper and error handler
    models/ops.js           users, departments, beds, staff, patients, arrival history
    models/resources.js     resourceCategories, inventoryItems, inventoryBatches, inventoryTransactions,
                            oxygenCylinders, oxygenMeasurements, medicalEquipment, equipmentMaintenance,
                            purchaseOrders, resourceAlerts, resourceForecasts, auditLogs
    services/
      inventoryEngine.js    Shared inventory engine (one engine for all quantity-tracked supplies)
      patientForecast.js    Patient arrival forecasting + staff/bed recommendations
      resourceForecast.js   Supply forecasting, oxygen coverage, ventilator capacity
      alerts.js             Alert engine
      audit.js              Audit log helper
    routes/                 One file per API area
    seed/seed.js            Demo data
  tests/                    engine.test.js (formulas), api.test.js (endpoints)
client/
  index.html                Shell and sidebar
  js/app.js                 Module, routes, permission-aware navigation
  js/services.js            Auth, HTTP interceptor (JWT), Api wrapper, Chart.js directive
  js/controllers/           ops.js, resources.js, admin.js
  views/                    One HTML template per page
  css/app.css               Theme
```

## 8. Key rules and formulas

**Inventory engine** (`services/inventoryEngine.js`)
- *Usable* stock = batches with status `usable` that have not passed their expiry date. Quarantined, damaged and expired stock is never usable.
- *Available* = usable − reserved.
- *Days of coverage* = available ÷ average daily use, shown **only** with at least 14 days of history.
- *Reorder quantity* = demand during lead time + safety stock − available − incoming orders. Never negative.
- *Stock status*: `out` (0), `critical` (≤ safety stock), `low` (≤ reorder threshold), otherwise `ok`.
- Quantities change **only** through transactions (receipt, issue, transfer, adjustment, status change).
  Issues use first-expiry-first-out and atomic guarded updates, so stock can never go negative.
- The transaction history is append-only: the model blocks every update and delete.

**Oxygen** — cylinder IDs are unique; status changes follow an allowed-transition map (e.g. an empty cylinder
must be refilled before it can be used). Only `full` and `in_use` cylinders count as usable. Supply coverage
(hours = litres ÷ (L/min × 60)) uses **validated** readings only.

**Equipment** — only `available` units can be allocated (atomic check). Opening maintenance takes a unit out of
service; completing it returns it. All maintenance records are kept.

**Patient forecasting** — hour-of-day average of 14 days of arrivals (same weekday weighted ×2) × recent trend
(last 3 hours actual ÷ expected, limited to 0.5–2). Capacity = (60 ÷ service minutes) × doctors on duty × hours.
Estimated wait = waiting × service minutes ÷ doctors. Beds alert at 85% occupancy.

**Supply forecasting** — 0.6 × average of last 7 days + 0.4 × average of last 28 days, with day-of-week factors.
95% range = ±1.96 × daily standard deviation × √horizon. Back-test: the last 7 days are predicted from earlier
data and MAE / MAPE are calculated from the real results. Items with under 14 days of history show
"insufficient data" instead of a number.

**Alerts** — "confirmed" alerts come from actual records; "forecasted" alerts come from predictions and are
capped at HIGH, so an uncertain prediction alone never creates a CRITICAL alert. Severity also depends on the
item's criticality (essential / important / routine). Alerts resolve automatically when their condition clears.

## 9. Limitations

- Forecasts are statistical estimates, not clinical advice. Clinical compatibility and prescribing decisions are outside this system.
- The demo consumption history is synthetic, so batch balances are set directly by the seed script rather than built up from that history. Everything recorded after seeding goes through the engine.
- MongoDB multi-document transactions are not used (they need a replica set). Each stock change is an atomic, guarded single-document update. A failed multi-batch issue records the part that succeeded and reports the shortfall.
- Not built yet (left out of the sidebar so there are no dead links): blood-bank traceability workflows, operating rooms, ambulances, laboratory equipment and infrastructure screens (PRD priorities 7–10). Their categories exist, and quantity items such as blood units and lab reagents already work through the shared inventory engine.

## 10. API reference

All endpoints except `/api/auth/*` need `Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/login | Sign in → `{ token, user }` |
| POST | /api/auth/register | Self sign-up (receptionist) |
| GET | /api/auth/me | Current user |
| GET | /api/dashboard | Live operations summary + recommendations |
| GET | /api/departments | Departments |
| GET / POST / PATCH | /api/patients, /api/patients/:id/status | Queue, registration, consult / admit (auto bed) / discharge |
| GET / PATCH | /api/beds, /api/beds/:id/status | Bed board |
| GET / POST / PATCH | /api/staff, /api/staff/:id | Staff |
| GET | /api/forecast/patients, /api/forecast/recommendations | Patient demand forecast, bottlenecks |
| GET | /api/resources/overview | Resource dashboard cards and charts |
| GET / POST | /api/resources/categories | Resource categories |
| GET / POST | /api/inventory/items | List / register items (filters: category, department, status) |
| GET / PATCH | /api/inventory/items/:id | Item detail with batches and history / thresholds |
| GET | /api/inventory/low-stock | Low-stock items |
| GET | /api/inventory/expiring?days=30 | Expiring and expired batches |
| POST / GET | /api/inventory/transactions | Record / list stock movements |
| PATCH | /api/inventory/batches/:id/status | Quarantine, damaged, expired, release |
| GET / POST | /api/oxygen/cylinders | Cylinders |
| PATCH | /api/oxygen/cylinders/:id/status | Validated status change |
| GET | /api/oxygen/summary | Cylinder counts and supply coverage |
| POST / GET | /api/oxygen/measurements | Oxygen readings |
| GET / POST | /api/equipment | Equipment |
| POST / GET | /api/equipment/:id/maintenance | Maintenance and inspection records |
| POST | /api/equipment/:id/allocate, /api/equipment/:id/release | Allocation |
| POST | /api/resources/forecasts/generate | Generate supply forecasts |
| GET | /api/resources/forecasts | Latest forecasts + ventilator capacity |
| GET / PATCH | /api/resources/alerts, /api/resources/alerts/:id | Alerts, acknowledge |
| GET | /api/procurement/recommendations | Replenishment suggestions with explanation |
| GET / POST | /api/procurement/purchase-orders | Purchase orders |
| PATCH | /api/procurement/purchase-orders/:id/status | draft → approved → ordered → received (books stock) |
| GET | /api/resources/reports | Stock report (CSV download in the app) |
| GET / POST / PATCH | /api/users | User management (admin) |
| GET | /api/audit-logs | Audit log (admin) |

You can try any endpoint in Postman: call `POST /api/auth/login`, copy the `token`, and add it as a Bearer token.
