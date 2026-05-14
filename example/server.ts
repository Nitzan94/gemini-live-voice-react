// ABOUTME: Bun fullstack server for the demo — serves the app + mints Live tokens.
// ABOUTME: The GEMINI_API_KEY lives here, server-side; it never reaches the browser.

import { GoogleGenAI, Modality, Type } from "@google/genai";
import index from "./index.html";
import { VOICES, DEFAULT_VOICE } from "./voices";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(
    "\n  GEMINI_API_KEY is not set.\n" +
      "  Copy .env.example to .env and add your key, then re-run `bun dev`.\n",
  );
  process.exit(1);
}

// Audio-native Live model. Swap for any Gemini Live model id.
const MODEL = "gemini-3.1-flash-live-preview";

// System prompt + tools are baked into the ephemeral token's
// liveConnectConstraints — the browser can't change them, so a leaked token is
// only ever this exact assistant.
const SYSTEM_PROMPT = `You are a friendly voice assistant demoing the gemini-live-voice-react open-source template. Keep every reply short and conversational — one or two sentences.

When the session opens you will receive a single "[greeting]" cue. Respond with one short spoken sentence: introduce yourself and invite the user to chat or to ask you to change the page's accent color.

You have one tool: set_accent_color(color). Call it whenever the user asks to change the color, then briefly confirm out loud. Valid colors: orange, blue, green, pink, purple. Do not call the tool for anything else.`;

// Mint a one-use ephemeral token. This is the endpoint the hook's `mintToken`
// prop calls — in a real app you'd add auth, rate limiting, and per-user config
// here before creating the token.
async function mint(req: Request): Promise<Response> {
  // Validate the requested voice at the boundary — only an allowlisted value
  // gets baked into the token. The browser sends a string; trust nothing.
  const body: { voice?: string } = await req.json().catch(() => ({}));
  const voiceName =
    body.voice && VOICES.includes(body.voice) ? body.voice : DEFAULT_VOICE;

  // apiVersion v1alpha is mandatory for ephemeral tokens — authTokens.create is
  // only mapped on the alpha surface; v1beta 404s with no useful error.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  const now = Date.now();
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        // 30 min covers a full session plus resumption reconnects.
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        // 1 min to actually open the session — limits a leaked token's window.
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "set_accent_color",
                    description:
                      "Change the demo page's accent color. Call when the user asks to change the color.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        color: {
                          type: Type.STRING,
                          enum: ["orange", "blue", "green", "pink", "purple"],
                        },
                      },
                      required: ["color"],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    });
    // The SDK returns either { name } or a bare string depending on version.
    const liveToken =
      (token as { name?: string }).name ??
      (typeof token === "string" ? token : "");
    if (!liveToken) throw new Error("empty token from Gemini");
    return Response.json({ liveToken, model: MODEL, maxSessionMinutes: 15 });
  } catch (err) {
    console.error("mint failed:", err);
    return new Response("mint failed", { status: 502 });
  }
}

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": index,
    "/api/mint": { POST: mint },
  },
});

console.log(`\n  gemini-live-voice-react demo  →  ${server.url}\n`);
