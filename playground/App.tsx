// ABOUTME: Hosted playground — paste your own Gemini key, try the voice hook.
// ABOUTME: The key is used only in this browser to mint tokens (see mint.ts).

import { useState, type CSSProperties } from "react";
import {
  useGeminiLiveVoice,
  type LiveToolResponse,
} from "../src/useGeminiLiveVoice";
import { VOICES, DEFAULT_VOICE } from "../example/voices";
import { mintInBrowser } from "./mint";

const ACCENTS: Record<string, string> = {
  orange: "#ff6432",
  blue: "#2f7df6",
  green: "#1f9d57",
  pink: "#e84d8a",
  purple: "#8b5cf6",
};

// Kept for this browser tab only — gone when the tab closes. The key never
// leaves the browser regardless; sessionStorage just saves re-pasting it.
const KEY_STORAGE = "gemini_api_key";

export function App() {
  const [apiKey, setApiKey] = useState(
    () => sessionStorage.getItem(KEY_STORAGE) ?? "",
  );

  if (!apiKey) {
    return (
      <KeyGate
        onSubmit={(key) => {
          sessionStorage.setItem(KEY_STORAGE, key);
          setApiKey(key);
        }}
      />
    );
  }

  return (
    <Playground
      apiKey={apiKey}
      onClearKey={() => {
        sessionStorage.removeItem(KEY_STORAGE);
        setApiKey("");
      }}
    />
  );
}

function KeyGate({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>gemini-live-voice-react</h1>
        <p style={styles.sub}>
          A live playground for the open-source voice hook. Paste a Gemini API
          key to try it — speech-to-speech.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) onSubmit(trimmed);
          }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="AIza…  (your Gemini API key)"
            autoComplete="off"
            style={styles.input}
          />
          <button
            type="submit"
            disabled={!trimmed}
            style={{
              ...styles.mic,
              background: "#1b1b1b",
              marginTop: 12,
              opacity: trimmed ? 1 : 0.5,
              cursor: trimmed ? "pointer" : "default",
            }}
          >
            Try it
          </button>
        </form>
        <p style={styles.disclaimer}>
          Your key is used <b>only in this browser</b> — it mints short-lived
          tokens directly with Google and never touches any server. It's kept in
          this tab's <code>sessionStorage</code> and cleared when you close the
          tab. Get a key at{" "}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            aistudio.google.com/apikey
          </a>
          .
        </p>
        <p style={styles.disclaimer}>
          This is a playground. A real app should mint tokens server-side so end
          users never handle a key — see <code>example/</code> in the repo.
        </p>
      </div>
    </div>
  );
}

function Playground({
  apiKey,
  onClearKey,
}: {
  apiKey: string;
  onClearKey: () => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [accent, setAccent] = useState("orange");
  const [voice, setVoice] = useState(DEFAULT_VOICE);

  const { state, errorMessage, transcripts } = useGeminiLiveVoice({
    enabled,
    debug: true,
    greeting: "[greeting]",
    // Seam 1 — mint a token. Here it happens in-browser with the visitor's own
    // key (see mint.ts); in a real app this would call your backend.
    mintToken: () => mintInBrowser(apiKey, voice),
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
    // Seam 3 — session ended. Persist however you like; here we just log.
    onSessionEnd: (summary) =>
      console.log("[playground] session ended:", summary),
  });

  const color = ACCENTS[accent] ?? "#ff6432";
  const busy = state === "connecting";

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>gemini-live-voice-react</h1>
        <p style={styles.sub}>
          Talk over the bot mid-sentence and it stops. Ask it to change the
          accent color to see a tool call. Open the console for queue depth and
          <code> INTERRUPTED</code> events.
        </p>

        <div style={styles.pickerRow}>
          <label style={styles.pickerLabel} htmlFor="voice">
            Voice
          </label>
          <select
            id="voice"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            disabled={state !== "idle"}
            style={styles.picker}
          >
            {VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>

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

        <button type="button" onClick={onClearKey} style={styles.clearKey}>
          Clear API key
        </button>
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
  sub: { margin: "0 0 20px", color: "#666", fontSize: 14, lineHeight: 1.6 },
  input: {
    width: "100%",
    padding: "12px 14px",
    fontSize: 14,
    borderRadius: 10,
    border: "1px solid #ddd",
    fontFamily: "inherit",
  },
  disclaimer: {
    fontSize: 12,
    color: "#888",
    lineHeight: 1.6,
    margin: "16px 0 0",
  },
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  pickerLabel: { fontSize: 13, fontWeight: 600, color: "#444" },
  picker: {
    flex: 1,
    padding: "8px 10px",
    fontSize: 14,
    borderRadius: 8,
    border: "1px solid #ddd",
    background: "#fff",
  },
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
  clearKey: {
    marginTop: 16,
    background: "none",
    border: "none",
    color: "#999",
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
    padding: 0,
  },
};
