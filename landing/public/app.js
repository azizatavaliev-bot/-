// Клиентская часть. Источник правды по времени — сервер.
// Браузер лишь «докручивает» секунды между синхронизациями и не может
// продлить себе доступ: приём анкеты всё равно проверяется на бэкенде.
(function () {
  'use strict';

  var els = {
    timerBar: document.getElementById('timerBar'),
    timerValue: document.getElementById('timerValue'),
    brandName: document.getElementById('brandName'),
    heroTitle: document.getElementById('heroTitle'),
    heroSubtitle: document.getElementById('heroSubtitle'),
    bullets: document.getElementById('bullets'),
    formCard: document.getElementById('formCard'),
    form: document.getElementById('form'),
    fields: document.getElementById('fields'),
    formError: document.getElementById('formError'),
    submitBtn: document.getElementById('submitBtn'),
    stateCard: document.getElementById('stateCard'),
    stateTitle: document.getElementById('stateTitle'),
    stateText: document.getElementById('stateText'),
    loadingCard: document.getElementById('loadingCard'),
    footer: document.getElementById('footer'),
  };

  var state = {
    deadline: 0,
    // Поправка на расхождение часов устройства и сервера.
    // Без неё переведённые вручную часы на телефоне ломали бы таймер.
    skew: 0,
    brand: null,
    rendered: false,
    // Итоговое состояние (отправлено или истекло) — дальше таймер не нужен.
    finished: false,
  };

  function serverNow() {
    return Date.now() + state.skew;
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatLeft(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    return pad(hours) + ':' + pad(minutes) + ':' + pad(total % 60);
  }

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function renderStatic(data) {
    if (state.rendered) return;
    state.rendered = true;
    state.brand = data.brand;

    document.title = data.brand.title + ' — ' + data.brand.name;
    els.brandName.textContent = data.brand.name;
    els.heroTitle.textContent = data.brand.title;
    els.heroSubtitle.textContent = data.brand.subtitle;
    els.footer.textContent = data.brand.footer || '';
    els.submitBtn.textContent = data.brand.submitLabel || 'Отправить';

    (data.brand.bullets || []).forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;
      els.bullets.appendChild(li);
    });

    data.fields.forEach(function (field) {
      els.fields.appendChild(buildField(field));
    });
  }

  function buildField(field) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.name = field.name;

    var id = 'f_' + field.name;
    var label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = field.label;
    if (field.required) {
      var star = document.createElement('span');
      star.className = 'req';
      star.textContent = ' *';
      label.appendChild(star);
    }
    wrap.appendChild(label);

    var control;
    if (field.type === 'textarea') {
      control = document.createElement('textarea');
    } else if (field.type === 'select') {
      control = document.createElement('select');
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Выберите…';
      control.appendChild(empty);
      (field.options || []).forEach(function (option) {
        var node = document.createElement('option');
        node.value = option;
        node.textContent = option;
        control.appendChild(node);
      });
    } else {
      control = document.createElement('input');
      control.type = field.type || 'text';
    }

    control.id = id;
    control.name = field.name;
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.maxLength) control.maxLength = field.maxLength;
    control.addEventListener('input', function () { clearFieldError(wrap); });
    control.addEventListener('change', function () { clearFieldError(wrap); });
    wrap.appendChild(control);
    return wrap;
  }

  function clearFieldError(wrap) {
    wrap.classList.remove('field--invalid');
    var error = wrap.querySelector('.field-error');
    if (error) error.remove();
  }

  function setFieldError(name, message) {
    var wrap = els.fields.querySelector('[data-name="' + name + '"]');
    if (!wrap) return;
    clearFieldError(wrap);
    wrap.classList.add('field--invalid');
    var error = document.createElement('p');
    error.className = 'field-error';
    error.textContent = message;
    wrap.appendChild(error);
  }

  function showState(title, text) {
    state.finished = true;
    hide(els.formCard);
    hide(els.loadingCard);
    els.stateTitle.textContent = title;
    els.stateText.textContent = text;
    show(els.stateCard);
  }

  function applyState(data) {
    hide(els.loadingCard);
    state.deadline = data.deadline;
    state.skew = data.now - Date.now();

    if (data.submitted) {
      state.finished = true;
      hide(els.timerBar);
      showState(state.brand.successTitle, state.brand.successText);
      return;
    }
    if (data.expired) {
      state.finished = true;
      hide(els.timerBar);
      showState(state.brand.expiredTitle, state.brand.expiredText);
      return;
    }
    state.finished = false;
    hide(els.stateCard);
    show(els.formCard);
    show(els.timerBar);
    tick();
  }

  function tick() {
    if (state.finished || !state.rendered || !state.deadline) return;
    var left = state.deadline - serverNow();
    if (left <= 0) {
      els.timerValue.textContent = '00:00:00';
      // Подтверждаем истечение у сервера, а не решаем это в браузере.
      sync();
      return;
    }
    els.timerValue.textContent = formatLeft(left);
    els.timerBar.classList.toggle('timer-bar--urgent', left < 60 * 60 * 1000);
  }

  function sync() {
    return fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        renderStatic(data);
        applyState(data);
      })
      .catch(function () {
        if (!state.rendered) {
          els.loadingCard.textContent = 'Не удалось загрузить форму. Обновите страницу.';
        }
      });
  }

  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    hide(els.formError);
    Array.prototype.forEach.call(els.fields.querySelectorAll('.field'), clearFieldError);

    var payload = {};
    Array.prototype.forEach.call(els.form.elements, function (element) {
      if (element.name) payload[element.name] = element.value;
    });

    els.submitBtn.disabled = true;
    els.submitBtn.textContent = 'Отправляем…';

    fetch('/api/submit', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (data) { return { status: response.status, data: data }; });
      })
      .then(function (result) {
        if (result.status === 200) {
          hide(els.timerBar);
          showState(state.brand.successTitle, state.brand.successText);
          return;
        }
        if (result.status === 422) {
          Object.keys(result.data.errors || {}).forEach(function (name) {
            setFieldError(name, result.data.errors[name]);
          });
          els.formError.textContent = 'Проверьте отмеченные поля.';
          show(els.formError);
        } else if (result.status === 403) {
          hide(els.timerBar);
          showState(state.brand.expiredTitle, state.brand.expiredText);
          return;
        } else if (result.status === 409) {
          hide(els.timerBar);
          showState(state.brand.successTitle, state.brand.successText);
          return;
        } else {
          els.formError.textContent = 'Не удалось отправить. Попробуйте ещё раз.';
          show(els.formError);
        }
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = state.brand.submitLabel;
      })
      .catch(function () {
        els.formError.textContent = 'Нет связи с сервером. Проверьте интернет.';
        show(els.formError);
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = state.brand.submitLabel;
      });
  });

  setInterval(tick, 1000);
  // Пересверка с сервером: раз в минуту и при каждом возврате на вкладку —
  // так вкладка, провисевшая ночь в фоне, показывает корректное время.
  setInterval(sync, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) sync();
  });
  window.addEventListener('pageshow', sync);

  sync();
})();
