// HTTP-сервер лендинга. Без внешних зависимостей.
//
// Приём анкет: заявка проверяется по полям из config.fields и уходит в Telegram.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const leads = require('./lib/leads');
const settings = require('./lib/settings');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
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
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Проверка анкеты по описанию полей из config.fields.
function validate(payload) {
  const errors = {};
  const answers = {};

  for (const field of config.fields) {
    const raw = payload[field.name];
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();

    if (!value) {
      if (field.required) errors[field.name] = 'Заполни это поле';
      continue;
    }
    if (field.maxLength && value.length > field.maxLength) {
      errors[field.name] = `Не больше ${field.maxLength} символов`;
      continue;
    }
    if (field.type === 'select' && Array.isArray(field.options) && !field.options.includes(value)) {
      errors[field.name] = 'Выбери вариант из списка';
      continue;
    }
    if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      errors[field.name] = 'Проверь адрес почты';
      continue;
    }
    if (field.type === 'tel' && value.replace(/\D/g, '').length < 9) {
      errors[field.name] = 'Проверь номер телефона';
      continue;
    }
    if (field.type === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        errors[field.name] = 'Нужно число';
        continue;
      }
    }
    answers[field.name] = value;
  }

  return { errors, answers, ok: Object.keys(errors).length === 0 };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res) {
  const header = ['Дата', ...config.fields.map((f) => f.label)];
  const rows = leads.readAll().map((lead) => [
    new Date(lead.createdAt).toISOString(),
    ...config.fields.map((f) => lead.answers[f.name] || ''),
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\n');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="leads.csv"',
  });
  res.end('﻿' + csv); // BOM, чтобы Excel открыл кириллицу
}

function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  // Защита от выхода за пределы public/
  if (path.relative(PUBLIC_DIR, target).startsWith('..')) {
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
  const provided = Buffer.from(url.searchParams.get('key') || '');
  const expected = Buffer.from(config.adminKey);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/submit' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    if (!payload || typeof payload !== 'object') return sendJson(res, 400, { error: 'bad_request' });

    const { ok, errors, answers } = validate(payload);
    if (!ok) return sendJson(res, 422, { error: 'validation', errors });

    const delivery = await leads.save(
      {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        answers,
        meta: { ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 300) },
      },
      config.fields
    );

    // Если ни один приёмник не принял заявку — просим отправить заново.
    // Молча «принять» и потерять лид хуже, чем показать ошибку.
    if (!delivery.delivered) return sendJson(res, 503, { error: 'not_delivered' });

    return sendJson(res, 200, { ok: true });
  }

  // Диагностика доставки: только факт, что значения дошли до процесса, и их длина.
  if (url.pathname === '/api/debug' && req.method === 'GET') {
    return sendJson(res, 200, {
      хранилищеЗаявок: leads.fileSink,
      телеграмТокенЗадан: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      длинаТокена: (process.env.TELEGRAM_BOT_TOKEN || '').length,
      телеграмЧатЗадан: Boolean(process.env.TELEGRAM_CHAT_ID),
      длинаЧата: (process.env.TELEGRAM_CHAT_ID || '').length,
      таблицаЗадана: Boolean(process.env.SHEETS_WEBHOOK_URL),
    });
  }

  // Настройки доставки задаются в админке и живут на постоянном диске.
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    if (!isAdmin(url)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { settings: settings.status() });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!isAdmin(url)) return sendJson(res, 401, { error: 'unauthorized' });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    try {
      return sendJson(res, 200, { ok: true, settings: settings.save(payload || {}) });
    } catch (error) {
      // Чаще всего это отсутствующий том: писать некуда.
      return sendJson(res, 500, { error: 'save_failed', reason: error.code || String(error.message) });
    }
  }

  // Пробное сообщение: возвращает дословный ответ Telegram, чтобы причина
  // отказа была видна сразу, без отправки настоящей анкеты.
  if (url.pathname === '/api/settings/test' && req.method === 'POST') {
    if (!isAdmin(url)) return sendJson(res, 401, { error: 'unauthorized' });
    const result = await leads.sendTest(config.fields);
    return sendJson(res, 200, result);
  }

  if (url.pathname === '/api/leads' && req.method === 'GET') {
    if (!isAdmin(url)) return sendJson(res, 401, { error: 'unauthorized' });
    if (url.searchParams.get('format') === 'csv') return sendCsv(res);
    const all = leads.readAll();
    return sendJson(res, 200, {
      stats: { leads: all.length },
      storage: leads.fileSink,
      fields: config.fields.map(({ name, label }) => ({ name, label })),
      leads: all.slice().reverse(),
    });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);

  res.writeHead(405).end('Method Not Allowed');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('Ошибка запроса:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.end();
  });
});

// На serverless-хостинге модуль импортируется, а слушать порт не нужно.
if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`Лендинг запущен: http://localhost:${config.port}`);
    console.log(`Заявки: http://localhost:${config.port}/admin.html?key=${config.adminKey}`);
    if (config.adminKey === 'change-me') console.warn('Внимание: смените ADMIN_KEY в .env');
  });
}

module.exports = server;
