# Деплой

## Frontend (Vercel) — готово

URL: **https://flightglobe.vercel.app/**

Настройки в [vercel.json](vercel.json). Деплой автоматически при push в `main`.

После того как backend будет задеплоен, пропиши env var в Vercel:

```bash
vercel env add VITE_WS_URL production
# вставь: wss://<твой-backend>.railway.app/ws
vercel deploy --prod
```

## Backend (Railway) — нужен ручной login

Backend — это persistent Bun WebSocket сервер, не serverless. Vercel для него не подходит.
Railway CLI установлен локально, но нужна интерактивная авторизация.

### Команды для деплоя

```bash
cd backend

# 1. Залогиниться (откроется браузер)
railway login

# 2. Создать проект
railway init          # выбери "Empty Project", имя: flightglobe-backend

# 3. Задеплоить (использует Dockerfile)
railway up

# 4. Включить публичный домен
railway domain        # скопируй выданный URL, например flightglobe-backend.up.railway.app
```

### Подключить frontend к backend

```bash
cd ..  # в корень проекта
vercel env add VITE_WS_URL production
# значение: wss://<домен-от-railway>/ws

vercel deploy --prod  # пересборка frontend с новым env
```

## Альтернативы Railway

- **Fly.io**: `brew install flyctl`, `fly launch`, `fly deploy`
- **Render**: через веб-интерфейс, указав Dockerfile в `backend/`
- **Любой VPS**: `bun run src/index.ts` под systemd/pm2 + nginx reverse-proxy для TLS
