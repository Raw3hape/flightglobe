# tracking-backend

Real-time aircraft tracker — бэкенд на Bun.

Поллит [adsb.lol](https://api.adsb.lol) каждые 5 секунд, ведёт in-memory карту
самолётов, считает delta (spawned / updated / despawned) и рассылает её всем
подключённым WebSocket-клиентам.

## Запуск

```bash
cd backend
bun install
bun run src/index.ts
# либо с автоперезапуском:
bun run dev
```

Сервер слушает порт `8080` (можно переопределить через `PORT=...`).

## Эндпоинты

- `GET /health` — JSON `{ ok, aircraft, clients }`.
- `WS  /ws` — при подключении шлёт `ServerHello` с полным снэпшотом,
  затем `ServerDelta` каждые 5 секунд.

## Протокол

См. `src/protocol.ts` (копия `shared/protocol.ts`).

## Структура

- `src/index.ts` — bootstrap
- `src/protocol.ts` — типы сообщений
- `src/state.ts` — `Map<id, Aircraft>` + diff + TTL (30 c)
- `src/poller.ts` — fetch к adsb.lol + экспоненциальный backoff
- `src/server.ts` — Bun.serve HTTP + WebSocket
