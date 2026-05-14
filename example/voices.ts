// ABOUTME: Shared prebuilt-voice list — imported by both the mint server and the picker UI.
// One source of truth keeps the server's allowlist and the dropdown from drifting.

// Gemini Live prebuilt voices. The mint server validates a requested voice
// against this list before baking it into the token; the App renders it as the
// picker.
export const VOICES = [
  "Kore",
  "Puck",
  "Charon",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
];

export const DEFAULT_VOICE = "Kore";
