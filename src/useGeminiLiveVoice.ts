// ABOUTME: Portable React hook for a Gemini Live speech-to-speech voice session.
// ABOUTME: Mic capture, dual AudioContext, queue-capped playback, tool dispatch, teardown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleGenAI, Modality, type Session } from "@google/genai";

// Sample rates the Gemini Live native-audio model requires. Input is 16kHz
// 16-bit PCM mono; output is 24kHz 16-bit PCM mono. They differ, so the hook
// runs two AudioContext instances (input at 16k, playback at 24k) — an
// AudioContext has a fixed sample rate per its WebAudio spec.
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
// ScriptProcessor buffer size — 4096 samples at 16kHz is ~256ms latency
// between mic capture and a chunk reaching Gemini. Smaller buffers cut latency
// but increase CPU + WS message rate; 4096 is the de-facto default and lines
// up with Gemini's own VAD windowing.
const INPUT_BUFFER_SIZE = 4096;
// Cap how far ahead of realtime we schedule decoded audio. Gemini streams a
// full response's audio in a ~3s burst; scheduling it all immediately desyncs
// perceived playback from the server's turn state by 20s+, so the server's
// `interrupted` event arrives long after its turn is already complete and
// barge-in silently fails. Holding chunks in a JS queue and only scheduling
// ~0.5s ahead keeps perceived playback close to server turn state, so
// `interrupted` lands while the turn is still active. Tunable: lower = tighter
// barge-in, higher = more network-jitter tolerance.
const MAX_PLAYBACK_LEAD_SEC = 0.5;

export type VoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export interface VoiceTranscriptEntry {
  role: "user" | "assistant";
  text: string;
  atMs: number;
}

// Tool call event shape from the Gemini Live SDK. Typed loosely to absorb minor
// field-name drift across SDK versions — the fields read here are stable.
export interface LiveFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface LiveToolResponse {
  id?: string;
  name: string;
  response: { result: unknown };
}

export interface MintResult {
  // Ephemeral Gemini Live token. Mint this server-side — never ship your raw
  // API key to the browser. The token's liveConnectConstraints define the
  // session (model, voice, tools, system prompt).
  liveToken: string;
  // Model id, e.g. "gemini-3.1-flash-live-preview".
  model: string;
  // Hard client-side session cap. Defaults to 15 (the Live API audio ceiling).
  maxSessionMinutes?: number;
}

export type SessionEndReason =
  | "user_ended"
  | "timeout"
  | "client_closed"
  | "error";

export interface SessionEndSummary {
  reason: SessionEndReason;
  durationMs: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  // Gemini session-resumption handle, if the server issued one. Persist it to
  // reconnect across the ~15min Live session cliff.
  resumeHandle: string | null;
  errorMessage?: string;
}

export interface UseGeminiLiveVoiceArgs {
  // Flip true to connect + stream mic; flip false to tear down. One useEffect
  // owns the lifecycle, so toggling rapidly can't leak parallel sessions.
  enabled: boolean;
  // Mint an ephemeral Gemini Live token. This runs in YOUR app — do auth,
  // access checks, and rate limiting here, and bake the session config (model,
  // voice, tools, system prompt) into the token's liveConnectConstraints
  // server-side. Throw an Error to abort; its `.message` surfaces as
  // `errorMessage`.
  mintToken: () => Promise<MintResult>;
  // Handle a tool call and return responses. The model BLOCKS until you
  // return, so keep tools fast. Omit if your session declares no tools.
  onToolCall?: (calls: LiveFunctionCall[]) => Promise<LiveToolResponse[]>;
  // Called once on teardown with duration + token usage. Persist however you
  // like (a DB write, an analytics event, nothing at all).
  onSessionEnd?: (summary: SessionEndSummary) => void;
  // Make the model speak first. Gemini Live never opens a turn on its own, so
  // this string is sent as a one-shot user cue right after connect. Pair it
  // with a system-prompt instruction, or just pass a plain instruction like
  // "Greet the user with a one-line intro." Omit for user-speaks-first.
  greeting?: string;
  // console.log internal diagnostics (WS open, queue depth, interrupts).
  // Default false.
  debug?: boolean;
}

export interface UseGeminiLiveVoiceReturn {
  state: VoiceSessionState;
  errorMessage: string | null;
  transcripts: VoiceTranscriptEntry[];
}

function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // String-building loop is O(n) but the chunks here are ~8KB; `Buffer` isn't
  // available in the browser and `btoa` is the standard browser pathway.
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// PCM helper — Gemini Live exchanges 16-bit signed little-endian samples.
function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function useGeminiLiveVoice({
  enabled,
  mintToken,
  onToolCall,
  onSessionEnd,
  greeting,
  debug = false,
}: UseGeminiLiveVoiceArgs): UseGeminiLiveVoiceReturn {
  const [state, setState] = useState<VoiceSessionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<VoiceTranscriptEntry[]>([]);

  // Stable diagnostic logger — reads `debug` at call time via a ref so it
  // doesn't have to be a dependency of every callback below.
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const log = useRef((...args: unknown[]) => {
    if (debugRef.current) console.log("[gemini-live-voice]", ...args);
  }).current;

  // Props captured in refs so the lifecycle callbacks stay stable — re-running
  // connect/teardown on every render would leak sessions.
  const mintTokenRef = useRef(mintToken);
  mintTokenRef.current = mintToken;
  const onToolCallRef = useRef(onToolCall);
  onToolCallRef.current = onToolCall;
  const onSessionEndRef = useRef(onSessionEnd);
  onSessionEndRef.current = onSessionEnd;
  const greetingRef = useRef(greeting);
  greetingRef.current = greeting;

  // Refs are the right shape here: N async event handlers coordinate without
  // re-render churn (audio playback, tool dispatch, teardown). React state is
  // for what the UI renders.
  const sessionRef = useRef<Session | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const inputProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const playbackNextStartRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  // Decoded-but-not-yet-scheduled audio buffers. playAudioChunk decodes into
  // here; pumpPlayback drains it just-in-time so we never schedule more than
  // MAX_PLAYBACK_LEAD_SEC ahead of ctx.currentTime.
  const pendingChunksRef = useRef<AudioBuffer[]>([]);
  const sessionStartedAtRef = useRef<number>(0);
  const tokenUsageRef = useRef<{ input: number; output: number }>({
    input: 0,
    output: 0,
  });
  const resumeHandleRef = useRef<string | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards onSessionEnd against double-firing — the WebSocket can close on both
  // an explicit teardown AND a server-side GoAway in the same tick.
  const teardownRunningRef = useRef(false);
  const chunkCountRef = useRef(0);
  const interruptCountRef = useRef(0);

  const stopPlayback = useCallback(() => {
    // Called when Gemini reports the user interrupted ("interrupted: true") or
    // on teardown. Stops every scheduled buffer source, drops the pending
    // queue, and rewinds the schedule cursor.
    const queuedSec = Math.max(
      0,
      playbackNextStartRef.current - (outputCtxRef.current?.currentTime ?? 0),
    );
    log(
      `stopPlayback: ${activeSourcesRef.current.size} source(s), ${queuedSec.toFixed(2)}s queued`,
    );
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch {
        // Already stopped — fine.
      }
    });
    activeSourcesRef.current.clear();
    // Drop anything decoded-but-not-yet-scheduled too — on a barge-in the whole
    // queued turn is stale, not just the sources already playing.
    pendingChunksRef.current = [];
    playbackNextStartRef.current = 0;
  }, [log]);

  // Drains pendingChunksRef into the Web Audio graph, but never schedules more
  // than MAX_PLAYBACK_LEAD_SEC ahead of realtime. Re-invoked on every new chunk
  // (playAudioChunk) and on every source's `onended` — between those two
  // triggers the queue always tops up as playback drains, with no polling
  // timer. This cap is what makes barge-in work — see MAX_PLAYBACK_LEAD_SEC.
  const pumpPlayback = useCallback(() => {
    const ctx = outputCtxRef.current;
    if (!ctx) return;
    while (pendingChunksRef.current.length > 0) {
      const lead = playbackNextStartRef.current - ctx.currentTime;
      if (lead >= MAX_PLAYBACK_LEAD_SEC) break;
      const audioBuffer = pendingChunksRef.current.shift();
      if (!audioBuffer) break;
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, playbackNextStartRef.current);
      src.start(startAt);
      playbackNextStartRef.current = startAt + audioBuffer.duration;
      activeSourcesRef.current.add(src);
      src.onended = () => {
        activeSourcesRef.current.delete(src);
        // Top up as playback drains — keeps the lead near the cap.
        pumpPlayback();
      };
    }
  }, []);

  const playAudioChunk = useCallback(
    (base64: string) => {
      const ctx = outputCtxRef.current;
      if (!ctx) return;
      const bytes = base64ToUint8Array(base64);
      // PCM int16 LE — wrap the byte buffer in an Int16Array. base64ToUint8Array
      // returns a fresh, 2-byte-aligned buffer, which Int16Array requires.
      const int16 = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        Math.floor(bytes.byteLength / 2),
      );
      const audioBuffer = ctx.createBuffer(1, int16.length, OUTPUT_SAMPLE_RATE);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < int16.length; i++) {
        channel[i] = (int16[i] ?? 0) / 0x8000;
      }
      // Decode now, schedule later. pumpPlayback enforces the lead cap so a
      // burst of chunks can't desync perceived playback from server turn state.
      pendingChunksRef.current.push(audioBuffer);
      pumpPlayback();
    },
    [pumpPlayback],
  );

  const handleToolCall = useCallback(async (calls: LiveFunctionCall[]) => {
    const session = sessionRef.current;
    if (!session) return;
    const handler = onToolCallRef.current;

    let responses: LiveToolResponse[];
    if (handler) {
      try {
        responses = await handler(calls);
      } catch (err) {
        console.error("[gemini-live-voice] onToolCall threw:", err);
        responses = calls.map((c) => ({
          id: c.id,
          name: c.name,
          response: {
            result: {
              ok: false,
              message: err instanceof Error ? err.message : "Tool failed.",
            },
          },
        }));
      }
    } else {
      // No handler wired but the model called a tool anyway — reply so it
      // doesn't hang waiting on a synchronous response.
      responses = calls.map((c) => ({
        id: c.id,
        name: c.name,
        response: { result: { ok: false, message: "No tool handler." } },
      }));
    }

    try {
      session.sendToolResponse({ functionResponses: responses });
    } catch (err) {
      console.error("[gemini-live-voice] sendToolResponse failed:", err);
    }
  }, []);

  const teardown = useCallback(
    async (reason: SessionEndReason, errMsg?: string) => {
      if (teardownRunningRef.current) return;
      teardownRunningRef.current = true;

      try {
        stopPlayback();

        if (sessionTimerRef.current) {
          clearTimeout(sessionTimerRef.current);
          sessionTimerRef.current = null;
        }

        try {
          inputProcessorRef.current?.disconnect();
          inputSourceRef.current?.disconnect();
        } catch {
          // Disconnect throws if already disconnected — fine.
        }
        inputProcessorRef.current = null;
        inputSourceRef.current = null;

        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;

        try {
          await inputCtxRef.current?.close();
        } catch {
          // Close throws if already closed — fine.
        }
        try {
          await outputCtxRef.current?.close();
        } catch {
          // Same.
        }
        inputCtxRef.current = null;
        outputCtxRef.current = null;

        const hadSession = sessionRef.current !== null;
        try {
          sessionRef.current?.close();
        } catch (err) {
          console.warn("[gemini-live-voice] session.close threw:", err);
        }
        sessionRef.current = null;

        if (hadSession || sessionStartedAtRef.current) {
          onSessionEndRef.current?.({
            reason,
            durationMs: sessionStartedAtRef.current
              ? Date.now() - sessionStartedAtRef.current
              : 0,
            inputAudioTokens: tokenUsageRef.current.input,
            outputAudioTokens: tokenUsageRef.current.output,
            resumeHandle: resumeHandleRef.current,
            errorMessage: errMsg,
          });
        }

        sessionStartedAtRef.current = 0;
        resumeHandleRef.current = null;
        tokenUsageRef.current = { input: 0, output: 0 };
        setState(reason === "error" ? "error" : "idle");
        if (errMsg) setErrorMessage(errMsg);
      } finally {
        teardownRunningRef.current = false;
      }
    },
    [stopPlayback],
  );

  const startMicStreaming = useCallback(
    async (session: Session) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // echoCancellation is what stops the mic from hearing the bot's own
          // voice through the speakers and self-interrupting. Keep it on.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      log("mic track settings:", track?.getSettings?.() ?? "(unavailable)");

      // AudioContext locked to 16kHz so the MediaStreamSource resamples for us
      // — saves writing a resampler.
      const ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
      inputCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      inputSourceRef.current = source;
      // ScriptProcessorNode is deprecated but still universally supported and
      // dramatically simpler than an AudioWorklet for ~30 lines of PCM
      // conversion. Swap to a worklet if a browser ever drops it.
      const processor = ctx.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
      inputProcessorRef.current = processor;
      let micProcessCount = 0;
      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        micProcessCount += 1;
        if (debugRef.current && micProcessCount % 50 === 1) {
          let peak = 0;
          for (let i = 0; i < float32.length; i++) {
            const a = Math.abs(float32[i] ?? 0);
            if (a > peak) peak = a;
          }
          log(`mic buffer #${micProcessCount}, peak=${peak.toFixed(3)}`);
        }
        const int16 = float32ToInt16(float32);
        const base64 = arrayBufferToBase64(int16.buffer);
        try {
          session.sendRealtimeInput({
            audio: {
              data: base64,
              mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            },
          });
        } catch (err) {
          console.warn("[gemini-live-voice] sendRealtimeInput threw:", err);
        }
      };
      source.connect(processor);
      // A ScriptProcessor only fires onaudioprocess while connected to the
      // graph's destination — but we don't want to hear our own mic. Route it
      // through a 0-gain node to satisfy the graph while staying silent.
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      processor.connect(muteGain);
      muteGain.connect(ctx.destination);
    },
    [log],
  );

  const connect = useCallback(async () => {
    setErrorMessage(null);
    setState("connecting");

    let mint: MintResult;
    try {
      mint = await mintTokenRef.current();
    } catch (err) {
      console.error("[gemini-live-voice] mintToken failed:", err);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't start voice mode.";
      setErrorMessage(msg);
      setState("error");
      return;
    }

    sessionStartedAtRef.current = Date.now();
    outputCtxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    playbackNextStartRef.current = 0;
    chunkCountRef.current = 0;
    interruptCountRef.current = 0;

    // Hard session timer — the Live API closes the connection at ~15min anyway,
    // but tearing down ourselves first lets us report a clean reason and stops
    // the mic immediately.
    const maxMinutes = mint.maxSessionMinutes ?? 15;
    sessionTimerRef.current = setTimeout(
      () => {
        void teardown("timeout");
      },
      maxMinutes * 60 * 1000,
    );

    // `apiVersion: "v1alpha"` is mandatory when authenticating with an
    // ephemeral token — the SDK warns on stderr otherwise and live.connect
    // expects the alpha endpoint shape.
    const client = new GoogleGenAI({
      apiKey: mint.liveToken,
      httpOptions: { apiVersion: "v1alpha" },
    });

    let session: Session;
    try {
      session = await client.live.connect({
        model: mint.model,
        config: {
          // The ephemeral token's liveConnectConstraints fully define the
          // session config. The client config here must be a SUBSET —
          // repeating the modality is the safest way to confirm the WS opens.
          responseModalities: [Modality.AUDIO],
        },
        callbacks: {
          onopen: () => {
            log(`WS open: model=${mint.model}`);
            setState("listening");
          },
          onmessage: (msg) => {
            // One server event can carry multiple parts — process all.
            const sc = msg.serverContent;
            if (sc?.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.inlineData?.data) {
                  chunkCountRef.current += 1;
                  if (debugRef.current && chunkCountRef.current % 10 === 1) {
                    const queuedSec = Math.max(
                      0,
                      playbackNextStartRef.current -
                        (outputCtxRef.current?.currentTime ?? 0),
                    );
                    log(
                      `audio chunk #${chunkCountRef.current}, queue=${queuedSec.toFixed(2)}s, active=${activeSourcesRef.current.size}`,
                    );
                  }
                  setState("speaking");
                  playAudioChunk(part.inlineData.data);
                }
              }
            }
            if (sc?.inputTranscription?.text) {
              const text = sc.inputTranscription.text;
              setTranscripts((prev) => [
                ...prev,
                { role: "user", text, atMs: Date.now() },
              ]);
            }
            if (sc?.outputTranscription?.text) {
              const text = sc.outputTranscription.text;
              setTranscripts((prev) => [
                ...prev,
                { role: "assistant", text, atMs: Date.now() },
              ]);
            }
            if (sc?.interrupted) {
              interruptCountRef.current += 1;
              log(
                `*** INTERRUPTED #${interruptCountRef.current} *** (server detected user speech)`,
              );
              stopPlayback();
              setState("listening");
            }
            if (sc?.turnComplete) {
              log("turnComplete");
              if (sessionRef.current) setState("listening");
            }
            if (msg.toolCall?.functionCalls) {
              log(
                `toolCall(s): ${msg.toolCall.functionCalls
                  .map((c) => c.name)
                  .join(", ")}`,
              );
              void handleToolCall(
                msg.toolCall.functionCalls as LiveFunctionCall[],
              );
            }
            const resumption = msg.sessionResumptionUpdate;
            if (resumption?.resumable && resumption.newHandle) {
              resumeHandleRef.current = resumption.newHandle;
            }
            if (msg.goAway) {
              log("goAway received — server closing");
              void teardown("timeout");
            }
            // usageMetadata field names vary by SDK version — try common shapes.
            type UsageWithCounts = {
              promptTokenCount?: number;
              responseTokenCount?: number;
              inputAudioTokenCount?: number;
              outputAudioTokenCount?: number;
            };
            const usage = (msg as { usageMetadata?: UsageWithCounts })
              .usageMetadata;
            if (usage) {
              const inDelta =
                usage.inputAudioTokenCount ?? usage.promptTokenCount ?? 0;
              const outDelta =
                usage.outputAudioTokenCount ?? usage.responseTokenCount ?? 0;
              if (inDelta) tokenUsageRef.current.input += inDelta;
              if (outDelta) tokenUsageRef.current.output += outDelta;
            }
          },
          onerror: (err) => {
            console.error("[gemini-live-voice] WS error:", err);
            void teardown("error", "Voice connection error.");
          },
          onclose: () => {
            log("WS closed");
            // onclose fires on user-initiated teardown too — only act if the
            // session wasn't already cleaned up by teardown().
            if (sessionRef.current) {
              void teardown("client_closed");
            }
          },
        },
      });
    } catch (err) {
      console.error("[gemini-live-voice] live.connect failed:", err);
      await teardown("error", "Couldn't open voice connection.");
      return;
    }

    sessionRef.current = session;

    // Prompt the model to speak first. Gemini Live never opens a turn on its
    // own — `onopen` only means the socket is up. Sending a one-shot cue gives
    // the user immediate audio confirmation the session is live AND warms up
    // the playback pipeline, so their first real turn has no perceived lag.
    const greetingCue = greetingRef.current;
    if (greetingCue) {
      try {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: greetingCue }] }],
          turnComplete: true,
        });
      } catch (err) {
        // Non-fatal — the session still works, the user just speaks first.
        console.warn("[gemini-live-voice] greeting trigger failed:", err);
      }
    }

    try {
      await startMicStreaming(session);
    } catch (err) {
      console.error(
        "[gemini-live-voice] getUserMedia / mic stream failed:",
        err,
      );
      await teardown(
        "error",
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : "Couldn't start the microphone.",
      );
    }
  }, [
    handleToolCall,
    log,
    playAudioChunk,
    startMicStreaming,
    stopPlayback,
    teardown,
  ]);

  // Drive connect / teardown off `enabled`. One useEffect owns the lifecycle so
  // toggling enabled rapidly can't leak two parallel sessions.
  useEffect(() => {
    if (enabled && state === "idle") {
      void connect();
    } else if (!enabled && state !== "idle" && state !== "error") {
      void teardown("user_ended");
    }
    // React to `enabled` flips only, not `state` self-transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (sessionRef.current || mediaStreamRef.current) {
        void teardown("client_closed");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(
    () => ({ state, errorMessage, transcripts }),
    [state, errorMessage, transcripts],
  );
}
