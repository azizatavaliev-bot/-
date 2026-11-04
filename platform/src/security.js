import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

// Ключ шифрования токенов Meta. APP_SECRET из окружения, иначе генерируется и лежит в data/secret.key
function loadKey() {
  let raw = process.env.APP_SECRET;
  if (!raw) {
    const f = path.join(DATA_DIR, 'secret.key');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    raw = fs.readFileSync(f, 'utf8').trim();
  }
  return crypto.createHash('sha256').update(raw).digest();
}
let KEY;
const key = () => (KEY ??= loadKey());

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, enc] = blob.split(':');
  if (v !== 'v1') throw new Error('Неизвестный формат токена');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `s1:${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored).split(':');
  if (v !== 's1') return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
export const randomCode = (n = 6) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n * 4 / 3 | 0).toUpperCase();
