const WHATSAPP_NUMBER = "996700000000";

const form = document.getElementById("signup-form");
const note = document.getElementById("form-note");

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const data = new FormData(form);
  const name = data.get("name").trim();
  const phone = data.get("phone").trim();
  const comment = data.get("comment").trim();

  const text = [
    "Здравствуйте! Хочу записаться на пробный урок (вышул сабак).",
    `Имя: ${name}`,
    `Телефон: ${phone}`,
    comment ? `Комментарий: ${comment}` : null,
  ].filter(Boolean).join("\n");

  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

  note.textContent = "Открываем WhatsApp, чтобы отправить заявку…";
  window.open(url, "_blank", "noopener");
  form.reset();
});
