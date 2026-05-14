// ABOUTME: Client-side ephemeral-token mint for the hosted playground.
// ABOUTME: Uses the visitor's own API key, in their browser — it never leaves.

import { GoogleGenAI, Modality } from "@google/genai";
import type { MintResult } from "../src/useGeminiLiveVoice";
import { MODEL, SYSTEM_PROMPT, TOOLS } from "../example/session-config";

// Mints a one-use ephemeral token directly from the browser with the visitor's
// own key. CORS on Google's authTokens endpoint allows this. The key is used
// here and nowhere else — it never touches a server.
//
// A real app should still mint server-side (see example/server.ts) so an end
// user never handles a key at all. This is a playground pattern: fine for "try
// it with your own key", not for shipping to users.
export async function mintInBrowser(
  apiKey: string,
  voice: string,
): Promise<MintResult> {
  // apiVersion v1alpha is mandatory for ephemeral tokens — authTokens.create is
  // only mapped on the alpha surface; v1beta 404s with no useful error.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      liveConnectConstraints: {
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          tools: TOOLS,
        },
      },
    },
  });
  // The SDK returns either { name } or a bare string depending on version.
  const liveToken =
    (token as { name?: string }).name ??
    (typeof token === "string" ? token : "");
  if (!liveToken) {
    throw new Error("Couldn't mint a token — check your API key.");
  }
  return { liveToken, model: MODEL, maxSessionMinutes: 15 };
}
