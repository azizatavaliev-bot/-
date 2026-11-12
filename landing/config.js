require('./lib/env');

module.exports = {
  port: Number(process.env.PORT) || 3000,

  // Ключ доступа к /admin.html?key=...
  adminKey: process.env.ADMIN_KEY || 'change-me',

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
