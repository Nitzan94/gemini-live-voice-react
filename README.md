# gemini-live-voice-react

A React hook for [Gemini Live](https://ai.google.dev/gemini-api/docs/live) speech-to-speech — with **barge-in that actually works**.

Drop `useGeminiLiveVoice` into any React app to get a full voice session: microphone capture, streaming audio playback, tool calls, and clean teardown. You bring three things — a token minter, a tool handler, a session-end callback — and the hook owns the rest.

```tsx
const { state, errorMessage, transcripts } = useGeminiLiveVoice({
  enabled,
  mintToken: async () => (await fetch("/api/mint", { method: "POST" })).json(),
  onToolCall: async (calls) => /* … */,
  onSessionEnd: (summary) => /* … */,
  greeting: "[greeting]",
});
```

## Why this exists

Most Gemini Live starter code gets **interruption** wrong. The naive playback path schedules every audio chunk the moment it arrives — but Gemini streams a 25-second answer in a ~3-second burst, so 25 seconds of audio ends up queued in the Web Audio graph. The server finishes its turn at second 3; the user talks over the audio at second 10; but the server's turn ended 7 seconds ago, so its VAD has nothing to interrupt. No `interrupted` event fires, and the bot talks over you to the end.

The fix is a **playback queue cap**: decode chunks into a JS queue and schedule at most ~0.5s ahead of realtime. Now perceived playback tracks the server's turn state, so `interrupted` lands while the turn is still live and barge-in works. That cap is built into this hook (`MAX_PLAYBACK_LEAD_SEC`).

It does not make barge-in *instant* — you still pay one mic → server → VAD → `interrupted` → client round-trip, so stopping takes ~0.7–1s. If you need instant, add a client-side VAD that calls stop locally with no round-trip — but use a real VAD model, not a hand-rolled RMS gate.

## Run the demo

```sh
bun install
cp .env.example .env      # then add your GEMINI_API_KEY
bun dev                   # → http://localhost:3000
```

Pick a voice, click **Start voice**, allow the mic, and the assistant greets you. Talk over it mid-sentence — it stops. Ask it to "change the color to blue" to watch a tool call round-trip. Open the console (`debug: true` is on in the demo) to see the playback queue depth and `INTERRUPTED` events.

The voice picker is a good illustration of the prop seam: the chosen voice is baked into the ephemeral token server-side, so it rides along in `mintToken` — adding the picker needed zero changes to the hook.

The demo's Bun server (`example/server.ts`) serves the app *and* mints ephemeral tokens — your API key stays server-side. That's the pattern your real app should follow too.

## API

`useGeminiLiveVoice(args)` — args:

| prop | type | |
|---|---|---|
| `enabled` | `boolean` | Flip `true` to connect + stream mic, `false` to tear down. The hook owns the lifecycle — toggling rapidly can't leak parallel sessions. |
| `mintToken` | `() => Promise<MintResult>` | Mint an ephemeral Live token. Runs in *your* backend — do auth, rate limiting, and session config there. Throw an `Error` to abort; its message surfaces as `errorMessage`. |
| `onToolCall` | `(calls) => Promise<LiveToolResponse[]>` | Optional. Handle tool calls and return responses. The model blocks until you return — keep tools fast. |
| `onSessionEnd` | `(summary) => void` | Optional. Fires once on teardown with duration, token usage, end reason, and the resumption handle. |
| `greeting` | `string` | Optional. Sent as a one-shot cue right after connect so the model speaks first (Gemini Live never opens a turn on its own). |
| `debug` | `boolean` | Optional. `console.log` internals — WS open, queue depth, interrupts, mic levels. |

Returns `{ state, errorMessage, transcripts }`. `state` is `idle | connecting | listening | speaking | error`.

## Wiring your backend

The hook never sees your API key. `mintToken` should call a server endpoint that creates an [ephemeral token](https://ai.google.dev/gemini-api/docs/live) and bakes the session config — model, voice, system prompt, tools — into its `liveConnectConstraints`. Because the constraints live in the token, a leaked token can only ever be that one assistant.

`example/server.ts` is a complete ~80-line reference. Whatever tools you declare there, handle by name in `onToolCall` and return one `LiveToolResponse` per call.

## Architecture notes

- **Two AudioContexts.** Input is 16kHz, output is 24kHz, and a context's sample rate is fixed for its lifetime — so the hook runs one of each. The input context's `MediaStreamSource` resamples the mic for free.
- **ScriptProcessorNode**, not AudioWorklet. Deprecated but universally supported, and ~30 lines instead of a separate worklet file. Swap if a browser ever drops it.
- **The queue cap.** See *Why this exists*. `pumpPlayback` is edge-triggered — re-pumped on each new chunk and each source's `onended` — so it self-drains with no polling timer.
- **`apiVersion: "v1alpha"`** is mandatory for ephemeral tokens, both server-side (`authTokens.create`) and in the browser SDK. v1beta returns a 404 with no useful error message.
- **The greeting.** Gemini Live stays silent until it receives input. The `greeting` cue is sent as a one-shot user turn; pair it with a system-prompt line telling the model how to respond to it.

## License

MIT © 2026 Nitzan Bar-Ness
