# 🍊 Omlet Arcade PC

Фанатское возрождение Omlet Arcade для ПК. Веб-платформа живых трансляций:
стримь свой экран, общайся в чате, подписывайся на стримеров.

**Стек:** Node.js (Express + WS) · Turso (libSQL) · WebRTC · Render

## Возможности
- 🔴 Трансляции экрана (getDisplayMedia → WebRTC, зрители смотрят в браузере)
- 💬 Живой чат трансляций с историей
- 👤 Профили, подписки, счётчики
- 🎮 Категории игр (Minecraft PE, Roblox, PUBG Mobile и др.)
- 🔐 Своя регистрация/вход (scrypt-хеши, сессии в БД)

## Деплой (Render)
1. Создай Turso БД, получи `DATABASE_URL` и `DATABASE_AUTH_TOKEN`
2. Создай Web Service из этого репозитория (Node, `npm install` → `node server.js`)
3. Добавь env: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`

## Локально
```bash
npm install
npm start        # http://localhost:3000 (без env — локальный sqlite-файл)
```

## API
| Метод | Путь | Описание |
|---|---|---|
| POST | /api/register | регистрация |
| POST | /api/login | вход |
| GET | /api/streams | список эфиров (live + recent) |
| POST | /api/streams | начать эфир |
| POST | /api/streams/:id/end | завершить |
| GET | /api/users/:username | профиль |
| POST/DELETE | /api/users/:username/follow | подписка |
| WS | /ws?stream=ID&token=JWT | чат + WebRTC-сигналинг |

*Фанатский проект. Не аффилирован с Omlet Arcade.*
