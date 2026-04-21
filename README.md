# FlightGlobe — неоновый 3D-глобус с самолётами в реальном времени

Cyberpunk-визуализация всех самолётов планеты на 3D-глобусе. Живые данные с [adsb.lol](https://adsb.lol) (~11K самолётов глобально, обновление каждые 5 секунд).

## Что внутри

- **backend/** — Bun + TypeScript + нативный WebSocket. Polling adsb.lol, diff-вычисление, broadcast дельт клиентам.
- **frontend/** — React + Vite + React Three Fiber. InstancedMesh на 20K самолётов, шейдеры, UnrealBloom, трейлы, dead-reckoning interpolation.
- **shared/** — контракт WebSocket-протокола.

## Запуск

В двух терминалах:

```bash
# Терминал 1 — backend на :8080
cd backend
bun install
bun run src/index.ts

# Терминал 2 — frontend на :5173
cd frontend
npm install
npm run dev
```

Открыть http://localhost:5173.

## Управление

- **Drag** — вращать глобус
- **Scroll** — zoom in/out
- **HUD вверху слева** — статус соединения + количество самолётов

## Что происходит визуально

- Тысячи светящихся точек на глобусе — каждая это самолёт
- Цвет по высоте: розовый (низкие, 0 м) → cyan (высокие, 12000+ м)
- Хвост-трейл за каждым самолётом, затухающий со временем
- Spawn-анимация (fade-in 800мс) когда появляется новый самолёт
- Despawn-анимация (fade-out 2.5 сек) когда самолёт пропал
- Между апдейтами (5 сек) — dead-reckoning по heading + velocity
- При получении свежей позиции — 500мс smooth lerp

## Источник данных

`https://api.adsb.lol/v2/lat/0/lon/0/dist/10000` — community ADS-B receivers (форк ADS-B Exchange). Бесплатно, без ключей, без жёстких rate-лимитов.

Покрытие: ~10-11K одновременно в воздухе по миру. Не покрывает: военные с выключенным транспондером, малая авиация без ADS-B, часть океанов без сателлитного приёма.
