# gemini-live-voice-react

Portable React hook for Gemini Live speech-to-speech. Open-source extraction of a production voice feature. Live playground: https://gemini-live-voice-react.vercel.app

## Structure

```
src/useGeminiLiveVoice.ts   The portable hook — mic, dual AudioContext, queue-capped playback
example/                     Local dev demo, Bun fullstack server (the production pattern)
  server.ts                  Serves the app + mints ephemeral tokens (key stays server-side)
  voices.ts                  Shared voice allowlist
  session-config.ts          Shared model + system prompt + tools (also imported by playground/)
playground/                  Static BYO-key variant, deployed to Vercel
  mint.ts                    Client-side authTokens.create with the visitor's pasted key
vercel.json                  Vercel build config (static, no functions)
```

## Commands

```sh
bun install
bun run dev                 # example/ on :3000 (server-side mint; needs GEMINI_API_KEY in .env)
bun run dev:playground      # playground/ on :3000 (no .env; paste a key in the UI)
bun run build:playground    # static build → dist/
bunx tsc --noEmit           # typecheck (src + example + playground)

# Deploy playground to Vercel
vercel --prod --yes --scope nitzans-projects-d0fda97a
```

## The hook is sacred — don't couple it

The hook depends only on React + `@google/genai`. Backend coupling lives behind three injected props: `mintToken`, `onToolCall`, `onSessionEnd`. Session config (model, voice, system prompt, tools) goes in the ephemeral token's `liveConnectConstraints`, not into hook arguments. If a new feature seems to need a hook change, the prop seam is probably missing something — fix the seam.

## Non-obvious invariants

- **`MAX_PLAYBACK_LEAD_SEC = 0.5`** — caps how far ahead of realtime audio is scheduled. Without it, server VAD's `interrupted` fires after the turn already ended and barge-in silently breaks. This is the hook's headline value.
- **`apiVersion: "v1alpha"`** — mandatory for ephemeral tokens both server-side (`authTokens.create`) and in the browser SDK. v1beta returns 404 with no useful error.
- **Playback on `ctx.destination`** — do NOT route through `<audio srcObject>` or anywhere else. AEC works on `ctx.destination`; previous attempts broke echo cancellation.
- **If client-side VAD is ever added, use Silero (`@ricky0123/vad-web`), not a hand-rolled RMS gate.** RMS has been tried twice and dropped real speech both times.

## Two patterns, one repo

`example/` is the **production pattern**: API key server-side, browser gets short-lived ephemeral tokens. `playground/` is the **explicit exception**: visitors paste their *own* key, used only in their browser, never touches a server. Never copy the playground pattern into a real product.

## Accounts

Repo lives under GitHub `Nitzan94` (personal). The user's other account `nitzanbarness-94` is for separate work. Before pushing here:
```sh
gh auth switch --user Nitzan94
# ... commit + push ...
gh auth switch --user nitzanbarness-94   # restore after
```

Vercel scope: `nitzans-projects-d0fda97a` (account `nitzan94`).
