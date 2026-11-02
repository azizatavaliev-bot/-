import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers,
} from '@whiskeysockets/baileys';
import { DATA_DIR } from './db.js';


export const wa = {
  sock: null,
  status: 'starting', // starting | qr | connecting | open | logged_out
  qrDataUrl: null,
  me: null,
  sentIds: new Set(), // id сообщений, отправленных ботом — чтобы отличать от ручных ответов владельца
  onMessage: null,
};

let stopping = false;
let retry = 0;

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'wa_auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'), markOnlineOnConnect: false, syncFullHistory: false,
  });
  wa.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      wa.status = 'qr';
      wa.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      console.log('[wa] QR готов — открой панель и отсканируй (WhatsApp → Связанные устройства).');
    }
    if (connection === 'connecting') wa.status = wa.status === 'qr' ? 'qr' : 'connecting';
    if (connection === 'open') {
      wa.status = 'open';
      retry = 0;
      wa.qrDataUrl = null;
      wa.me = sock.user || null;
      console.log('[wa] подключено:', sock.user?.id);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      wa.me = null;
      if (loggedOut) {
        wa.status = 'logged_out';
        console.log('[wa] сессия завершена (вышли из «Связанных устройств»). Удали data/wa_auth и отсканируй QR заново.');
      } else if (!stopping) {
        wa.status = 'connecting';
        const wait = Math.min(60_000, 3000 * 2 ** Math.min(retry++, 5));
        console.log('[wa] обрыв связи, код', code, `— переподключаюсь через ${wait / 1000} с`);
        setTimeout(() => startWhatsApp().catch((e) => console.error('[wa] reconnect', e)), wait);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) wa.onMessage?.(msg).catch((e) => console.error('[wa] handler', e));
  });
}

export async function logoutWhatsApp() {
  stopping = true;
  try { await wa.sock?.logout(); } catch {}
  stopping = false;
  wa.status = 'logged_out';
}

export async function sendText(jid, text, { typing = true } = {}) {
  if (!wa.sock || wa.status !== 'open') throw new Error('WhatsApp не подключён');
  if (typing) {
    await wa.sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise((r) => setTimeout(r, Math.min(4000, 400 + text.length * 15)));
  }
  // длинные ответы режем по абзацам: так выглядит естественнее и не упирается в лимиты
  const chunks = splitText(text);
  for (const c of chunks) {
    const sent = await wa.sock.sendMessage(jid, { text: c });
    if (sent?.key?.id) {
      wa.sentIds.add(sent.key.id);
      if (wa.sentIds.size > 2000) wa.sentIds.delete(wa.sentIds.values().next().value);
    }
  }
  if (typing) await wa.sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

function splitText(text, max = 1500) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((cur + '\n\n' + para).length > max && cur) { out.push(cur); cur = para; }
    else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}
