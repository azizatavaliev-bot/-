// HTTP-сервер лендинга. Без внешних зависимостей.
//
// Механика таймера:
//   1. Первый заход  -> сервер выдаёт cookie `sid` и записывает deadline = now + windowHours.
//   2. Любой следующий заход с тем же cookie -> возвращается ТОТ ЖЕ deadline.
//      Время не перезапускается и продолжает идти, пока сайт закрыт.
//   3. Приём анкеты проверяется на сервере: после deadline POST /api/submit отклоняется,
//      даже если клиент подменил таймер в браузере.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const store = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_NAME = 'sid';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      if (index === -1) return [part.trim(), ''];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    })
  );
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Возвращает существующую сессию по cookie либо создаёт новую.
function resolveSession(req, res) {
  const cookies = parseCookies(req);
  const existing = store.getSession(cookies[COOKIE_NAME]);
  if (existing) return { session: existing, isNew: false };

  const id = crypto.randomUUID();
  const session = store.createSession({
    id,
    deadline: Date.now() + config.windowHours * 3600 * 1000,
    meta: { ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 300) },
  });

  const parts = [
    `${COOKIE_NAME}=${id}`,
    'Path=/',
    `Max-Age=${config.cookieDays * 24 * 3600}`,
    'SameSite=Lax',
    'HttpOnly',
  ];
  // Secure ставим только если сайт реально открыт по https, иначе cookie не сохранится локально.
  if (req.headers['x-forwarded-proto'] === 'https') parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));

  return { session, isNew: true };
}

function sessionState(session) {
  const now = Date.now();
  return {
    now,
    deadline: session.deadline,
    msLeft: Math.max(0, session.deadline - now),
    expired: now >= session.deadline,
    submitted: Boolean(session.submittedAt),
  };
}

// Проверка анкеты по описанию полей из config.fields.
function validate(payload) {
  const errors = {};
  const answers = {};

  for (const field of config.fields) {
    const raw = payload[field.name];
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();

    if (!value) {
      if (field.required) errors[field.name] = 'Заполните это поле';
      continue;
    }
    if (field.maxLength && value.length > field.maxLength) {
      errors[field.name] = `Не больше ${field.maxLength} символов`;
      continue;
    }
    if (field.type === 'select' && Array.isArray(field.options) && !field.options.includes(value)) {
      errors[field.name] = 'Выберите вариант из списка';
      continue;
    }
    if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      errors[field.name] = 'Проверьте адрес почты';
      continue;
    }
    if (field.type === 'tel' && (value.replace(/\D/g, '').length < 9)) {
      errors[field.name] = 'Проверьте номер телефона';
      continue;
    }
    answers[field.name] = value;
  }

  return { errors, answers, ok: Object.keys(errors).length === 0 };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  // Защита от выхода за пределы public/
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Страница не найдена');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] || 'application/octet-stream',
    'cache-control': relative === 'index.html' ? 'no-store' : 'public, max-age=300',
  });
  fs.createReadStream(target).pipe(res);
}

function isAdmin(url) {
  const key = url.searchParams.get('key') || '';
  const expected = config.adminKey;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // Настройки формы + состояние таймера для текущего устройства.
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const { session } = resolveSession(req, res);
      return sendJson(res, 200, {
        ...sessionState(session),
        windowHours: config.windowHours,
        brand: config.brand,
        fields: config.fields,
      });
    }

    if (url.pathname === '/api/submit' && req.method === 'POST') {
      const { session } = resolveSession(req, res);
      const state = sessionState(session);

      // Главная проверка: дедлайн валидируется на сервере, а не в браузере.
      if (state.expired) return sendJson(res, 403, { error: 'expired', ...state });
      if (state.submitted) return sendJson(res, 409, { error: 'already_submitted', ...state });

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: 'bad_request' });
      }
      if (!payload || typeof payload !== 'object') return sendJson(res, 400, { error: 'bad_request' });

      const { ok, errors, answers } = validate(payload);
      if (!ok) return sendJson(res, 422, { error: 'validation', errors });

      store.addLead({
        id: crypto.randomUUID(),
        sessionId: session.id,
        createdAt: Date.now(),
        answers,
        meta: { ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 300) },
      });
      store.markSubmitted(session.id);

      return sendJson(res, 200, { ok: true, ...sessionState(store.getSession(session.id)) });
    }

    if (url.pathname === '/api/leads' && req.method === 'GET') {
      if (!isAdmin(url)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, {
        stats: store.stats(),
        fields: config.fields.map(({ name, label }) => ({ name, label })),
        leads: store.allLeads().slice().reverse(),
      });
    }

    if (url.pathname === '/api/leads.csv' && req.method === 'GET') {
      if (!isAdmin(url)) return sendJson(res, 401, { error: 'unauthorized' });
      const header = ['Дата', ...config.fields.map((f) => f.label)];
      const rows = store.allLeads().map((lead) => [
        new Date(lead.createdAt).toISOString(),
        ...config.fields.map((f) => lead.answers[f.name] || ''),
      ]);
      const csv = [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="leads.csv"',
      });
      return res.end('﻿' + csv); // BOM, чтобы Excel корректно открыл кириллицу
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);

    res.writeHead(405).end('Method Not Allowed');
  } catch (error) {
    console.error('Ошибка запроса:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`Лендинг запущен: http://localhost:${config.port}`);
  console.log(`Админка: http://localhost:${config.port}/admin.html?key=${config.adminKey}`);
  if (config.adminKey === 'change-me') console.warn('Внимание: смените ADMIN_KEY в .env');
});
