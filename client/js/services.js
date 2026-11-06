angular.module('flowcare')

  .factory('Auth', ['$window', 'PERMISSIONS', function ($window, PERMISSIONS) {
    const KEY = 'flowcare.session';
    let session = null;
    try { session = JSON.parse($window.localStorage.getItem(KEY)); } catch (e) { session = null; }
    // Drop expired tokens
    if (session && session.token) {
      try {
        const payload = JSON.parse(atob(session.token.split('.')[1]));
        if (payload.exp * 1000 < Date.now()) session = null;
      } catch (e) { session = null; }
    }
    return {
      user: () => session && session.user,
      token: () => session && session.token,
      setSession: (s) => { session = s; $window.localStorage.setItem(KEY, JSON.stringify(s)); },
      logout: () => { session = null; $window.localStorage.removeItem(KEY); },
      can: (perm) => !!session && (session.user.role === 'admin' || (PERMISSIONS[perm] || []).includes(session.user.role)),
      is: (role) => !!session && session.user.role === role,
    };
  }])

  .factory('authInterceptor', ['$q', '$injector', '$rootScope', function ($q, $injector, $rootScope) {
    return {
      request: function (config) {
        const Auth = $injector.get('Auth');
        if (config.url.indexOf('/api/') === 0 && Auth.token()) config.headers.Authorization = 'Bearer ' + Auth.token();
        return config;
      },
      responseError: function (res) {
        if (res.status === 401 && res.config.url !== '/api/auth/login') {
          $injector.get('Auth').logout();
          $injector.get('$location').path('/login');
        } else if (res.config && res.config.url && res.config.url.indexOf('/api/') === 0) {
          const d = res.data || {};
          $rootScope.$broadcast('api:error', (d.error || 'Request failed') + (d.details && d.details.join ? ': ' + d.details.join('; ') : ''));
        }
        return $q.reject(res);
      },
    };
  }])

  /** Thin REST wrapper: Api.get('/patients') → Promise of data */
  .factory('Api', ['$http', function ($http) {
    const unwrap = (r) => r.data;
    return {
      get: (url, params) => $http.get('/api' + url, { params: params }).then(unwrap),
      post: (url, body) => $http.post('/api' + url, body || {}).then(unwrap),
      patch: (url, body) => $http.patch('/api' + url, body || {}).then(unwrap),
    };
  }])

  /** <canvas fc-chart="config"></canvas> — renders a Chart.js chart from a config object. */
  .directive('fcChart', function () {
    return {
      restrict: 'A',
      scope: { fcChart: '<' },
      link: function (scope, el) {
        let chart;
        scope.$watch('fcChart', function (cfg) {
          if (chart) chart.destroy();
          if (cfg) chart = new Chart(el[0].getContext('2d'), angular.merge({ options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12 } } } } }, cfg));
        });
        scope.$on('$destroy', () => chart && chart.destroy());
      },
    };
  })

  .directive('fcPill', function () {
    return { restrict: 'E', scope: { value: '@', label: '@' }, template: '<span class="pill pill-{{value}}">{{label || (value | humanize)}}</span>' };
  })

  .filter('humanize', () => (s) => (s ? String(s).replace(/_/g, ' ') : ''))
  .filter('minutesAgo', () => (d) => Math.round((Date.now() - new Date(d).getTime()) / 60000) + 'm')

  .constant('CHART_COLORS', ['#0f6f73', '#e0734f', '#2f9466', '#e5a823', '#47607a', '#3aa6a3', '#c9453a', '#8a6fb0']);
