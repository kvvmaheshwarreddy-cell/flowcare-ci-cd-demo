angular.module('flowcare')

  .controller('ResourcesCtrl', ['Api', '$location', 'CHART_COLORS', function (Api, $location, C) {
    const vm = this;
    const routes = { beds: '/beds', staff: '/staff', oxygen: '/oxygen', ventilators: '/equipment', emergency_equipment: '/equipment' };
    vm.open = (c) => $location.path(routes[c.code] || '/inventory').search(routes[c.code] ? {} : { category: c.code });
    Api.get('/resources/overview').then((o) => {
      vm.o = o;
      const ch = o.charts;
      const months = [...new Set(ch.monthlyConsumption.map((m) => m.month))];
      const cats = [...new Set(ch.monthlyConsumption.map((m) => m.category))];
      vm.charts = {
        qty: { type: 'bar', data: { labels: ch.quantityByCategory.map((x) => x.category), datasets: [{ label: 'Available units', data: ch.quantityByCategory.map((x) => x.available), backgroundColor: C[0] }] } },
        lowDept: { type: 'bar', data: { labels: ch.lowStockByDepartment.map((x) => x.department), datasets: [{ label: 'Low-stock items', data: ch.lowStockByDepartment.map((x) => x.count), backgroundColor: C[1] }] } },
        equip: { type: 'doughnut', data: { labels: ch.equipmentStatus.map((x) => x.status), datasets: [{ data: ch.equipmentStatus.map((x) => x.count), backgroundColor: [C[2], C[0], C[3], C[6]] }] } },
        monthly: { type: 'line', data: { labels: months, datasets: cats.map((c, i) => ({ label: c, data: months.map((m) => (ch.monthlyConsumption.find((x) => x.month === m && x.category === c) || {}).quantity || 0), borderColor: C[i % C.length], tension: 0.3 })) } },
        severity: { type: 'bar', data: { labels: ch.shortagesBySeverity.map((x) => x.severity), datasets: [{ label: 'Open alerts', data: ch.shortagesBySeverity.map((x) => x.count), backgroundColor: [C[6], C[1], C[3], C[4]] }] } },
        coverage: { type: 'bar', data: { labels: ch.stockCoverage.map((x) => x.item), datasets: [{ label: 'Days of coverage', data: ch.stockCoverage.map((x) => x.coverageDays), backgroundColor: C[5] }, { label: 'Lead time (days)', data: ch.stockCoverage.map((x) => x.leadTimeDays), backgroundColor: C[1] }] }, options: { indexAxis: 'y' } },
        expiry: { type: 'bar', data: { labels: ch.expiringByRange.map((x) => x.range), datasets: [{ label: 'Batches', data: ch.expiringByRange.map((x) => x.count), backgroundColor: [C[6], C[1], C[3]] }] } },
      };
    });
  }])

  .controller('InventoryCtrl', ['Api', 'Auth', '$routeParams', function (Api, Auth, $routeParams) {
    const vm = this;
    vm.canManage = Auth.can('inventory:manage');
    vm.filter = { category: $routeParams.category || '', department: '', status: '' };
    vm.form = { criticality: 'important', reorderThreshold: 0, safetyStock: 0, leadTimeDays: 7 };
    Api.get('/resources/categories').then((c) => { vm.categories = c; });
    Api.get('/departments').then((d) => { vm.departments = d; });
    vm.load = () => Api.get('/inventory/items', { category: vm.filter.category || undefined, department: vm.filter.department || undefined, status: vm.filter.status || undefined }).then((i) => { vm.items = i; });
    vm.add = () => Api.post('/inventory/items', vm.form).then(() => { vm.showForm = false; vm.load(); });
    vm.load();
  }])

  .controller('ItemCtrl', ['Api', 'Auth', '$routeParams', function (Api, Auth, $routeParams) {
    const vm = this;
    vm.canManage = Auth.can('inventory:manage');
    vm.canIssue = Auth.can('inventory:issue');
    vm.txn = { type: vm.canManage ? 'receipt' : 'issue' };
    vm.load = () => Api.get('/inventory/items/' + $routeParams.id).then((i) => { vm.item = i; });
    vm.submit = function () {
      vm.ok = null;
      const body = angular.extend({ item: vm.item._id }, vm.txn);
      Api.post('/inventory/transactions', body).then(() => { vm.ok = 'Transaction recorded.'; vm.txn = { type: vm.txn.type }; vm.load(); });
    };
    vm.setStatus = function (b, status) {
      const reason = prompt('Reason for marking batch ' + b.batchNo + ' as ' + status + ':');
      if (reason) Api.patch('/inventory/batches/' + b._id + '/status', { status, reason }).then(vm.load);
    };
    vm.saveSettings = () => Api.patch('/inventory/items/' + vm.item._id, { reorderThreshold: vm.item.reorderThreshold, safetyStock: vm.item.safetyStock, leadTimeDays: vm.item.leadTimeDays, reservedQuantity: vm.item.reservedQuantity }).then(vm.load);
    vm.load();
  }])

  .controller('LowStockCtrl', ['Api', function (Api) {
    const vm = this;
    Api.get('/inventory/low-stock').then((i) => { vm.items = i; });
  }])

  .controller('ExpiringCtrl', ['Api', function (Api) {
    const vm = this;
    vm.days = 30;
    vm.load = () => Api.get('/inventory/expiring', { days: vm.days }).then((b) => { vm.batches = b; });
    vm.load();
  }])

  .controller('TransactionsCtrl', ['Api', function (Api) {
    const vm = this;
    vm.filter = { type: '' };
    vm.load = () => Api.get('/inventory/transactions', { type: vm.filter.type || undefined, from: vm.filter.from || undefined, to: vm.filter.to || undefined }).then((t) => { vm.txns = t; });
    vm.load();
  }])

  .controller('OxygenCtrl', ['Api', 'Auth', function (Api, Auth) {
    const vm = this;
    vm.can = Auth.can('oxygen:write');
    vm.transitions = {
      full: ['in_use', 'maintenance', 'quarantined'], in_use: ['empty', 'full', 'quarantined'], empty: ['refilling', 'maintenance', 'quarantined'],
      refilling: ['full', 'quarantined'], maintenance: ['empty', 'full', 'quarantined'], quarantined: ['maintenance', 'empty'],
    };
    vm.m = { source: 'manifold', validated: true };
    vm.cyl = { size: 'D', capacityLiters: 340, status: 'full' };
    vm.load = function () {
      Api.get('/oxygen/summary').then((s) => { vm.s = s; });
      Api.get('/oxygen/cylinders').then((c) => { vm.cylinders = c; });
      Api.get('/oxygen/measurements').then((m) => { vm.measurements = m; });
    };
    vm.setStatus = (c, status, inspected) => Api.patch('/oxygen/cylinders/' + c._id + '/status', { status, inspected }).then(vm.load);
    vm.addMeasurement = () => Api.post('/oxygen/measurements', vm.m).then(() => { vm.m = { source: 'manifold', validated: true }; vm.load(); });
    vm.addCylinder = () => Api.post('/oxygen/cylinders', vm.cyl).then(() => { vm.cyl = { size: 'D', capacityLiters: 340, status: 'full' }; vm.showCyl = false; vm.load(); });
    vm.load();
  }])

  .controller('EquipmentCtrl', ['Api', 'Auth', function (Api, Auth) {
    const vm = this;
    vm.canWrite = Auth.can('equipment:write');
    vm.canAllocate = Auth.can('equipment:allocate');
    vm.filter = { type: '', status: '' };
    vm.form = { type: 'ventilator' };
    vm.types = ['ventilator', 'bipap', 'monitor', 'defibrillator', 'infusion_pump', 'oxygen_concentrator', 'other'];
    Api.get('/departments').then((d) => { vm.departments = d; });
    vm.load = () => Api.get('/equipment', { type: vm.filter.type || undefined, status: vm.filter.status || undefined }).then((e) => { vm.list = e; });
    vm.allocate = (e) => Api.post('/equipment/' + e._id + '/allocate').then(vm.load);
    vm.release = (e) => Api.post('/equipment/' + e._id + '/release').then(vm.load);
    vm.maint = (e, kind, status) => {
      const notes = prompt(kind + ' notes for ' + e.assetTag + ':', '');
      if (notes !== null) Api.post('/equipment/' + e._id + '/maintenance', { kind, status, notes }).then(vm.load);
    };
    vm.history = (e) => Api.get('/equipment/' + e._id + '/maintenance').then((h) => { vm.selected = e; vm.records = h; });
    vm.add = () => Api.post('/equipment', vm.form).then(() => { vm.form = { type: 'ventilator' }; vm.showForm = false; vm.load(); });
    vm.load();
  }])

  .controller('ResourceForecastCtrl', ['Api', function (Api) {
    const vm = this;
    vm.horizon = 14;
    vm.load = () => Api.get('/resources/forecasts').then((f) => { vm.f = f; });
    vm.generate = () => { vm.busy = true; Api.post('/resources/forecasts/generate', { horizonDays: vm.horizon }).then(vm.load).finally(() => { vm.busy = false; }); };
    vm.load();
  }])

  .controller('AlertsCtrl', ['Api', function (Api) {
    const vm = this;
    vm.filter = { severity: '' };
    vm.load = () => Api.get('/resources/alerts', { severity: vm.filter.severity || undefined }).then((a) => { vm.alerts = a; });
    vm.ack = (a) => Api.patch('/resources/alerts/' + a._id, { status: 'acknowledged' }).then(vm.load);
    vm.load();
  }])

  .controller('ProcurementCtrl', ['Api', 'Auth', function (Api, Auth) {
    const vm = this;
    vm.can = Auth.can('procurement:manage');
    vm.next = { draft: ['approved', 'cancelled'], approved: ['ordered', 'cancelled'], ordered: ['received', 'cancelled'], received: [], cancelled: [] };
    vm.load = function () {
      Api.get('/procurement/recommendations').then((r) => { vm.recs = r; });
      Api.get('/procurement/purchase-orders').then((p) => { vm.pos = p; });
    };
    vm.order = (r) => Api.post('/procurement/purchase-orders', { item: r.item._id, quantity: r.recommendedQuantity || 1 }).then(vm.load);
    vm.move = function (po, status) {
      const body = { status };
      if (status === 'received') {
        body.batchNo = prompt('Batch number of the delivery:');
        if (!body.batchNo) return;
        body.expiryDate = prompt('Expiry date (YYYY-MM-DD), leave blank if none:') || undefined;
      }
      Api.patch('/procurement/purchase-orders/' + po._id + '/status', body).then(vm.load);
    };
    vm.load();
  }])

  .controller('ReportsCtrl', ['Api', function (Api) {
    const vm = this;
    Api.get('/resources/reports').then((r) => { vm.r = r; });
    vm.csv = function () {
      const cols = Object.keys(vm.r.rows[0]);
      const lines = [cols.join(',')].concat(vm.r.rows.map((row) => cols.map((c) => JSON.stringify(row[c] === null ? '' : row[c])).join(',')));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
      a.download = 'stock-report.csv';
      a.click();
    };
  }]);
