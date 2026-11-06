angular.module('flowcare')

  .controller('UsersCtrl', ['Api', 'Auth', 'ROLE_LABELS', function (Api, Auth, ROLE_LABELS) {
    const vm = this;
    vm.roles = Object.keys(ROLE_LABELS);
    vm.labels = ROLE_LABELS;
    vm.me = Auth.user();
    vm.form = { role: 'nurse' };
    vm.load = () => Api.get('/users').then((u) => { vm.users = u; });
    vm.update = (u, patch) => Api.patch('/users/' + u._id, patch).then(vm.load);
    vm.add = () => Api.post('/users', vm.form).then(() => { vm.form = { role: 'nurse' }; vm.showForm = false; vm.load(); });
    vm.load();
  }])

  .controller('AuditCtrl', ['Api', function (Api) {
    const vm = this;
    Api.get('/audit-logs').then((l) => { vm.logs = l; });
  }]);
