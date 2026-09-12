require('./lib/env');

const crypto = require('crypto');

// Ключ подписи cookie с дедлайном. Если он изменится — у всех посетителей
// таймер начнётся заново, поэтому на проде задайте его в переменных окружения
// один раз и не меняйте.
const secret = process.env.SESSION_SECRET || crypto.createHash('sha256').update('newg-dev-secret').digest('hex');

module.exports = {
  // Сколько времени даётся на анкету с момента первого захода.
  windowHours: 24,

  port: Number(process.env.PORT) || 3000,
  secret,
  hasCustomSecret: Boolean(process.env.SESSION_SECRET),

  // Ключ доступа к /admin.html?key=...
  adminKey: process.env.ADMIN_KEY || 'change-me',

  // Сколько браузер хранит cookie. Должно быть заметно больше windowHours,
  // иначе после её истечения человек получит новые 24 часа.
  cookieDays: 90,

  submitLabel: 'Записаться на консультацию',
  successTitle: 'Анкета принята',
  successText: 'Свяжемся с тобой по указанному WhatsApp и согласуем время консультации.',
  expiredTitle: 'Время вышло',
  expiredText: 'Отведённые 24 часа закончились, запись по этой ссылке закрыта. Если тебе всё ещё актуально — напиши в директ.',

  // Поля анкеты. type: text | tel | email | number | textarea | select
  // Короткая анкета: чем меньше полей, тем выше доходимость до отправки.
  fields: [
    { name: 'name', label: 'Как тебя зовут', type: 'text', required: true, maxLength: 80 },
    {
      name: 'phone',
      label: 'WhatsApp для связи',
      type: 'tel',
      required: true,
      maxLength: 30,
      placeholder: '+996 700 000 000',
    },
    { name: 'age', label: 'Сколько тебе лет', type: 'number', required: true, maxLength: 3 },
    { name: 'city', label: 'Город', type: 'text', required: false, maxLength: 80 },
  ],
};
