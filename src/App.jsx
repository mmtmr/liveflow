import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilesetResolver, GestureRecognizer, DrawingUtils } from "@mediapipe/tasks-vision";

const AUTO_INTERVAL_MS = 8000;
const FRAME_ANALYSIS_INTERVAL_MS = 4000;
const MAX_PARALLEL_GENERATIONS = 3;
const MAX_EVENTS = 10;
const MAX_STROKES = 8;
const HAND_TRACE_COLORS = ["#ffcf5a", "#61dafb"];

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function useRealtimeVoice() {
  const peerRef = useRef(null);
  const micStreamRef = useRef(null);
  const [supported] = useState(() => Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia));
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceError, setVoiceError] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");

  const transcript = [finalTranscript, partialTranscript].filter(Boolean).join(" ").trim();

  const setTranscript = useCallback((value) => {
    setFinalTranscript(value);
    setPartialTranscript("");
  }, []);

  const stop = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setListening(false);
    setVoiceStatus("idle");
  }, []);

  const handleRealtimeEvent = useCallback((event) => {
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      setPartialTranscript((value) => `${value}${event.delta}`);
      setVoiceStatus("transcribing");
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      setFinalTranscript((value) => `${value} ${event.transcript}`.trim());
      setPartialTranscript("");
      setVoiceStatus("listening");
    }

    if (event.type === "input_audio_buffer.speech_started") {
      setVoiceStatus("hearing speech");
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      setVoiceStatus("processing speech");
    }
  }, []);

  const start = useCallback(async () => {
    if (listening) return;
    setVoiceError("");
    setVoiceStatus("connecting");

    try {
      const tokenResponse = await fetch("/api/realtime-token");
      const tokenPayload = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenPayload.value) {
        throw new Error(tokenPayload.error || "Could not create a Realtime session token.");
      }

      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      const dataChannel = peer.createDataChannel("oai-events");
      dataChannel.onopen = () => setVoiceStatus("listening");
      dataChannel.onmessage = (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data));
        } catch {
          setVoiceStatus("received unreadable event");
        }
      };

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      micStreamRef.current = micStream;
      peer.addTrack(micStream.getAudioTracks()[0], micStream);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const answerResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${tokenPayload.value}`,
          "Content-Type": "application/sdp"
        }
      });

      if (!answerResponse.ok) {
        throw new Error(await answerResponse.text());
      }

      await peer.setRemoteDescription({
        type: "answer",
        sdp: await answerResponse.text()
      });

      setListening(true);
      setVoiceStatus("listening");
    } catch (error) {
      stop();
      setVoiceStatus("error");
      setVoiceError(error instanceof Error ? error.message : "Realtime voice failed.");
    }
  }, [handleRealtimeEvent, listening, stop]);

  return { supported, listening, transcript, setTranscript, start, stop, voiceStatus, voiceError };
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

  const { supported, listening, transcript, setTranscript, start, stop, voiceStatus, voiceError } = useRealtimeVoice();
  const [cameraOn, setCameraOn] = useState(false);
  const [trackingState, setTrackingState] = useState("idle");
  const [gestureEvents, setGestureEvents] = useState([]);
  const [strokes, setStrokes] = useState([]);
  const [isDrawing, setIsDrawing] = useState(true);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [mode, setMode] = useState("diagram");
  const [status, setStatus] = useState("Ready");
  const [image, setImage] = useState(null);
  const [pendingGenerations, setPendingGenerations] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState([]);
  const [visualAnalysis, setVisualAnalysis] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("waiting for camera");

  const logDiagnostic = useCallback((message) => {
    setDiagnostics((items) => [`${nowTime()} ${message}`, ...items].slice(0, 6));
  }, []);

  const latestContext = useMemo(
    () => ({
      transcript,
      gestures: gestureEvents,
      strokes,
      mode,
      visualAnalysis
    }),
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

  const generateImage = useCallback(async () => {
    if (inFlightGenerationCountRef.current >= MAX_PARALLEL_GENERATIONS) {
      setStatus(`Already generating ${MAX_PARALLEL_GENERATIONS} visuals`);
      return;
    }

    const generationId = generationSerialRef.current + 1;
    generationSerialRef.current = generationId;
    inFlightGenerationCountRef.current += 1;
    setPendingGenerations(inFlightGenerationCountRef.current);
    setError("");
    setStatus(imageRef.current ? `Updating in background (${inFlightGenerationCountRef.current})` : "Generating first visual...");
    lastGenerationRef.current = Date.now();

    try {
      const liveStrokes = summarizeLiveStrokes(strokeRef.current);
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...latestContext,
          strokes: [...latestContext.strokes, ...liveStrokes].slice(-MAX_STROKES)
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Generation failed.");

      const shouldReplaceImage = generationId > displayedGenerationRef.current && (!payload.fallback || !imageRef.current);
      if (shouldReplaceImage) {
        displayedGenerationRef.current = generationId;
        updateImage(payload.imageUrl);
      }

      setPrompt(payload.prompt);
      setError(payload.fallback ? payload.error || "Using demo fallback until OpenAI generation is available." : "");
      setStatus(payload.fallback && imageRef.current ? `Kept last visual ${nowTime()}` : `${payload.fallback ? "Demo fallback" : "Updated"} ${nowTime()}`);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Generation failed.");
      setStatus(imageRef.current ? `Kept last visual ${nowTime()}` : "Generation paused");
    } finally {
      inFlightGenerationCountRef.current = Math.max(0, inFlightGenerationCountRef.current - 1);
      setPendingGenerations(inFlightGenerationCountRef.current);
    }
  }, [latestContext, updateImage]);

  const captureFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return null;

    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / canvas.width);
    const preview = document.createElement("canvas");
    preview.width = Math.max(1, Math.round(canvas.width * scale));
    preview.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = preview.getContext("2d");
    ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
    return preview.toDataURL("image/jpeg", 0.72);
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
      const response = await fetch("/api/analyze-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frame,
          transcript,
          gestures: gestureEvents,
          strokes: [...strokes, ...liveStrokes].slice(-MAX_STROKES)
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Frame analysis failed.");
      setVisualAnalysis(payload.analysis || "");
      setAnalysisStatus(`updated ${nowTime()}`);
      if (autoGenerate && Date.now() - lastGenerationRef.current > 2500) {
        generateImage();
      }
    } catch (analysisError) {
      setAnalysisStatus("analysis error");
      setError(analysisError instanceof Error ? analysisError.message : "Frame analysis failed.");
    } finally {
      analyzingRef.current = false;
    }
  }, [autoGenerate, cameraOn, captureFrame, generateImage, gestureEvents, strokes, transcript]);

  const startCamera = useCallback(async () => {
    setError("");
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
  }, [logDiagnostic]);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
    setTrackingState("idle");
  }, []);

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

        const topGesture = result?.gestures?.[0]?.[0];
        addGesture(topGesture?.categoryName, topGesture?.score);

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
    if (!autoGenerate) return;
    const timer = window.setInterval(() => {
      const hasContext = transcript.trim().length > 12 || gestureEvents.length > 0 || strokes.length > 0 || visualAnalysis.trim().length > 0;
      if (hasContext && Date.now() - lastGenerationRef.current > AUTO_INTERVAL_MS - 1000) {
        generateImage();
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [autoGenerate, generateImage, gestureEvents.length, strokes.length, transcript, visualAnalysis]);

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

  const clearContext = () => {
    strokeRef.current = [[], []];
    setStrokes([]);
    setGestureEvents([]);
    setTranscript("");
    setPrompt("");
    setError("");
    setVisualAnalysis("");
    setAnalysisStatus(cameraOn ? "waiting for frame" : "waiting for camera");
  };

  return (
    <main className="app-shell">
      <section className="lecture-stage">
        <header className="topbar lecture-topbar">
          <div>
            <h1>Teaching Image Assist</h1>
            <p>Realtime gesture context to generated visual overlay</p>
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

          <section className={`visual-stage ${pendingGenerations ? "is-generating" : ""}`}>
            <div className="visual-header">
              <div>
                <h2>Generated visual aid</h2>
                <p>{status}</p>
              </div>
              <button className="primary" onClick={generateImage} disabled={pendingGenerations >= MAX_PARALLEL_GENERATIONS}>Generate now</button>
            </div>
            <div className="generated-frame">
              {image ? <img src={image} alt="Generated teaching aid" /> : <div className="image-placeholder">Waiting for the first visual</div>}
              {pendingGenerations > 0 && (
                <div className="generation-badge">
                  {image ? `Updating ${pendingGenerations}` : "Generating"}
                </div>
              )}
            </div>
          </section>

          <div className="floating-context">
            <div className="panel analysis-panel">
              <div className="panel-header">
                <h2>Camera vision analysis</h2>
                <span>{analysisStatus}</span>
              </div>
              <pre>{visualAnalysis || "Start camera with Auto on to analyze the live frame, board, hands, and traces."}</pre>
            </div>

            <div className="panel transcript-panel">
              <div className="panel-header">
                <h2>Speech context</h2>
                <span>{supported ? voiceStatus : "manual"}</span>
              </div>
              <textarea
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder="Start realtime, or type lesson context here..."
              />
              {voiceError && <div className="inline-error">{voiceError}</div>}
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="lecture-controls">
            <button onClick={cameraOn ? stopCamera : startCamera}>{cameraOn ? "Stop camera" : "Start camera"}</button>
            <button onClick={listening ? stop : start} disabled={!supported}>
              {listening ? "Stop realtime" : "Start realtime"}
            </button>
            <label className="switch">
              <input type="checkbox" checked={autoGenerate} onChange={(event) => setAutoGenerate(event.target.checked)} />
              <span>Auto</span>
            </label>
            <div className="segmented compact">
              {["diagram", "metaphor", "steps"].map((item) => (
                <button key={item} className={mode === item ? "selected" : ""} onClick={() => setMode(item)}>
                  {item}
                </button>
              ))}
            </div>
            <button onClick={() => setIsDrawing((value) => !value)}>{isDrawing ? "Pause trace" : "Resume trace"}</button>
            <button onClick={commitStroke}>Commit trace</button>
            <button onClick={clearContext}>Clear</button>
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
            <h2>Last visual prompt</h2>
          </div>
          <pre>{prompt || "A generated prompt will appear after the first image request."}</pre>
        </div>

        <div className="panel diagnostics-panel">
          <div className="panel-header">
            <h2>Camera diagnostics</h2>
            <span>{window.isSecureContext ? "secure" : "not secure"}</span>
          </div>
          <pre>{diagnostics.length ? diagnostics.join("\n") : "Click Start camera to run diagnostics."}</pre>
        </div>
      </aside>
    </main>
  );
}

export default App;
