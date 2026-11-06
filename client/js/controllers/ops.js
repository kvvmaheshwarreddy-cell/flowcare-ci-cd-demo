angular.module('flowcare')

  .controller('LoginCtrl', ['Api', 'Auth', '$location', function (Api, Auth, $location) {
    const vm = this;
    vm.form = { email: 'admin@demo.local', password: 'Password123!' };
    vm.demo = ['admin', 'doctor', 'nurse', 'reception', 'resources'];
    vm.pick = (u) => { vm.form.email = u + '@demo.local'; vm.form.password = 'Password123!'; };
    vm.submit = function () {
      vm.error = null;
      Api.post('/auth/login', vm.form).then((r) => { Auth.setSession(r); $location.path('/dashboard'); })
        .catch((e) => { vm.error = (e.data && e.data.error) || 'Sign-in failed'; });
    };
  }])

  .controller('DashboardCtrl', ['Api', 'CHART_COLORS', function (Api, C) {
    const vm = this;
    Api.get('/dashboard').then((d) => {
      vm.d = d;
      vm.chart = {
        type: 'bar',
        data: {
          labels: d.departments.map((s) => s.department.code),
          datasets: [
            { label: 'Waiting', data: d.departments.map((s) => s.waiting), backgroundColor: C[1], stack: 'demand' },
            { label: 'Expected 3h', data: d.departments.map((s) => s.predicted3h), backgroundColor: C[0], stack: 'demand' },
            { label: 'Capacity 3h', data: d.departments.map((s) => s.capacity3h), backgroundColor: C[2], stack: 'cap' },
          ],
        },
      };
    });
    vm.loadTone = (l) => (l > 1.5 ? 'critical' : l > 1 ? 'warning' : 'ok');
  }])

  .controller('PatientsCtrl', ['Api', 'Auth', function (Api, Auth) {
    const vm = this;
    vm.can = Auth.can('patients:write');
    vm.filter = { department: '', status: '' };
    vm.form = { priority: 'normal' };
    Api.get('/departments').then((d) => { vm.departments = d; });
    vm.load = () => Api.get('/patients', { department: vm.filter.department || undefined, status: vm.filter.status || undefined }).then((p) => { vm.patients = p; });
    vm.register = function () {
      Api.post('/patients', vm.form).then(() => { vm.form = { priority: 'normal' }; vm.showForm = false; vm.load(); });
    };
    vm.setStatus = (p, status) => Api.patch('/patients/' + p._id + '/status', { status }).then(vm.load);
    vm.load();
  }])

  .controller('BedsCtrl', ['Api', 'Auth', function (Api, Auth) {
    const vm = this;
    vm.can = Auth.can('beds:write');
    vm.statuses = ['available', 'occupied', 'cleaning', 'maintenance'];
    vm.inDept = (d) => (vm.beds || []).filter((b) => b.department._id === d._id);
    vm.set = (b, s) => Api.patch('/beds/' + b._id + '/status', { status: s }).then(() => { b.status = s; });
    Api.get('/departments').then((d) => { vm.departments = d; });
    Api.get('/beds').then((b) => { vm.beds = b; });
    vm.count = (s) => (vm.beds || []).filter((x) => x.status === s).length;
  }])

  .controller('StaffCtrl', ['Api', 'Auth', function (Api, Auth) {
    const vm = this;
    vm.can = Auth.can('staff:write');
    vm.form = { role: 'nurse', shift: 'day' };
    Api.get('/departments').then((d) => { vm.departments = d; });
    vm.load = () => Api.get('/staff').then((s) => { vm.staff = s.map((x) => ({ ...x, deptId: x.department && x.department._id })); });
    vm.update = (s, patch) => Api.patch('/staff/' + s._id, patch);
    vm.add = () => Api.post('/staff', vm.form).then(() => { vm.form = { role: 'nurse', shift: 'day' }; vm.showForm = false; vm.load(); });
    vm.load();
  }])

  .controller('ForecastCtrl', ['Api', 'CHART_COLORS', function (Api, C) {
    const vm = this;
    const hr = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit' });
    Api.get('/forecast/patients').then((f) => { vm.f = f; vm.dept = f.departments[0]; vm.draw(); });
    Api.get('/forecast/recommendations').then((r) => { vm.r = r; });
    vm.draw = function () {
      const d = vm.dept;
      vm.histChart = { type: 'line', data: { labels: d.history.map((h) => hr(h.hour)), datasets: [{ label: 'Actual arrivals', data: d.history.map((h) => h.arrivals), borderColor: C[0], backgroundColor: 'rgba(15,111,115,.12)', fill: true, tension: 0.3, pointRadius: 0 }] } };
      vm.fcChart = { type: 'line', data: { labels: d.forecast.map((h) => hr(h.hour)), datasets: [{ label: 'Forecast', data: d.forecast.map((h) => h.predicted), borderColor: C[1], borderDash: [6, 4], tension: 0.3 }] } };
    };
  }]);
