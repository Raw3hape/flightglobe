// Точка входа: поднимает state, history, poller, HTTP/WS сервер.
import { Poller } from "./poller";
import { TrackingServer } from "./server";
import { AircraftState } from "./state";
import { HistoryStore } from "./history";

const PORT = Number(process.env.PORT ?? 8080);
const CLEANUP_INTERVAL_MS = 60_000;

const state = new AircraftState();
const history = new HistoryStore();
const server = new TrackingServer(state, PORT, history);
const poller = new Poller(
  state,
  {
    onDelta: (delta) => server.broadcastDelta(delta),
  },
  history,
);

server.start();
poller.start();

// Periodic cleanup: удаляем stale rings чтобы не утекала память.
const cleanupTimer = setInterval(() => {
  const removed = history.cleanup(Date.now());
  if (removed > 0) {
    console.log(`[history] cleanup: removed ${removed} stale rings (size=${history.size()})`);
  }
}, CLEANUP_INTERVAL_MS);

// Глобальные обработчики — чтобы не падать на unhandled reject
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
});

function shutdown(signal: string): void {
  console.log(`[process] received ${signal}, shutting down`);
  clearInterval(cleanupTimer);
  poller.stop();
  server.stop();
  // даём 200мс закрыть сокеты
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
