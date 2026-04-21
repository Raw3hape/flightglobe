import { useStore } from "../state/store";

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function Status() {
  const connState = useStore((s) => s.connState);
  const count = useStore((s) => s.count);

  const label =
    connState === "open"
      ? "CONNECTED"
      : connState === "connecting"
      ? "CONNECTING..."
      : connState === "error"
      ? "ERROR"
      : connState === "closed"
      ? "RECONNECTING..."
      : "IDLE";

  const dotColor =
    connState === "open"
      ? "#00ffaa"
      : connState === "connecting"
      ? "#00eaff"
      : "#ff3366";

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        zIndex: 10,
        pointerEvents: "none",
        color: "#00eaff",
        fontFamily:
          '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        letterSpacing: "0.08em",
        textShadow: "0 0 8px rgba(0,234,255,0.6), 0 0 16px rgba(0,234,255,0.3)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 10px",
          border: "1px solid rgba(0,234,255,0.25)",
          background: "rgba(0,10,20,0.35)",
          backdropFilter: "blur(2px)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            boxShadow: `0 0 10px ${dotColor}`,
            display: "inline-block",
          }}
        />
        <span>{label}</span>
        <span style={{ opacity: 0.5 }}>•</span>
        <span>{fmtNum(count)} AIRCRAFT</span>
      </div>
    </div>
  );
}
