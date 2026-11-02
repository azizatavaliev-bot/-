import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { getSetting, upsertChat, getChat, updateChat, addMessage, audit, listChats } from './db.js';
import { runAgent } from './agent.js';
import { wa, sendText } from './whatsapp.js';

const digits = (s) => String(s || '').replace(/\D/g, '');

export function ownerNumbers() {
  return getSetting('owner_numbers').split(/[,\s;]+/).map(digits).filter(Boolean);
}
export function ownerJids() {
  const set = new Set(ownerNumbers().map((n) => `${n}@s.whatsapp.net`));
  for (const c of listChats()) if (c.mode === 'owner' && !c.is_group && !c.jid.startsWith('test:')) set.add(c.jid);
  return [...set];
}
export async function notifyOwners(text) {
  for (const jid of ownerJids()) {
    await sendText(jid, text, { typing: false }).catch((e) => console.error('[notify]', jid, e.message));
  }
}

function extractText(msg) {
  const m = msg.message || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.buttonsResponseMessage?.selectedDisplayId ||
    inner.listResponseMessage?.title ||
    ''
  );
}
const isAudio = (msg) => Boolean((msg.message || {}).audioMessage);

function mentionedMe(msg) {
  const inner = msg.message || {};
  const ctxInfo = inner.extendedTextMessage?.contextInfo || inner.imageMessage?.contextInfo || {};
  const ids = (ctxInfo.mentionedJid || []).map((j) => jidNormalizedUser(j));
  const me = [wa.me?.id, wa.me?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
  return ids.some((j) => me.includes(j));
}

// Очереди: склеиваем быстрые сообщения подряд и обрабатываем чат строго по одному.
const queues = new Map(); // jid -> { texts, timer, busy, chat }

export async function onIncoming(msg) {
  const key = msg.key;
  const jid = key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  const isGroup = jid.endsWith('@g.us');
  const text = extractText(msg);

  // --- сообщение от нас самих ---
  if (key.fromMe) {
    if (wa.sentIds.has(key.id) || !text) return;
    // Человек сам ответил с телефона: пауза бота в этом чате + запоминаем для контекста
    upsertChat(jid, { isGroup });
    addMessage(jid, 'human', text);
    const mins = Number(getSetting('handoff_minutes')) || 0;
    if (mins > 0) updateChat(jid, { paused_until: Date.now() + mins * 60_000 });
    audit(jid, 'handoff', `бот на паузе ${mins} мин`);
    return;
  }

  // --- входящее ---
  const senderAlt = key.remoteJidAlt || key.participantAlt || '';
  const phone = isGroup ? '' : jid.endsWith('@s.whatsapp.net') ? digits(jid) : digits(senderAlt);
  let chat = upsertChat(jid, { name: msg.pushName && !isGroup ? msg.pushName : '', phone, isGroup });
  const isOwner = !isGroup && phone && ownerNumbers().some((n) => phone.endsWith(n) || n.endsWith(phone));

  let mode = isOwner ? 'owner' : chat.mode || getSetting('default_mode');
  if (isGroup && !chat.mode) mode = 'off';
  if (mode === 'off') return;

  if (!text) {
    if (isAudio(msg) && !isGroup) {
      await sendText(jid, 'Голосовые пока не слушаю — напишите, пожалуйста, текстом 🙏', { typing: false }).catch(() => {});
    }
    return;
  }

  if (isGroup) {
    const trig = getSetting('group_trigger').trim().toLowerCase();
    const hit = mentionedMe(msg) || (trig && text.toLowerCase().includes(trig));
    if (!hit) return;
  }

  const label = isGroup ? `${msg.pushName || key.participant || 'кто-то'}: ${text}` : text;

  if (chat.paused_until > Date.now()) {
    addMessage(jid, 'user', label); // читаем, но не отвечаем — человек ведёт диалог
    return;
  }

  enqueue(jid, label, mode);
}

function enqueue(jid, text, mode) {
  let q = queues.get(jid);
  if (!q) queues.set(jid, (q = { texts: [], timer: null, busy: false, mode }));
  q.texts.push(text);
  q.mode = mode;
  clearTimeout(q.timer);
  const delay = Math.max(0, Number(getSetting('reply_delay_sec')) || 0) * 1000;
  q.timer = setTimeout(() => flush(jid), delay);
}

async function flush(jid) {
  const q = queues.get(jid);
  if (!q || q.busy || !q.texts.length) return;
  q.busy = true;
  const text = q.texts.splice(0).join('\n');
  try {
    const chat = getChat(jid);
    if (chat.paused_until > Date.now()) { addMessage(jid, 'user', text); return; }
    const reply = await runAgent({ jid, chat, mode: q.mode, text, ownerJid: jid });
    if (reply) await sendText(jid, reply);
  } catch (e) {
    console.error('[agent]', jid, e);
    audit(jid, 'error', e.message);
    if (q.mode === 'owner') {
      await sendText(jid, `⚠️ Ошибка: ${e.message}`, { typing: false }).catch(() => {});
    } else {
      // клиенту техническую ошибку не показываем — сообщаем владельцу
      await notifyOwners(`⚠️ Не смог ответить клиенту ${getChat(jid)?.name || jid}: ${e.message}`).catch(() => {});
    }
  } finally {
    q.busy = false;
    if (q.texts.length) flush(jid);
  }
}
