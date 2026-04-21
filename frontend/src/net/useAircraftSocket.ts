import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import type { ServerMessage } from "../protocol";

// Порядок разрешения URL:
// 1. VITE_WS_URL из окружения (prod: укажи публичный wss:// адрес backend)
// 2. Локалхост для dev
const DEFAULT_URL =
  (import.meta as any).env?.VITE_WS_URL || "ws://localhost:8080/ws";
const BACKOFFS_MS = [1000, 2000, 5000, 10000, 30000];

export function useAircraftSocket(url: string = DEFAULT_URL) {
  const applyHello = useStore((s) => s.applyHello);
  const applyDelta = useStore((s) => s.applyDelta);
  const setConnState = useStore((s) => s.setConnState);

  const sockRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef<number>(0);
  const stoppedRef = useRef<boolean>(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    stoppedRef.current = false;

    const connect = () => {
      if (stoppedRef.current) return;
      setConnState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      sockRef.current = ws;

      ws.onopen = () => {
        attemptsRef.current = 0;
        setConnState("open");
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
          if (msg.t === "hello") {
            applyHello(msg.initial ?? [], msg.serverTime);
          } else if (msg.t === "delta") {
            applyDelta(
              msg.spawned ?? [],
              msg.updated ?? [],
              msg.despawned ?? [],
              msg.serverTime
            );
          }
        } catch (e) {
          // swallow malformed frames
          // eslint-disable-next-line no-console
          console.warn("bad WS frame", e);
        }
      };

      ws.onerror = () => {
        setConnState("error");
      };

      ws.onclose = () => {
        setConnState("closed");
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (stoppedRef.current) return;
      const idx = Math.min(attemptsRef.current, BACKOFFS_MS.length - 1);
      const delay = BACKOFFS_MS[idx];
      attemptsRef.current += 1;
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(connect, delay);
    };

    connect();

    return () => {
      stoppedRef.current = true;
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const ws = sockRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
      sockRef.current = null;
    };
  }, [url, applyHello, applyDelta, setConnState]);
}
