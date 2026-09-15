# SmileKit — карусели для Instagram

Рендер слайдов 1080×1350 (4:5) из JSON-конфига через Chromium.

## Как собрать

```bash
node carousel/render.js carousel/carousels/01-white-teeth.json
# если playwright не установлен локально:
NODE_PATH=$(npm root -g) node carousel/render.js carousel/carousels/01-white-teeth.json
```

PNG появятся в `carousel/out/<id>/slide-N.png`.

## Фото

Кладём в `carousel/assets/photos/` и указываем имя файла в конфиге
(`top` — белые зубы, `bottom` — жёлтые). Нет файла — рендерится заглушка.
Каждая половина слайда 1080×675, фото кадрируется по `object-fit: cover`;
точку кадрирования можно сдвинуть через `topPos` / `bottomPos`
(например `"center 20%"`).

## Типы слайдов

| type      | поля                                                        |
|-----------|-------------------------------------------------------------|
| `hook`    | `kicker`, `title`, `sub`, `footer`, `titleSize`             |
| `compare` | `top`, `bottom`, `topPos`, `bottomPos`, `caption`, `labelTop`, `labelBottom` |
| `cta`     | `title`, `sub`, `bullets[]`, `button`, `note`, `titleSize`  |

Бренд: индиго `#2A1FD1`, шрифты Montserrat (кириллица) + Poppins (логотип).
