// HTTP-сервер лендинга. Без внешних зависимостей.
//
// Механика таймера:
//   1. Первый заход  -> сервер кладёт в cookie подписанный дедлайн (сейчас + windowHours).
//   2. Любой следующий заход с тем же устройством -> возвращается ТОТ ЖЕ дедлайн.
//      Время не перезапускается и продолжает идти, пока сайт закрыт.
//   3. Приём анкеты проверяется на сервере по подписи: подменить дедлайн
//      в браузере нельзя — без секретного ключа подпись не сойдётся.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const token = require('./lib/token');
const leads = require('./lib/leads');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_NAME = 'ng';
// Запасной канал для того же подписанного токена, когда cookie не переживает перезаход.
const HEADER_NAME = 'x-ng-token';
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

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(res, req, payload) {
  const parts = [
    `${COOKIE_NAME}=${token.sign(payload, config.secret)}`,
    'Path=/',
    `Max-Age=${config.cookieDays * 24 * 3600}`,
    'SameSite=Lax',
    'HttpOnly',
  ];
  // Secure выставляем только под https, иначе cookie не сохранится при локальной проверке.
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

// Устройство присылает свой дедлайн двумя независимыми путями: cookie и заголовок
// (браузер держит копию токена в localStorage). Мобильные браузеры и встроенные
// webview соцсетей регулярно теряют cookie между сессиями, поэтому одного канала мало.
function collectSessions(req) {
  const candidates = [parseCookies(req)[COOKIE_NAME], req.headers[HEADER_NAME]];
  return candidates.map((value) => token.verify(value, config.secret)).filter(Boolean);
}

// Возвращает дедлайн устройства: из любого сохранившегося токена либо новый.
function resolveSession(req, res) {
  const found = collectSessions(req);

  if (found.length === 0) {
    const fresh = { d: Date.now() + config.windowHours * 3600 * 1000, s: 0, v: 1 };
    setSessionCookie(res, req, fresh);
    return fresh;
  }

  // Берём самый ранний дедлайн и «липкий» признак отправки: очистка одного
  // хранилища не должна давать новые 24 часа или второй заход анкеты.
  const earliest = found.reduce((a, b) => (b.d < a.d ? b : a));
  const session = { ...earliest, s: found.some((item) => item.s === 1) ? 1 : 0 };

  // Восстанавливаем cookie, если её потеряли, — иначе устройство останется
  // только на одном канале и следующая потеря обнулит таймер.
  setSessionCookie(res, req, session);
  return session;
}

function sessionState(payload) {
  const now = Date.now();
  return {
    now,
    // Подписанная копия для localStorage. Секретов внутри нет, а подделать
    // её без ключа нельзя — поэтому отдавать в браузер безопасно.
    token: token.sign(payload, config.secret),
    deadline: payload.d,
    msLeft: Math.max(0, payload.d - now),
    expired: now >= payload.d,
    submitted: payload.s === 1,
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

  // Состояние таймера для текущего устройства + описание полей анкеты.
  if (url.pathname === '/api/session' && req.method === 'GET') {
    const session = resolveSession(req, res);
    return sendJson(res, 200, {
      ...sessionState(session),
      windowHours: config.windowHours,
      submitLabel: config.submitLabel,
      successTitle: config.successTitle,
      successText: config.successText,
      expiredTitle: config.expiredTitle,
      expiredText: config.expiredText,
      fields: config.fields,
    });
  }

  if (url.pathname === '/api/submit' && req.method === 'POST') {
    const session = resolveSession(req, res);
    const state = sessionState(session);

    // Главная проверка: дедлайн валидируется по подписи на сервере.
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

    const delivery = await leads.save(
      {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        answers,
        meta: { ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 300) },
      },
      config.fields
    );

    // Если ни один приёмник не принял заявку — не закрываем форму и просим
    // отправить заново. Молча «принять» и потерять лид хуже, чем показать ошибку.
    if (!delivery.delivered) return sendJson(res, 503, { error: 'not_delivered', ...state });

    // Помечаем устройство как отправившее анкету — повторно форма не откроется.
    const submitted = { ...session, s: 1 };
    setSessionCookie(res, req, submitted);
    return sendJson(res, 200, { ok: true, ...sessionState(submitted) });
  }

  // Диагностика. Показывает, что именно сервер получил от устройства и каким
  // ключом подписывает токены. Секрет не раскрывается — только его отпечаток:
  // если отпечаток меняется между деплоями, значит SESSION_SECRET непостоянен,
  // и тогда таймеры обнуляются у всех при каждом обновлении сайта.
  if (url.pathname === '/api/debug' && req.method === 'GET') {
    const cookieToken = parseCookies(req)[COOKIE_NAME];
    const headerToken = req.headers[HEADER_NAME];
    const session = resolveSession(req, res);
    const state = sessionState(session);

    return sendJson(res, 200, {
      отпечатокКлюча: crypto.createHash('sha256').update(config.secret).digest('hex').slice(0, 12),
      ключЗадан: config.hasCustomSecret,
      пришлаCookie: Boolean(cookieToken),
      cookieВалидна: Boolean(token.verify(cookieToken, config.secret)),
      пришёлТокенИзБраузера: Boolean(headerToken),
      токенВалиден: Boolean(token.verify(headerToken, config.secret)),
      осталосьЧасов: Math.round((state.msLeft / 3600000) * 100) / 100,
      анкетаОтправлена: state.submitted,
      защищённоеСоединение: isHttps(req),
      хранилищеЗаявок: leads.fileSink,
      // Значения не раскрываются: только факт, что они дошли до процесса,
      // и длина — по ней видно, подставилось ли значение целиком.
      телеграмТокенЗадан: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      длинаТокена: (process.env.TELEGRAM_BOT_TOKEN || '').length,
      телеграмЧатЗадан: Boolean(process.env.TELEGRAM_CHAT_ID),
      длинаЧата: (process.env.TELEGRAM_CHAT_ID || '').length,
      таблицаЗадана: Boolean(process.env.SHEETS_WEBHOOK_URL),
    });
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
    if (!config.hasCustomSecret) console.warn('Внимание: задайте SESSION_SECRET в .env, иначе таймеры сбросятся при смене ключа');
    if (config.adminKey === 'change-me') console.warn('Внимание: смените ADMIN_KEY в .env');
  });
}

module.exports = server;
