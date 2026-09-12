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
    {
      name: 'experience',
      label: 'Опыт в таргете',
      type: 'select',
      required: true,
      options: [
        'С нуля, опыта нет',
        'Пробовал сам, без результата',
        'Запускал рекламу, есть первые деньги',
        'Работаю с клиентами постоянно',
      ],
    },
    {
      name: 'ai',
      label: 'Работал с ИИ в работе',
      type: 'select',
      required: true,
      options: ['Нет, не пробовал', 'Иногда, для текстов', 'Использую регулярно'],
    },
    {
      name: 'income',
      label: 'Сколько зарабатываешь сейчас в месяц',
      type: 'select',
      required: true,
      options: ['0 сом', 'До 30 000 сом', '30 000 – 100 000 сом', '100 000 – 300 000 сом', 'Больше 300 000 сом'],
    },
    {
      name: 'goal',
      label: 'Какой доход хочешь через 6 месяцев и зачем он тебе',
      type: 'textarea',
      required: true,
      maxLength: 1500,
      placeholder: 'Своими словами: цифра и что она изменит',
    },
    {
      name: 'time',
      label: 'Сколько часов в неделю готов вкладывать в обучение',
      type: 'select',
      required: true,
      options: ['До 5 часов', '5 – 10 часов', '10 – 20 часов', 'Больше 20 часов'],
    },
  ],
};
