// Отправка анкеты. Поля описаны в config.js и проверяются на сервере.
(function () {
  'use strict';

  var SUBMIT_LABEL = 'Записаться на консультацию';
  var form = document.getElementById('anketa');
  var fields = document.getElementById('fields');
  var formError = document.getElementById('formError');
  var submitBtn = document.getElementById('submitBtn');

  function clearFieldError(wrap) {
    wrap.classList.remove('field--invalid');
    var error = wrap.querySelector('.field-error');
    if (error) error.remove();
  }

  function setFieldError(name, message) {
    var wrap = fields.querySelector('[data-name="' + name + '"]');
    if (!wrap) return;
    clearFieldError(wrap);
    wrap.classList.add('field--invalid');
    var error = document.createElement('p');
    error.className = 'field-error';
    error.textContent = message;
    wrap.appendChild(error);
  }

  function showError(text) {
    formError.textContent = text;
    formError.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = SUBMIT_LABEL;
  }

  Array.prototype.forEach.call(fields.querySelectorAll('.field'), function (wrap) {
    wrap.querySelector('input').addEventListener('input', function () { clearFieldError(wrap); });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    formError.hidden = true;
    Array.prototype.forEach.call(fields.querySelectorAll('.field'), clearFieldError);

    var payload = {};
    Array.prototype.forEach.call(form.elements, function (element) {
      if (element.name) payload[element.name] = element.value;
    });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляем…';

    fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (data) { return { status: response.status, data: data }; });
      })
      .then(function (result) {
        if (result.status === 200) {
          document.getElementById('formCard').hidden = true;
          document.getElementById('stateCard').hidden = false;
          return;
        }
        if (result.status === 422) {
          Object.keys(result.data.errors || {}).forEach(function (name) {
            setFieldError(name, result.data.errors[name]);
          });
          showError('Проверь отмеченные поля.');
          var firstInvalid = fields.querySelector('.field--invalid');
          if (firstInvalid) firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        showError('Не удалось отправить. Попробуй ещё раз.');
      })
      .catch(function () { showError('Нет связи с сервером. Проверь интернет.'); });
  });
})();
