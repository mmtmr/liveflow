import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilesetResolver, GestureRecognizer, DrawingUtils } from "@mediapipe/tasks-vision";
import mermaidScriptUrl from "mermaid/dist/mermaid.min.js?url";

const AUTO_INTERVAL_MS = 6200;
const FRAME_ANALYSIS_INTERVAL_MS = 3200;
const MAX_PARALLEL_GENERATIONS = 3;
const MAX_EVENTS = 10;
const MAX_STROKES = 8;
const MAX_VISUAL_HISTORY = 5;
const RECENT_TRANSCRIPT_WORDS = 160;
const VOICE_CONNECT_TIMEOUT_MS = 15000;
const VOICE_RECONNECT_DELAY_MS = 900;
const MAX_VOICE_RECONNECTS = 2;
const HAND_TRACE_COLORS = ["#ffcf5a", "#61dafb"];
const VOICE_LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" }
];
const IMAGE_PROVIDER_OPTIONS = [
  { value: "fal", label: "Flux" },
  { value: "openai", label: "GPT Image 2" },
  { value: "mermaid", label: "Mermaid" }
];
const DEFAULT_IMAGE_PROVIDERS = ["openai", "mermaid"];
const APP_VERSION_LABEL = `v${__APP_VERSION__}${__APP_COMMIT__ ? ` · ${__APP_COMMIT__}` : ""}`;

const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true
  },
  themeVariables: {
    background: "#f6f0dc",
    primaryColor: "#f6f0dc",
    primaryTextColor: "#172129",
    primaryBorderColor: "#2f7190",
    lineColor: "#31414a",
    secondaryColor: "#e8f1ee",
    tertiaryColor: "#f7df9c",
    fontFamily: "Inter, Arial, sans-serif"
  }
};

let mermaidRuntime = null;
let mermaidLoadPromise = null;

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function getVoiceLanguageOption(value) {
  return VOICE_LANGUAGE_OPTIONS.find((option) => option.value === value) || VOICE_LANGUAGE_OPTIONS[0];
}

function formatLatency(ms) {
  if (!Number.isFinite(ms)) return "waiting";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function summarizeStroke(points, handLabel) {
  if (points.length < 2) return { points: points.length, direction: "tap" };
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const direction = horizontal ? (dx > 0 ? "left to right" : "right to left") : dy > 0 ? "top to bottom" : "bottom to top";
  return { hand: handLabel, points: points.length, direction };
}

function summarizeLiveStrokes(strokeSets) {
  return strokeSets
    .map((points, handIndex) => ({ points, handLabel: `Hand ${handIndex + 1}` }))
    .filter(({ points }) => points.length > 1)
    .map(({ points, handLabel }) => summarizeStroke(points, handLabel));
}

function shortText(value, fallback = "Live lesson context", limit = 92) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function recentWords(value, limit = RECENT_TRANSCRIPT_WORDS) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(-limit).join(" ");
}

function newestFirstTranscript(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .join("\n");
}

function chronologicalTranscript(value) {
  return newestFirstTranscript(value);
}

function captureCanvasFrame(canvas, maxWidth = 640, quality = 0.72) {
  if (!canvas || !canvas.width || !canvas.height) return null;

  const scale = Math.min(1, maxWidth / canvas.width);
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(canvas.width * scale));
  preview.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = preview.getContext("2d");
  ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
  return preview.toDataURL("image/jpeg", quality);
}

async function renderMermaidImage(code, generationId) {
  if (!mermaidRuntime) {
    if (!mermaidLoadPromise) {
      mermaidLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = mermaidScriptUrl;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Mermaid renderer did not load."));
        document.head.appendChild(script);
      });
    }
    await mermaidLoadPromise;
    mermaidRuntime = globalThis.mermaid;
    if (!mermaidRuntime) {
      throw new Error("Mermaid renderer did not load.");
    }
    mermaidRuntime.initialize(MERMAID_CONFIG);
  }

  const renderId = `mermaid-${generationId}-${Date.now()}`;
  const { svg } = await mermaidRuntime.render(renderId, code);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildVisualBrief({ transcript, recentTranscript, gestures, strokes, mode, visualAnalysis }) {
  const latestGesture = gestures?.at?.(-1)?.label;
  const latestStroke = strokes?.at?.(-1);
  const parts = [
    mode ? `${mode} visual` : "diagram visual",
    recentTranscript || transcript ? shortText(recentTranscript || transcript, "", 118) : "",
    visualAnalysis ? shortText(visualAnalysis, "", 118) : "",
    latestGesture ? `gesture: ${latestGesture}` : "",
    latestStroke ? `trace: ${latestStroke.hand || "hand"} ${latestStroke.direction}` : ""
  ].filter(Boolean);

  return parts.join(" | ") || "Build a clear visual cue for the current live lesson.";
}

function makeInstantPreview({ transcript, recentTranscript, gestures, strokes, mode, visualAnalysis, generationId }) {
  const title = mode === "steps" ? "Next teaching step" : mode === "metaphor" ? "Live visual metaphor" : "Live diagram sketch";
  const topic = shortText(recentTranscript || transcript || visualAnalysis, "Listening for lesson context", 72);
  const cue = shortText(visualAnalysis, gestures?.at?.(-1)?.label || "Watching hands and board", 86);
  const trace = strokes?.at?.(-1)?.direction || "trace will shape the next image";
  const accent = mode === "metaphor" ? "#78d6a3" : mode === "steps" ? "#61dafb" : "#f1c45a";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0b1116"/>
          <stop offset="1" stop-color="#172129"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="url(#bg)"/>
      <rect x="76" y="76" width="872" height="872" rx="38" fill="#f6f0dc"/>
      <path d="M170 654 C272 520 368 604 474 452 S676 318 838 252" fill="none" stroke="${accent}" stroke-width="30" stroke-linecap="round"/>
      <path d="M210 732 H810" stroke="#24313a" stroke-width="18" stroke-linecap="round" opacity="0.28"/>
      <circle cx="232" cy="628" r="48" fill="#d65f4b"/>
      <circle cx="510" cy="424" r="58" fill="#2f7190"/>
      <circle cx="804" cy="262" r="50" fill="#4e9f86"/>
      <text x="132" y="174" font-family="Inter, Arial, sans-serif" font-size="52" font-weight="850" fill="#172129">${escapeSvgText(title)}</text>
      <text x="132" y="252" font-family="Inter, Arial, sans-serif" font-size="34" fill="#24313a">${escapeSvgText(topic)}</text>
      <rect x="132" y="760" width="760" height="62" rx="18" fill="#172129"/>
      <text x="164" y="801" font-family="Inter, Arial, sans-serif" font-size="28" fill="#f6f0dc">${escapeSvgText(cue)}</text>
      <rect x="132" y="842" width="760" height="58" rx="16" fill="#31414a"/>
      <text x="164" y="880" font-family="Inter, Arial, sans-serif" font-size="26" fill="#f6f0dc">${escapeSvgText(trace)}</text>
      <text x="764" y="154" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="800" fill="#6a7479">V2.${generationId}</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${window.btoa(unescape(encodeURIComponent(svg)))}`;
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

async function readApiPayload(response) {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: text.slice(0, 500)
    };
  }
}

function getPayloadError(payload, fallback) {
  if (typeof payload?.error === "string") return payload.error;
  return payload?.error?.message || payload?.message || fallback;
}

function getRealtimeTranscript(event) {
  if (typeof event?.transcript === "string") return event.transcript;
  if (typeof event?.text === "string") return event.text;

  const content = event?.item?.content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => part?.transcript || part?.text || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function useRealtimeVoice(apiFetch = fetch) {
  const peerRef = useRef(null);
  const dataChannelRef = useRef(null);
  const micStreamRef = useRef(null);
  const reconnectTimerRef = useRef(0);
  const maxSessionTimerRef = useRef(0);
  const startingRef = useRef(false);
  const shouldListenRef = useRef(false);
  const sessionRef = useRef(0);
  const languageRef = useRef(VOICE_LANGUAGE_OPTIONS[0].value);
  const reconnectAttemptsRef = useRef(0);
  const [supported] = useState(() => Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia));
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceError, setVoiceError] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");

  const transcript = [finalTranscript, partialTranscript].filter(Boolean).join("\n").trim();
  const speechContext = [partialTranscript, newestFirstTranscript(finalTranscript)].filter(Boolean).join("\n").trim();

  const setTranscript = useCallback((value) => {
    setFinalTranscript(value);
    setPartialTranscript("");
  }, []);

  const setSpeechContext = useCallback((value) => {
    setFinalTranscript(chronologicalTranscript(value));
    setPartialTranscript("");
  }, []);

  const stopConnection = useCallback(({ resetStatus = true } = {}) => {
    window.clearTimeout(reconnectTimerRef.current);
    window.clearTimeout(maxSessionTimerRef.current);
    reconnectTimerRef.current = 0;
    maxSessionTimerRef.current = 0;
    shouldListenRef.current = false;
    reconnectAttemptsRef.current = 0;
    sessionRef.current += 1;

    if (dataChannelRef.current) {
      dataChannelRef.current.onopen = null;
      dataChannelRef.current.onmessage = null;
      dataChannelRef.current.onerror = null;
      dataChannelRef.current.onclose = null;
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    peerRef.current?.close();
    peerRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setListening(false);
    if (resetStatus) setVoiceStatus("idle");
  }, []);

  const stop = useCallback(() => {
    stopConnection({ resetStatus: true });
  }, [stopConnection]);

  const commitTranscript = useCallback((text) => {
    const nextTranscript = String(text || "").replace(/\s+/g, " ").trim();
    if (!nextTranscript) return;
    setFinalTranscript((value) => [value, nextTranscript].filter(Boolean).join("\n").trim());
    setPartialTranscript("");
  }, []);

  const handleRealtimeEvent = useCallback((event, sessionId) => {
    if (sessionId !== sessionRef.current) return;

    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      setPartialTranscript((value) => `${value}${event.delta}`);
      setVoiceStatus("transcribing");
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      commitTranscript(getRealtimeTranscript(event));
      setVoiceStatus("listening");
    }

    if (event.type === "conversation.item.input_audio_transcription.failed") {
      setPartialTranscript("");
      setVoiceStatus("listening");
      setVoiceError(event.error?.message || "Speech segment could not be transcribed. Listening continues.");
    }

    if (event.type === "input_audio_buffer.speech_started") {
      setVoiceStatus("hearing speech");
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      setVoiceStatus("processing speech");
    }
  }, [commitTranscript]);

  const start = useCallback(async (language = VOICE_LANGUAGE_OPTIONS[0].value) => {
    if (startingRef.current || peerRef.current) return;
    const selectedLanguage = getVoiceLanguageOption(language).value;
    const sessionId = sessionRef.current + 1;
    sessionRef.current = sessionId;
    shouldListenRef.current = true;
    languageRef.current = selectedLanguage;
    startingRef.current = true;
    setVoiceError("");
    setVoiceStatus("connecting");

    const scheduleReconnect = () => {
      if (!shouldListenRef.current || sessionId !== sessionRef.current) return;
      if (reconnectTimerRef.current) return;
      if (reconnectAttemptsRef.current >= MAX_VOICE_RECONNECTS) {
        stopConnection({ resetStatus: false });
        setVoiceStatus("error");
        setVoiceError("Realtime speech connection dropped. Please start live again.");
        return;
      }

      reconnectAttemptsRef.current += 1;
      setVoiceStatus("reconnecting");
      if (dataChannelRef.current) {
        dataChannelRef.current.onopen = null;
        dataChannelRef.current.onmessage = null;
        dataChannelRef.current.onerror = null;
        dataChannelRef.current.onclose = null;
        dataChannelRef.current.close();
        dataChannelRef.current = null;
      }
      peerRef.current?.close();
      peerRef.current = null;
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;

      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = 0;
        start(languageRef.current);
      }, VOICE_RECONNECT_DELAY_MS);
    };

    try {
      const tokenResponse = await apiFetch("/api/realtime-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: selectedLanguage })
      });
      const tokenPayload = await readApiPayload(tokenResponse);
      if (!tokenResponse.ok || !tokenPayload.value) {
        throw new Error(getPayloadError(tokenPayload, "Could not create a Realtime session token."));
      }
      if (Number.isFinite(Number(tokenPayload.maxSessionMinutes)) && Number(tokenPayload.maxSessionMinutes) > 0) {
        window.clearTimeout(maxSessionTimerRef.current);
        maxSessionTimerRef.current = window.setTimeout(() => {
          if (sessionId !== sessionRef.current) return;
          stopConnection({ resetStatus: false });
          setVoiceStatus("session expired");
          setVoiceError("Realtime session reached the beta time limit. Start live again to renew within quota.");
        }, Number(tokenPayload.maxSessionMinutes) * 60 * 1000);
      }

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      peer.onconnectionstatechange = () => {
        if (sessionId !== sessionRef.current) return;
        if (peer.connectionState === "connected") {
          reconnectAttemptsRef.current = 0;
          setListening(true);
          setVoiceStatus("listening");
        }
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          scheduleReconnect();
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (sessionId !== sessionRef.current) return;
        if (["failed", "disconnected"].includes(peer.iceConnectionState)) {
          scheduleReconnect();
        }
      };

      const dataChannel = peer.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onopen = () => {
        if (sessionId !== sessionRef.current) return;
        setVoiceStatus("listening");
      };
      dataChannel.onmessage = (message) => {
        if (sessionId !== sessionRef.current) return;
        try {
          handleRealtimeEvent(JSON.parse(message.data), sessionId);
        } catch {
          setVoiceStatus("received unreadable event");
        }
      };
      dataChannel.onerror = () => {
        if (sessionId === sessionRef.current) scheduleReconnect();
      };
      dataChannel.onclose = () => {
        if (shouldListenRef.current && sessionId === sessionRef.current) scheduleReconnect();
      };

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      micStreamRef.current = micStream;
      const [micTrack] = micStream.getAudioTracks();
      if (!micTrack) {
        throw new Error("No microphone input track was available.");
      }
      micTrack.onended = () => {
        if (sessionId === sessionRef.current) {
          stopConnection({ resetStatus: false });
          setVoiceStatus("error");
          setVoiceError("Microphone input stopped. Please start live again.");
        }
      };
      peer.addTrack(micTrack, micStream);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const answerResponse = await withTimeout(
        fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${tokenPayload.value}`,
            "Content-Type": "application/sdp"
          }
        }),
        VOICE_CONNECT_TIMEOUT_MS,
        "Realtime connection timed out."
      );

      const answerText = await withTimeout(answerResponse.text(), VOICE_CONNECT_TIMEOUT_MS, "Realtime connection timed out.");
      if (!answerResponse.ok) {
        throw new Error(answerText);
      }

      await peer.setRemoteDescription({
        type: "answer",
        sdp: answerText
      });

      setListening(true);
      setVoiceStatus("listening");
    } catch (error) {
      stopConnection({ resetStatus: false });
      setVoiceStatus("error");
      setVoiceError(error instanceof Error ? error.message : "Realtime voice failed.");
    } finally {
      startingRef.current = false;
    }
  }, [apiFetch, handleRealtimeEvent, stopConnection]);

  useEffect(() => stopConnection, [stopConnection]);

  return { supported, listening, transcript, speechContext, setTranscript, setSpeechContext, start, stop, voiceStatus, voiceError };
}

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const recognizerRef = useRef(null);
  const rafRef = useRef(0);
  const strokeRef = useRef([[], []]);
  const lastGenerationRef = useRef(0);
  const lastAnalysisRef = useRef(0);
  const analyzingRef = useRef(false);
  const imageRef = useRef(null);
  const generationSerialRef = useRef(0);
  const displayedGenerationRef = useRef(0);
  const inFlightGenerationCountRef = useRef(0);
  const overlaySideRef = useRef("right");
  const lastOverlayMoveRef = useRef(0);
  const lastHandMetaRef = useRef(0);
  const lastContextFingerprintRef = useRef("");
  const contextEpochRef = useRef(0);

  const [betaStatus, setBetaStatus] = useState({
    loading: true,
    authenticated: false,
    csrfToken: "",
    expiresAt: "",
    reportContact: "",
    enabledImageProviders: DEFAULT_IMAGE_PROVIDERS
  });
  const [accessCode, setAccessCode] = useState("");
  const [accessError, setAccessError] = useState("");
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const betaReady = betaStatus.authenticated && privacyAccepted;
  const betaReportContact = betaStatus.reportContact || "Set PUBLIC_BETA_REPORT_CONTACT before public beta";
  const apiFetch = useCallback((url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (betaStatus.csrfToken) {
      headers.set("X-CSRF-Token", betaStatus.csrfToken);
    }
    return fetch(url, {
      ...options,
      credentials: "include",
      headers
    });
  }, [betaStatus.csrfToken]);

  const { supported, listening, transcript, speechContext, setTranscript, setSpeechContext, start, stop, voiceStatus, voiceError } = useRealtimeVoice(apiFetch);
  const [cameraOn, setCameraOn] = useState(false);
  const [trackingState, setTrackingState] = useState("idle");
  const [gestureEvents, setGestureEvents] = useState([]);
  const [strokes, setStrokes] = useState([]);
  const [isDrawing, setIsDrawing] = useState(true);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [imageProvider, setImageProvider] = useState("openai");
  const [mode, setMode] = useState("diagram");
  const [status, setStatus] = useState("Ready");
  const [image, setImage] = useState(null);
  const [instantPreview, setInstantPreview] = useState(null);
  const [pendingGenerations, setPendingGenerations] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState([]);
  const [visualAnalysis, setVisualAnalysis] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("waiting for camera");
  const [visualHistory, setVisualHistory] = useState([]);
  const [generationQueue, setGenerationQueue] = useState([]);
  const [generationMetrics, setGenerationMetrics] = useState(null);
  const [currentBrief, setCurrentBrief] = useState("");
  const [visualLocked, setVisualLocked] = useState(false);
  const [overlayHidden, setOverlayHidden] = useState(false);
  const [overlayExpanded, setOverlayExpanded] = useState(false);
  const [overlaySide, setOverlaySide] = useState("right");
  const [handActivity, setHandActivity] = useState("waiting for hands");
  const [voiceLanguage, setVoiceLanguage] = useState(VOICE_LANGUAGE_OPTIONS[0].value);

  const voiceLanguageLabel = getVoiceLanguageOption(voiceLanguage).label;
  const enabledProviderOptions = useMemo(() => {
    const enabled = new Set(betaStatus.enabledImageProviders || DEFAULT_IMAGE_PROVIDERS);
    const options = IMAGE_PROVIDER_OPTIONS.filter((option) => enabled.has(option.value));
    return options.length ? options : IMAGE_PROVIDER_OPTIONS.filter((option) => DEFAULT_IMAGE_PROVIDERS.includes(option.value));
  }, [betaStatus.enabledImageProviders]);

  useEffect(() => {
    if (!enabledProviderOptions.some((option) => option.value === imageProvider)) {
      setImageProvider(enabledProviderOptions[0]?.value || "openai");
    }
  }, [enabledProviderOptions, imageProvider]);

  const logDiagnostic = useCallback((message) => {
    setDiagnostics((items) => [`${nowTime()} ${message}`, ...items].slice(0, 6));
  }, []);

  const refreshBetaSession = useCallback(async () => {
    try {
      const response = await fetch("/api/beta/session", { credentials: "include" });
      const payload = await readApiPayload(response);
      if (!response.ok) throw new Error(getPayloadError(payload, "Could not read beta session."));
      setBetaStatus({
        loading: false,
        authenticated: Boolean(payload.authenticated),
        csrfToken: payload.csrfToken || "",
        expiresAt: payload.expiresAt || "",
        reportContact: payload.reportContact || "",
        enabledImageProviders: payload.enabledImageProviders || DEFAULT_IMAGE_PROVIDERS
      });
    } catch (sessionError) {
      setBetaStatus((value) => ({ ...value, loading: false, authenticated: false, csrfToken: "" }));
      setAccessError(sessionError instanceof Error ? sessionError.message : "Could not read beta session.");
    }
  }, []);

  useEffect(() => {
    refreshBetaSession();
  }, [refreshBetaSession]);

  const submitBetaAccess = useCallback(async (event) => {
    event.preventDefault();
    setAccessError("");
    try {
      const response = await fetch("/api/beta/access", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: accessCode })
      });
      const payload = await readApiPayload(response);
      if (!response.ok) throw new Error(getPayloadError(payload, "Beta access failed."));
      setBetaStatus((value) => ({
        ...value,
        loading: false,
        authenticated: true,
        csrfToken: payload.csrfToken || "",
        expiresAt: payload.expiresAt || value.expiresAt,
        enabledImageProviders: payload.enabledImageProviders || value.enabledImageProviders || DEFAULT_IMAGE_PROVIDERS
      }));
      setAccessCode("");
      setStatus("Beta access active");
    } catch (accessFailure) {
      setAccessError(accessFailure instanceof Error ? accessFailure.message : "Beta access failed.");
    }
  }, [accessCode]);

  const latestContext = useMemo(
    () => ({
      transcript,
      recentTranscript: recentWords(transcript),
      gestures: gestureEvents,
      strokes,
      mode,
      imageProvider,
      visualAnalysis,
      previousBrief: currentBrief,
      visualHistory: visualHistory.slice(0, 3).map(({ brief, time, mode: visualMode }) => ({ brief, time, mode: visualMode }))
    }),
    [currentBrief, gestureEvents, imageProvider, mode, strokes, transcript, visualAnalysis, visualHistory]
  );

  const contextFingerprint = useMemo(
    () => [
      transcript.slice(-240),
      visualAnalysis.slice(-220),
      gestureEvents.slice(-3).map((item) => item.label).join(","),
      strokes.slice(-3).map((stroke) => `${stroke.hand || "hand"}:${stroke.direction}`).join(","),
      mode
    ].join("|"),
    [gestureEvents, mode, strokes, transcript, visualAnalysis]
  );

  const addGesture = useCallback((label, score) => {
    if (!label || label === "None") return;
    setGestureEvents((events) => {
      const previous = events[events.length - 1];
      if (previous?.label === label && Date.now() - previous.rawTime < 1600) return events;
      return [
        ...events.slice(-(MAX_EVENTS - 1)),
        {
          label,
          score: Number(score || 0).toFixed(2),
          time: nowTime(),
          rawTime: Date.now()
        }
      ];
    });
  }, []);

  const updateImage = useCallback((nextImage) => {
    imageRef.current = nextImage;
    setImage(nextImage);
  }, []);

  const generateImage = useCallback(async ({ force = true, reason = "manual" } = {}) => {
    if (!betaReady) {
      setStatus("Beta access and privacy consent required");
      return;
    }

    if (visualLocked && !force) {
      setStatus("Visual locked");
      return;
    }

    if (inFlightGenerationCountRef.current >= MAX_PARALLEL_GENERATIONS) {
      setStatus(`Already generating ${MAX_PARALLEL_GENERATIONS} visuals`);
      return;
    }

    const generationId = generationSerialRef.current + 1;
    const contextEpoch = contextEpochRef.current;
    generationSerialRef.current = generationId;
    inFlightGenerationCountRef.current += 1;
    setPendingGenerations(inFlightGenerationCountRef.current);
    setError("");
    lastGenerationRef.current = Date.now();

    const liveStrokes = summarizeLiveStrokes(strokeRef.current);
    const requestContext = {
      ...latestContext,
      strokes: [...latestContext.strokes, ...liveStrokes].slice(-MAX_STROKES),
      frame: captureCanvasFrame(canvasRef.current, 560, 0.68)
    };
    const brief = buildVisualBrief(requestContext);
    const preview = makeInstantPreview({ ...requestContext, generationId });

    setCurrentBrief(brief);
    setInstantPreview(preview);
    setGenerationQueue((items) => [
      { id: generationId, reason, brief, time: nowTime(), status: "running" },
      ...items
    ].slice(0, 4));
    setStatus(imageRef.current ? `Updating in background (${inFlightGenerationCountRef.current})` : "Instant sketch ready, generating polished visual...");

    try {
      const response = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestContext)
      });
      const payload = await readApiPayload(response);
      if (!response.ok) throw new Error(getPayloadError(payload, "Generation failed."));
      const nextImageUrl = payload.diagramType === "mermaid"
        ? await renderMermaidImage(payload.mermaidCode, generationId)
        : payload.imageUrl;

      if (contextEpochRef.current !== contextEpoch) return;

      const shouldReplaceImage = generationId > displayedGenerationRef.current && nextImageUrl && (!payload.fallback || !imageRef.current);
      if (shouldReplaceImage) {
        displayedGenerationRef.current = generationId;
        updateImage(nextImageUrl);
        setVisualHistory((items) => [
          {
            id: generationId,
            imageUrl: nextImageUrl,
            brief,
            mode,
            time: nowTime(),
            fallback: Boolean(payload.fallback),
            diagramType: payload.diagramType,
            mermaidCode: payload.mermaidCode
          },
          ...items
        ].slice(0, MAX_VISUAL_HISTORY));
      }

      setPrompt(payload.prompt);
      setGenerationMetrics({
        provider: payload.provider || "image provider",
        model: payload.model || "unknown model",
        durationMs: payload.durationMs,
        contextDurationMs: payload.contextDurationMs,
        timings: payload.timings
      });
      if (payload.generationAnalysis) {
        setVisualAnalysis(payload.generationAnalysis);
      }
      setError(payload.fallback ? payload.error || "Using demo fallback until image generation is available." : "");
      const contextSuffix = payload.contextDurationMs ? `, context ${formatLatency(payload.contextDurationMs)}` : "";
      setStatus(payload.fallback && imageRef.current
        ? `Kept last visual after ${formatLatency(payload.durationMs)}${contextSuffix} ${nowTime()}`
        : `${payload.fallback ? "Demo fallback" : "Updated"} in ${formatLatency(payload.durationMs)}${contextSuffix} ${nowTime()}`);
      setGenerationQueue((items) => items.map((item) => item.id === generationId ? {
        ...item,
        status: payload.fallback ? "fallback" : "complete",
        latency: formatLatency(payload.durationMs),
        provider: payload.provider,
        model: payload.model
      } : item));
    } catch (generationError) {
      if (contextEpochRef.current !== contextEpoch) return;
      setError(generationError instanceof Error ? generationError.message : "Generation failed.");
      setStatus(imageRef.current ? `Kept last visual ${nowTime()}` : "Generation paused");
      setGenerationQueue((items) => items.map((item) => item.id === generationId ? { ...item, status: "error" } : item));
    } finally {
      inFlightGenerationCountRef.current = Math.max(0, inFlightGenerationCountRef.current - 1);
      setPendingGenerations(inFlightGenerationCountRef.current);
    }
  }, [apiFetch, betaReady, latestContext, mode, updateImage, visualLocked]);

  const captureFrame = useCallback(() => {
    return captureCanvasFrame(canvasRef.current);
  }, []);

  const analyzeCurrentFrame = useCallback(async () => {
    if (analyzingRef.current || !cameraOn) return;
    const frame = captureFrame();
    if (!frame) return;

    analyzingRef.current = true;
    lastAnalysisRef.current = Date.now();
    setAnalysisStatus("analyzing frame");

    try {
      const liveStrokes = summarizeLiveStrokes(strokeRef.current);
      const response = await apiFetch("/api/analyze-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frame,
          transcript,
          recentTranscript: recentWords(transcript),
          gestures: gestureEvents,
          strokes: [...strokes, ...liveStrokes].slice(-MAX_STROKES)
        })
      });
      const payload = await readApiPayload(response);
      if (!response.ok) throw new Error(getPayloadError(payload, "Frame analysis failed."));
      if (payload.fallback) {
        setAnalysisStatus(`analysis unavailable ${nowTime()}`);
        return;
      }
      if (payload.analysis) {
        setVisualAnalysis(payload.analysis);
      }
      setAnalysisStatus(`updated ${nowTime()}`);
      if (autoGenerate && Date.now() - lastGenerationRef.current > 2500) {
        generateImage({ force: false, reason: "vision update" });
      }
    } catch (analysisError) {
      setAnalysisStatus("analysis error");
      setError(analysisError instanceof Error ? analysisError.message : "Frame analysis failed.");
    } finally {
      analyzingRef.current = false;
    }
  }, [apiFetch, autoGenerate, cameraOn, captureFrame, generateImage, gestureEvents, strokes, transcript]);

  const startCamera = useCallback(async () => {
    setError("");
    if (!betaReady) {
      setStatus("Beta access and privacy consent required");
      setTrackingState("idle");
      return;
    }
    setTrackingState("requesting camera");
    logDiagnostic(`secureContext=${window.isSecureContext} mediaDevices=${Boolean(navigator.mediaDevices)}`);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API is unavailable in this browser context. Use https://localhost:5173/ in Chrome or Safari.");
      }

      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false
        }),
        15000,
        "Camera permission did not resolve. If the in-app browser does not show a permission prompt, open http://127.0.0.1:5174/ in Chrome or Safari."
      );
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraOn(true);
      logDiagnostic(`camera stream started: ${stream.getVideoTracks()[0]?.label || "video track active"}`);
      setTrackingState("loading model");

      const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const recognizerOptions = {
        baseOptions: {
          modelAssetPath: "/mediapipe/models/gesture_recognizer.task"
        },
        runningMode: "VIDEO",
        numHands: 2
      };

      try {
        recognizerRef.current = await GestureRecognizer.createFromOptions(vision, {
          ...recognizerOptions,
          baseOptions: {
            ...recognizerOptions.baseOptions,
            delegate: "GPU"
          }
        });
      } catch {
        recognizerRef.current = await GestureRecognizer.createFromOptions(vision, recognizerOptions);
      }

      setTrackingState("tracking");
      logDiagnostic("MediaPipe gesture recognizer loaded");
    } catch (cameraError) {
      setTrackingState("error");
      const message = cameraError instanceof Error ? `${cameraError.name}: ${cameraError.message}` : "Could not start camera or hand tracking.";
      logDiagnostic(message);
      setError(message);
    }
  }, [betaReady, logDiagnostic]);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
    setTrackingState("idle");
  }, []);

  const startLiveSession = useCallback(async () => {
    setError("");
    if (!betaReady) {
      setStatus("Beta access and privacy consent required");
      return;
    }
    setStatus("Starting camera and realtime...");
    await Promise.all([
      startCamera(),
      supported && !listening ? start(voiceLanguage) : Promise.resolve()
    ]);
    setStatus("Live session running");
  }, [betaReady, listening, start, startCamera, supported, voiceLanguage]);

  const stopLiveSession = useCallback(() => {
    stopCamera();
    stop();
    setStatus("Live session stopped");
  }, [stop, stopCamera]);

  const logoutBetaAccess = useCallback(async () => {
    await apiFetch("/api/beta/logout", { method: "POST" });
    stopLiveSession();
    setPrivacyAccepted(false);
    setBetaStatus((value) => ({ ...value, authenticated: false, csrfToken: "", expiresAt: "" }));
    setStatus("Beta access cleared");
  }, [apiFetch, stopLiveSession]);

  const changeVoiceLanguage = useCallback(async (nextLanguage) => {
    if (nextLanguage === voiceLanguage) return;
    const nextLabel = getVoiceLanguageOption(nextLanguage).label;
    setVoiceLanguage(nextLanguage);
    setError("");

    if (listening) {
      stop();
      setStatus(`Restarting voice for ${nextLabel}`);
      await start(nextLanguage);
      setStatus(`Listening for ${nextLabel}`);
      return;
    }

    setStatus(`Listening language set to ${nextLabel}`);
  }, [listening, start, stop, voiceLanguage]);

  useEffect(() => {
    if (!cameraOn) return;

    const drawFrame = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const recognizer = recognizerRef.current;

      if (video && canvas && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const drawingUtils = recognizer ? new DrawingUtils(ctx) : null;
        const result = recognizer ? recognizer.recognizeForVideo(video, performance.now()) : null;
        const landmarks = result?.landmarks || [];

        landmarks.forEach((hand) => {
          drawingUtils.drawConnectors(hand, GestureRecognizer.HAND_CONNECTIONS, {
            color: "rgba(97, 218, 251, 0.75)",
            lineWidth: 3
          });
          drawingUtils.drawLandmarks(hand, {
            color: "rgba(255, 255, 255, 0.9)",
            radius: 3
          });
        });

        const topGestures = (result?.gestures || [])
          .map((handGestures) => handGestures?.[0])
          .filter(Boolean);
        topGestures.forEach((gesture) => addGesture(gesture.categoryName, gesture.score));

        const activeTips = landmarks.map((hand) => hand?.[8]).filter(Boolean);
        if (activeTips.length) {
          const timestamp = Date.now();
          const averageX = activeTips.reduce((sum, point) => sum + point.x, 0) / activeTips.length;
          const displayedAverageX = 1 - averageX;
          const nextSide = displayedAverageX > 0.58 ? "left" : displayedAverageX < 0.42 ? "right" : overlaySideRef.current;
          if (nextSide !== overlaySideRef.current && timestamp - lastOverlayMoveRef.current > 1400) {
            overlaySideRef.current = nextSide;
            lastOverlayMoveRef.current = timestamp;
            setOverlaySide(nextSide);
          }

          if (timestamp - lastHandMetaRef.current > 650) {
            lastHandMetaRef.current = timestamp;
            setHandActivity(`${activeTips.length} hand${activeTips.length > 1 ? "s" : ""} active | overlay ${overlaySideRef.current}`);
          }
        }

        if (isDrawing) {
          strokeRef.current = strokeRef.current.map((points, handIndex) => {
            const indexFinger = landmarks[handIndex]?.[8];
            if (!indexFinger) return points;
            return [...points.slice(-80), { x: indexFinger.x, y: indexFinger.y }];
          });
        }

        strokeRef.current.forEach((points, handIndex) => {
          if (points.length <= 1) return;
          ctx.save();
          ctx.strokeStyle = HAND_TRACE_COLORS[handIndex] || "#ffcf5a";
          ctx.lineWidth = 7;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          points.forEach((point, pointIndex) => {
            const x = point.x * canvas.width;
            const y = point.y * canvas.height;
            if (pointIndex === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
          ctx.restore();
        });
      }

      rafRef.current = requestAnimationFrame(drawFrame);
    };

    rafRef.current = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [addGesture, cameraOn, isDrawing]);

  useEffect(() => {
    if (!autoGenerate || visualLocked) return;
    const timer = window.setInterval(() => {
      const hasContext = transcript.trim().length > 12 || gestureEvents.length > 0 || strokes.length > 0 || visualAnalysis.trim().length > 0;
      const contextChanged = contextFingerprint !== lastContextFingerprintRef.current;
      if (hasContext && contextChanged && Date.now() - lastGenerationRef.current > AUTO_INTERVAL_MS - 1000) {
        lastContextFingerprintRef.current = contextFingerprint;
        generateImage({ force: false, reason: "context changed" });
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [autoGenerate, contextFingerprint, generateImage, gestureEvents.length, strokes.length, transcript, visualAnalysis, visualLocked]);

  useEffect(() => {
    if (!cameraOn || !autoGenerate) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastAnalysisRef.current > FRAME_ANALYSIS_INTERVAL_MS - 500) {
        analyzeCurrentFrame();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [analyzeCurrentFrame, autoGenerate, cameraOn]);

  const commitStroke = () => {
    const committed = strokeRef.current
      .map((points, handIndex) => ({ points, handLabel: `Hand ${handIndex + 1}` }))
      .filter(({ points }) => points.length > 1)
      .map(({ points, handLabel }) => summarizeStroke(points, handLabel));

    if (!committed.length) return;
    setStrokes((items) => [...items, ...committed].slice(-MAX_STROKES));
    strokeRef.current = [[], []];
  };

  const clearContext = useCallback(() => {
    contextEpochRef.current += 1;
    lastContextFingerprintRef.current = "";
    lastGenerationRef.current = 0;
    displayedGenerationRef.current = generationSerialRef.current;
    strokeRef.current = [[], []];
    setStrokes([]);
    setGestureEvents([]);
    setTranscript("");
    setPrompt("");
    setError("");
    setVisualAnalysis("");
    updateImage(null);
    setInstantPreview(null);
    setCurrentBrief("");
    setVisualHistory([]);
    setGenerationQueue([]);
    setGenerationMetrics(null);
    setVisualLocked(false);
    setAnalysisStatus(cameraOn ? "waiting for frame" : "waiting for camera");
    setStatus("Context cleared");
  }, [cameraOn, setTranscript, updateImage]);

  const visualSource = image || instantPreview;
  const visualLabel = image ? "Generated teaching aid" : "Instant teaching sketch";

  return (
    <main className="app-shell">
      <section className="lecture-stage">
        <header className="topbar lecture-topbar">
          <div>
            <h1>LiveFlow</h1>
            <p>Live lesson copilot with adaptive visual memory</p>
          </div>
          <div className={`status-light ${cameraOn ? "live" : ""}`}>
            <span />
            {trackingState}
          </div>
        </header>

        <div className="camera-stage">
          <video ref={videoRef} playsInline muted />
          <canvas ref={canvasRef} />
          {!cameraOn && <div className="camera-empty">Camera preview appears here</div>}
          {!betaReady && (
            <section className="access-gate" role="dialog" aria-labelledby="access-title">
              <div className="access-header">
                <span>Public beta setup</span>
                <h2 id="access-title">Get LiveFlow ready</h2>
                <p>LiveFlow uses your camera, microphone, transcript, prompt, and frame context to generate lesson visuals.</p>
              </div>

              <ol className="access-steps" aria-label="Setup steps">
                <li className={betaStatus.authenticated ? "complete" : "active"}>
                  <span>1</span>
                  <div>
                    <strong>Enter beta</strong>
                    <small>{betaStatus.authenticated ? "Access confirmed" : "Use your invite code"}</small>
                  </div>
                </li>
                <li className={betaStatus.authenticated && !privacyAccepted ? "active" : betaReady ? "complete" : ""}>
                  <span>2</span>
                  <div>
                    <strong>Review consent</strong>
                    <small>Confirm provider processing</small>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Start live</strong>
                    <small>Begin camera and speech capture</small>
                  </div>
                </li>
              </ol>

              {!betaStatus.authenticated && (
                <form onSubmit={submitBetaAccess} className="access-form">
                  <input
                    value={accessCode}
                    onChange={(event) => setAccessCode(event.target.value)}
                    placeholder="Invite code"
                    autoComplete="off"
                  />
                  <button className="primary" type="submit" disabled={betaStatus.loading || !accessCode.trim()}>
                    Enter
                  </button>
                </form>
              )}

              {betaStatus.authenticated && (
                <label className="consent-check">
                  <input type="checkbox" checked={privacyAccepted} onChange={(event) => setPrivacyAccepted(event.target.checked)} />
                  <span>
                    <strong>Allow beta provider processing</strong>
                    <small>I understand lesson context may be sent to configured AI providers while using this beta.</small>
                  </span>
                </label>
              )}

              <div className="access-meta">
                {accessError ? <span className="inline-error">{accessError}</span> : <span>Report issues: {betaReportContact}</span>}
                {betaStatus.authenticated && <button onClick={logoutBetaAccess}>Logout</button>}
              </div>
            </section>
          )}

          {!overlayHidden && (
            <section className={`visual-stage side-${overlaySide} ${overlayExpanded ? "expanded" : ""} ${pendingGenerations ? "is-generating" : ""}`}>
              <div className="visual-header">
                <div>
                  <h2>Generated visual aid</h2>
                  <p>{status}</p>
                </div>
                <div className="visual-actions">
                  <button onClick={() => setVisualLocked((value) => !value)}>{visualLocked ? "Unlock" : "Lock"}</button>
                  <button onClick={() => setOverlayExpanded((value) => !value)}>{overlayExpanded ? "Fit" : "Wide"}</button>
                  <button className="primary" onClick={generateImage} disabled={!betaReady || pendingGenerations >= MAX_PARALLEL_GENERATIONS}>Generate</button>
                </div>
              </div>
              <div className="generated-frame">
                {visualSource ? <img src={visualSource} alt={visualLabel} /> : <div className="image-placeholder">Waiting for the first visual</div>}
                {pendingGenerations > 0 && (
                  <div className="generation-badge">
                    {image ? `Updating ${pendingGenerations}` : "Instant preview"}
                  </div>
                )}
              </div>
              <div className="visual-intel">
                <div>
                  <span>Lesson memory</span>
                  <strong>{currentBrief || "Listening for the next teaching unit"}</strong>
                </div>
                <div>
                  <span>Placement</span>
                  <strong>{handActivity}</strong>
                </div>
                <div>
                  <span>Latency</span>
                  <strong>{generationMetrics ? `${formatLatency(generationMetrics.durationMs)}${generationMetrics.contextDurationMs ? `, context ${formatLatency(generationMetrics.contextDurationMs)}` : ""} - ${generationMetrics.model}` : "waiting for first run"}</strong>
                </div>
              </div>
              <div className="visual-history">
                {visualHistory.length ? visualHistory.map((item) => (
                  <button key={item.id} className="history-thumb" onClick={() => updateImage(item.imageUrl)} title={item.brief}>
                    <img src={item.imageUrl} alt={`Visual from ${item.time}`} />
                    <span>{item.time}</span>
                  </button>
                )) : <span>No saved visual frames yet</span>}
              </div>
            </section>
          )}

          <div className="floating-context">
            <div className="panel analysis-panel">
              <div className="panel-header">
                <h2>Camera vision analysis</h2>
                <span>{analysisStatus}</span>
              </div>
              <pre>{visualAnalysis || "Start live with Auto on to analyze the live frame, board, hands, and traces."}</pre>
            </div>

            <div className="panel transcript-panel">
              <div className="panel-header">
                <h2>Speech context</h2>
                <div className="panel-actions">
                  <div className="segmented language-mode" role="group" aria-label="Speech language">
                    {VOICE_LANGUAGE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        className={voiceLanguage === option.value ? "selected" : ""}
                        onClick={() => changeVoiceLanguage(option.value)}
                        aria-pressed={voiceLanguage === option.value}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <span>{supported ? `${voiceLanguageLabel} · ${voiceStatus}` : "manual"}</span>
                  <button className="panel-action danger" onClick={clearContext} title="Clear speech, visual, gesture, and trace context">
                    Clear context
                  </button>
                </div>
              </div>
              <textarea
                value={speechContext}
                onChange={(event) => setSpeechContext(event.target.value)}
                placeholder={`Start live in ${voiceLanguageLabel}, or type lesson context here...`}
              />
              {voiceError && <div className="inline-error">{voiceError}</div>}
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="lecture-controls" role="toolbar" aria-label="Live teaching controls">
            <div className="dock-group dock-session">
              <button className="dock-primary" onClick={cameraOn || listening ? stopLiveSession : startLiveSession} disabled={!betaReady && !cameraOn && !listening}>
                {cameraOn || listening ? "Stop live" : "Start live"}
              </button>
              <label className="switch">
                <input type="checkbox" checked={autoGenerate} onChange={(event) => setAutoGenerate(event.target.checked)} />
                <span>Auto</span>
              </label>
            </div>

            <div className="dock-group dock-modes">
              <div className="segmented provider-mode">
                {enabledProviderOptions.map((option) => (
                  <button key={option.value} className={imageProvider === option.value ? "selected" : ""} onClick={() => setImageProvider(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="segmented compact">
                {["diagram", "metaphor", "steps"].map((item) => (
                  <button key={item} className={mode === item ? "selected" : ""} onClick={() => setMode(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="dock-group dock-actions">
              <button className={`dock-action ${isDrawing ? "is-active" : ""}`} onClick={() => setIsDrawing((value) => !value)} title={isDrawing ? "Pause trace" : "Resume trace"}>
                Trace
              </button>
              <button className="dock-action" onClick={commitStroke} title="Commit trace">
                Commit
              </button>
              <button className={`dock-action ${!overlayHidden ? "is-active" : ""}`} onClick={() => setOverlayHidden((value) => !value)} title={overlayHidden ? "Show visual" : "Hide visual"}>
                Visual
              </button>
              <button className="dock-action danger" onClick={clearContext} title="Clear context">
                Clear
              </button>
            </div>
          </div>

          <div className="version-hint" aria-label={`LiveFlow version ${APP_VERSION_LABEL}`}>
            {APP_VERSION_LABEL}
          </div>
        </div>
      </section>

      <aside className="debug-drawer">
        <div className="panel two-col">
          <div>
            <h2>Gesture events</h2>
            <ul className="event-list">
              {gestureEvents.length ? gestureEvents.map((event) => (
                <li key={`${event.rawTime}-${event.label}`}>
                  <strong>{event.label}</strong>
                  <span>{event.score} · {event.time}</span>
                </li>
              )) : <li className="muted">No gestures yet</li>}
            </ul>
          </div>
          <div>
            <h2>Trace memory</h2>
            <ul className="event-list">
              {strokes.length ? strokes.map((stroke, index) => (
                <li key={`${stroke.direction}-${index}`}>
                  <strong>{stroke.hand ? `${stroke.hand}: ${stroke.direction}` : stroke.direction}</strong>
                  <span>{stroke.points} points</span>
                </li>
              )) : <li className="muted">Commit a trace to store it</li>}
            </ul>
          </div>
        </div>

        <div className="panel prompt-panel">
          <div className="panel-header">
            <h2>Generation queue</h2>
          </div>
          <pre>{generationQueue.length ? generationQueue.map((item) => `${item.time} #${item.id} ${item.status}${item.latency ? ` ${item.latency}` : ""} ${item.reason}: ${item.brief}`).join("\n") : "Parallel visual updates will appear here."}</pre>
        </div>

        <div className="panel prompt-panel">
          <div className="panel-header">
            <h2>Last visual prompt</h2>
          </div>
          <pre>{prompt || "A generated prompt will appear after the first image request."}</pre>
        </div>

        <div className="panel diagnostics-panel">
          <div className="panel-header">
            <h2>Camera diagnostics</h2>
            <span>{window.isSecureContext ? "secure" : "not secure"}</span>
          </div>
          <pre>{diagnostics.length ? diagnostics.join("\n") : "Click Start live to run diagnostics."}</pre>
        </div>
      </aside>
    </main>
  );
}

export default App;
