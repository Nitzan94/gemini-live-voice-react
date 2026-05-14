// ABOUTME: Shared Gemini Live session config — model, system prompt, tools.
// ABOUTME: Imported by both the local example server and the hosted playground.

import { Type } from "@google/genai";

// Audio-native Live model. Swap for any Gemini Live model id.
export const MODEL = "gemini-3.1-flash-live-preview";

// Baked into the ephemeral token's liveConnectConstraints — the browser can't
// change it, so a leaked token is only ever this exact assistant.
export const SYSTEM_PROMPT = `You are a friendly voice assistant demoing the gemini-live-voice-react open-source template. Keep every reply short and conversational — one or two sentences.

When the session opens you will receive a single "[greeting]" cue. Respond with one short spoken sentence: introduce yourself and invite the user to chat or to ask you to change the page's accent color.

You have one tool: set_accent_color(color). Call it whenever the user asks to change the color, then briefly confirm out loud. Valid colors: orange, blue, green, pink, purple. Do not call the tool for anything else.`;

// The one demo tool. Whatever you declare here, handle by name in the App's
// onToolCall. The `color` param is an enum so the model can't invent values.
export const TOOLS = [
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
];
