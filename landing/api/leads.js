// Точка входа для Vercel. Путь задаётся явно, чтобы не зависеть от того,
// как хостинг перепишет URL при маршрутизации.
const server = require('../server');

module.exports = function (req, res) {
  const query = req.url.indexOf('?') === -1 ? '' : req.url.slice(req.url.indexOf('?'));
  req.url = '/api/leads' + query;
  server.emit('request', req, res);
};
