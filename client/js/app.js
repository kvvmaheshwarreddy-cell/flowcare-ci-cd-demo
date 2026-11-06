/* FlowCare — AngularJS 1.8 application module, routes and shell. */
angular.module('flowcare', ['ngRoute'])

  .constant('ROLE_LABELS', {
    admin: 'Administrator', doctor: 'Doctor', nurse: 'Nurse', receptionist: 'Receptionist', resource_manager: 'Resource manager',
  })

  // Mirrors server/src/middleware/auth.js PERMISSIONS (the server is the real gatekeeper).
  .constant('PERMISSIONS', {
    'patients:write': ['doctor', 'nurse', 'receptionist'],
    'beds:write': ['doctor', 'nurse', 'resource_manager'],
    'staff:write': ['resource_manager'],
    'inventory:read': ['doctor', 'nurse', 'resource_manager'],
    'inventory:manage': ['resource_manager'],
    'inventory:issue': ['doctor', 'nurse', 'resource_manager'],
    'oxygen:write': ['nurse', 'resource_manager'],
    'equipment:write': ['resource_manager'],
    'equipment:allocate': ['doctor', 'nurse', 'resource_manager'],
    'procurement:manage': ['resource_manager'],
    'users:manage': [],
    'audit:read': [],
  })

  .config(['$routeProvider', '$locationProvider', '$httpProvider', function ($routeProvider, $locationProvider, $httpProvider) {
    $locationProvider.html5Mode(true);
    $httpProvider.interceptors.push('authInterceptor');

    function route(path, view, ctrl, permission) {
      $routeProvider.when(path, { templateUrl: 'views/' + view + '.html', controller: ctrl, controllerAs: 'vm', permission: permission });
    }
    route('/login', 'login', 'LoginCtrl');
    route('/dashboard', 'dashboard', 'DashboardCtrl');
    route('/patients', 'patients', 'PatientsCtrl');
    route('/beds', 'beds', 'BedsCtrl');
    route('/staff', 'staff', 'StaffCtrl');
    route('/forecast', 'forecast', 'ForecastCtrl');
    route('/resources', 'resources', 'ResourcesCtrl', 'inventory:read');
    route('/inventory', 'inventory', 'InventoryCtrl', 'inventory:read');
    route('/inventory/items/:id', 'item', 'ItemCtrl', 'inventory:read');
    route('/inventory/low-stock', 'low-stock', 'LowStockCtrl', 'inventory:read');
    route('/inventory/expiring', 'expiring', 'ExpiringCtrl', 'inventory:read');
    route('/inventory/transactions', 'transactions', 'TransactionsCtrl', 'inventory:read');
    route('/oxygen', 'oxygen', 'OxygenCtrl', 'inventory:read');
    route('/equipment', 'equipment', 'EquipmentCtrl', 'inventory:read');
    route('/resource-forecasts', 'resource-forecasts', 'ResourceForecastCtrl', 'inventory:read');
    route('/alerts', 'alerts', 'AlertsCtrl', 'inventory:read');
    route('/procurement', 'procurement', 'ProcurementCtrl', 'inventory:read');
    route('/reports', 'reports', 'ReportsCtrl', 'inventory:read');
    route('/users', 'users', 'UsersCtrl', 'users:manage');
    route('/audit', 'audit', 'AuditCtrl', 'audit:read');
    $routeProvider.otherwise('/dashboard');
  }])

  .run(['$rootScope', '$location', 'Auth', function ($rootScope, $location, Auth) {
    $rootScope.$on('$routeChangeStart', function (e, next) {
      if (!next.$$route) return;
      const path = next.$$route.originalPath;
      if (path !== '/login' && !Auth.user()) return $location.path('/login');
      if (path === '/login' && Auth.user()) return $location.path('/dashboard');
      if (next.$$route.permission && !Auth.can(next.$$route.permission)) $location.path('/dashboard');
    });
  }])

  .controller('ShellCtrl', ['Auth', 'ROLE_LABELS', '$location', '$rootScope', function (Auth, ROLE_LABELS, $location, $rootScope) {
    const vm = this;
    vm.auth = Auth;
    vm.roleLabel = (r) => ROLE_LABELS[r];
    vm.isActive = (p) => $location.path() === p;
    vm.logout = function () { Auth.logout(); $location.path('/login'); };
    $rootScope.$on('api:error', (e, msg) => { vm.error = msg; });
    $rootScope.$on('$routeChangeSuccess', () => { vm.error = null; });
  }]);
