// Клиентская часть. Источник правды по времени — сервер.
// Браузер лишь «докручивает» секунды между синхронизациями и не может продлить
// себе доступ: приём анкеты всё равно проверяется на бэкенде по подписи.
(function () {
  'use strict';

  // Копия подписанного токена с дедлайном. Cookie — основной канал, но мобильные
  // браузеры и встроенные webview соцсетей теряют её между заходами, и тогда
  // таймер начинался бы заново. localStorage переживает такие перезаходы.
  var STORAGE_KEY = 'ng_token';

  function readToken() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (error) {
      return ''; // приватный режим или запрет хранилища
    }
  }

  function saveToken(value) {
    if (!value) return;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      /* пишем только если браузер разрешает — cookie остаётся основным каналом */
    }
  }

  // Заголовок добавляется, только если копия есть: пустой токен сервер игнорирует.
  function authHeaders(extra) {
    var headers = extra || {};
    var saved = readToken();
    if (saved) headers['x-ng-token'] = saved;
    return headers;
  }

  var els = {
    timer: document.getElementById('timer'),
    timerValue: document.getElementById('timerValue'),
    formCard: document.getElementById('formCard'),
    form: document.getElementById('anketa'),
    fields: document.getElementById('fields'),
    formError: document.getElementById('formError'),
    submitBtn: document.getElementById('submitBtn'),
    stateCard: document.getElementById('stateCard'),
    stateTitle: document.getElementById('stateTitle'),
    stateText: document.getElementById('stateText'),
    loadingCard: document.getElementById('loadingCard'),
  };

  var state = {
    deadline: 0,
    // Поправка на расхождение часов устройства и сервера: без неё переведённые
    // вручную часы на телефоне ломали бы таймер.
    skew: 0,
    texts: null,
    rendered: false,
    // Итоговое состояние (отправлено или истекло) — дальше таймер не нужен.
    finished: false,
  };

  function serverNow() { return Date.now() + state.skew; }
  function pad(value) { return value < 10 ? '0' + value : String(value); }
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function formatLeft(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(total / 3600)) + ':' + pad(Math.floor((total % 3600) / 60)) + ':' + pad(total % 60);
  }

  function renderStatic(data) {
    if (state.rendered) return;
    state.rendered = true;
    state.texts = data;
    els.submitBtn.textContent = data.submitLabel;
    data.fields.forEach(function (field) { els.fields.appendChild(buildField(field)); });
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
      empty.textContent = 'Выбери…';
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
      if (field.type === 'tel') control.inputMode = 'tel';
      if (field.type === 'number') control.inputMode = 'numeric';
    }

    control.id = id;
    control.name = field.name;
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.maxLength && field.type !== 'number') control.maxLength = field.maxLength;
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
    hide(els.timer);
    els.stateTitle.textContent = title;
    els.stateText.textContent = text;
    show(els.stateCard);
  }

  function applyState(data) {
    hide(els.loadingCard);
    state.deadline = data.deadline;
    state.skew = data.now - Date.now();

    if (data.submitted) return showState(state.texts.successTitle, state.texts.successText);
    if (data.expired) return showState(state.texts.expiredTitle, state.texts.expiredText);

    state.finished = false;
    hide(els.stateCard);
    show(els.formCard);
    show(els.timer);
    tick();
  }

  function tick() {
    if (state.finished || !state.rendered || !state.deadline) return;
    var left = state.deadline - serverNow();
    if (left <= 0) {
      els.timerValue.textContent = '00:00:00';
      sync(); // истечение подтверждает сервер, а не браузер
      return;
    }
    els.timerValue.textContent = formatLeft(left);
    els.timer.classList.toggle('timer--urgent', left < 60 * 60 * 1000);
  }

  function sync() {
    return fetch('/api/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: authHeaders(),
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        saveToken(data.token);
        renderStatic(data);
        applyState(data);
      })
      .catch(function () {
        if (!state.rendered) els.loadingCard.textContent = 'Не удалось загрузить анкету. Обнови страницу.';
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
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (data) { return { status: response.status, data: data }; });
      })
      .then(function (result) {
        saveToken(result.data.token);
        if (result.status === 200 || result.status === 409) {
          return showState(state.texts.successTitle, state.texts.successText);
        }
        if (result.status === 403) {
          return showState(state.texts.expiredTitle, state.texts.expiredText);
        }
        if (result.status === 422) {
          Object.keys(result.data.errors || {}).forEach(function (name) {
            setFieldError(name, result.data.errors[name]);
          });
          els.formError.textContent = 'Проверь отмеченные поля.';
        } else {
          els.formError.textContent = 'Не удалось отправить. Попробуй ещё раз.';
        }
        show(els.formError);
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = state.texts.submitLabel;
        var firstInvalid = els.fields.querySelector('.field--invalid');
        if (firstInvalid) firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
      .catch(function () {
        els.formError.textContent = 'Нет связи с сервером. Проверь интернет.';
        show(els.formError);
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = state.texts.submitLabel;
      });
  });

  // Если файла урока ещё нет, показываем заглушку вместо пустого плеера.
  // Медиасобытия на <video> срабатывают не во всех браузерах одинаково,
  // поэтому наличие файла проверяем запросом — это предсказуемо везде.
  var lessonVideo = document.getElementById('lessonVideo');
  if (lessonVideo) {
    lessonVideo.addEventListener('error', showLessonStub, true);
    fetch('/lesson/lesson.mp4', { method: 'HEAD' })
      .then(function (response) { if (!response.ok) showLessonStub(); })
      .catch(showLessonStub);
  }

  function showLessonStub() {
    var stub = document.getElementById('lessonStub');
    if (!stub || !lessonVideo) return;
    lessonVideo.hidden = true;
    stub.hidden = false;
  }

  document.getElementById('year').textContent = new Date().getFullYear();

  setInterval(tick, 1000);
  // Пересверка с сервером: раз в минуту и при возврате на вкладку, чтобы вкладка,
  // провисевшая ночь в фоне, показывала корректное время.
  setInterval(sync, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
  window.addEventListener('pageshow', sync);

  sync();
})();
