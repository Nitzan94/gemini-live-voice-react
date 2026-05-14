// ABOUTME: Minimal demo of useGeminiLiveVoice — mic button, status, transcripts.
// ABOUTME: Wires the three seams: mintToken, onToolCall, onSessionEnd.

import { useState, type CSSProperties } from "react";
import {
  useGeminiLiveVoice,
  type LiveToolResponse,
} from "../src/useGeminiLiveVoice";

const ACCENTS: Record<string, string> = {
  orange: "#ff6432",
  blue: "#2f7df6",
  green: "#1f9d57",
  pink: "#e84d8a",
  purple: "#8b5cf6",
};

export function App() {
  const [enabled, setEnabled] = useState(false);
  const [accent, setAccent] = useState("orange");

  const { state, errorMessage, transcripts } = useGeminiLiveVoice({
    enabled,
    debug: true,
    // Gemini Live never speaks first. This cue — paired with the system prompt
    // in example/server.ts — makes it open with a one-line greeting.
    greeting: "[greeting]",
    // Seam 1 — mint an ephemeral token. Server-side, so the API key never
    // reaches the browser. See example/server.ts.
    mintToken: async () => {
      const res = await fetch("/api/mint", { method: "POST" });
      if (!res.ok) {
        throw new Error(
          "Couldn't mint a token — is GEMINI_API_KEY set? See the README.",
        );
      }
      return res.json();
    },
    // Seam 2 — handle tool calls. The model blocks until this resolves.
    onToolCall: async (calls): Promise<LiveToolResponse[]> =>
      calls.map((call) => {
        if (call.name === "set_accent_color") {
          const color = String(call.args?.color ?? "");
          if (color in ACCENTS) {
            setAccent(color);
            return {
              id: call.id,
              name: call.name,
              response: { result: { ok: true } },
            };
          }
          return {
            id: call.id,
            name: call.name,
            response: { result: { ok: false, message: "Unknown color." } },
          };
        }
        return {
          id: call.id,
          name: call.name,
          response: {
            result: { ok: false, message: `Unknown tool ${call.name}.` },
          },
        };
      }),
    // Seam 3 — session ended. Persist this however you like; here we just log.
    onSessionEnd: (summary) => console.log("[demo] session ended:", summary),
  });

  const color = ACCENTS[accent] ?? "#ff6432";
  const busy = state === "connecting";

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>gemini-live-voice-react</h1>
        <p style={styles.sub}>
          Speech-to-speech with Gemini Live — and barge-in that actually works.
          Talk over the bot mid-sentence and it stops. Ask it to change the
          accent color to see a tool call round-trip.
        </p>

        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          disabled={busy}
          style={{
            ...styles.mic,
            background: enabled ? color : "#1b1b1b",
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {enabled ? "Stop" : "Start"} voice
        </button>

        <div style={styles.statusRow}>
          <span style={{ ...styles.pill, background: color }}>{state}</span>
          {errorMessage && <span style={styles.error}>{errorMessage}</span>}
        </div>

        <div style={styles.transcript}>
          {transcripts.length === 0 && (
            <p style={styles.empty}>Transcripts will appear here…</p>
          )}
          {transcripts.map((t, i) => (
            <p key={i} style={styles.line}>
              <b style={{ color: t.role === "assistant" ? color : "#444" }}>
                {t.role === "assistant" ? "bot" : "you"}
              </b>{" "}
              {t.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background: "#faf7f1",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    padding: 24,
  },
  card: {
    width: "min(540px, 100%)",
    background: "#fff",
    borderRadius: 20,
    padding: "32px 28px",
    boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.06)",
  },
  h1: { margin: "0 0 6px", fontSize: 22, letterSpacing: "-0.01em" },
  sub: { margin: "0 0 24px", color: "#666", fontSize: 14, lineHeight: 1.6 },
  mic: {
    width: "100%",
    padding: "14px 0",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    border: "none",
    borderRadius: 12,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    margin: "16px 0",
    minHeight: 24,
  },
  pill: {
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: 999,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  error: { color: "#c0392b", fontSize: 13 },
  transcript: {
    borderTop: "1px solid #eee",
    paddingTop: 14,
    maxHeight: 220,
    overflowY: "auto",
  },
  empty: { color: "#aaa", fontSize: 13, margin: 0 },
  line: { margin: "0 0 8px", fontSize: 14, lineHeight: 1.5 },
};
