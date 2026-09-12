// Дедлайн хранится в подписанной cookie, а не в базе.
// Подпись HMAC-SHA256 закрытым ключом: подделать или продлить срок на стороне
// клиента невозможно, а серверу для проверки не нужно постоянное хранилище —
// это позволяет одинаково работать и на VPS, и на serverless-хостинге.
const crypto = require('crypto');

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + mac;
}

function verify(token, secret) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const received = fromB64url(mac);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (!payload || typeof payload.d !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
