import { db, getChat, getSetting, audit } from './db.js';
import { runAgent } from './agent.js';
import { wa, sendText } from './whatsapp.js';
import { nextRepeat } from './time.js';

let busy = false;

export function startScheduler() {
  setInterval(tick, 15_000);
  console.log('[scheduler] запущен');
}

async function tick() {
  if (busy || wa.status !== 'open') return; // пока WhatsApp не подключён — просрочки подождут
  busy = true;
  try {
    const due = db.prepare('SELECT * FROM reminders WHERE done = 0 AND due_at <= ? ORDER BY due_at LIMIT 20').all(Date.now());
    for (const r of due) {
      // Сначала сдвигаем/закрываем — чтобы при сбое не слать дубли каждые 15 секунд
      const tz = getSetting('timezone');
      const next = nextRepeat(r.repeat, r.local_time, tz, Date.now());
      if (next) db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(next, r.id);
      else db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(r.id);
      try {
        if (r.kind === 'task') {
          const chat = getChat(r.jid) || { jid: r.jid, name: '', prompt: '', ads_read: 1, ads_write: 0, reminders: 1 };
          const reply = await runAgent({
            jid: r.jid, chat, mode: 'owner', ownerJid: r.jid, save: false,
            text: `[Автозадача по расписанию] ${r.text}\nВыполни и пришли результат владельцу. Изменения рекламы в автозадачах не делай — только предложи.`,
          });
          await sendText(r.jid, reply, { typing: false });
        } else {
          await sendText(r.jid, `⏰ ${r.text}`, { typing: false });
        }
        audit(r.jid, 'reminder_fired', { id: r.id, kind: r.kind });
      } catch (e) {
        console.error('[scheduler]', r.id, e.message);
        audit(r.jid, 'reminder_error', { id: r.id, error: e.message });
      }
    }
  } finally {
    busy = false;
  }
}
