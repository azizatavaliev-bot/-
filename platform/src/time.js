// Работа с часовыми поясами без внешних библиотек.

/** Смещение пояса (мс) относительно UTC в заданный момент. */
export function tzOffsetMs(tz, atUtcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(atUtcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(atUtcMs / 1000) * 1000;
}

/** "2026-11-03 21:30" в поясе tz -> UTC ms. Возвращает null, если формат неверный. */
export function localToUtc(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(str).trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = guess - tzOffsetMs(tz, guess);
  utc = guess - tzOffsetMs(tz, utc); // второй проход — для переходов на летнее время
  return utc;
}

/** UTC ms -> {date:'YYYY-MM-DD', time:'HH:mm', dow:0..6, text} в поясе tz. */
export function utcToLocalParts(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, dow, text: `${date} ${time}` };
}

const DOW_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export function nowText(tz) {
  const p = utcToLocalParts(Date.now(), tz);
  return `${p.text} (${DOW_RU[p.dow]}), пояс ${tz}`;
}
export function fmtLocal(utcMs, tz) {
  const p = utcToLocalParts(utcMs, tz);
  return `${p.text} (${DOW_RU[p.dow]})`;
}

/** Следующее срабатывание повторяющегося напоминания после fromUtcMs. */
export function nextRepeat(repeat, localTime, tz, fromUtcMs) {
  if (repeat === 'none') return null;
  const base = utcToLocalParts(fromUtcMs, tz);
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(+base.date.slice(0, 4), +base.date.slice(5, 7) - 1, +base.date.slice(8, 10) + add));
    const dateStr = day.toISOString().slice(0, 10);
    const cand = localToUtc(`${dateStr} ${localTime}`, tz);
    if (cand == null || cand <= fromUtcMs) continue;
    const dow = utcToLocalParts(cand, tz).dow;
    if (repeat === 'weekdays' && (dow === 0 || dow === 6)) continue;
    if (repeat === 'weekly') {
      const baseDow = utcToLocalParts(fromUtcMs, tz).dow;
      if (dow !== baseDow) continue;
    }
    return cand;
  }
  return null;
}
