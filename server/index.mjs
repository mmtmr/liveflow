import express from "express";
import { config } from "dotenv";

config({ path: ".env.local", override: true });
config();

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(express.json({ limit: "2mb" }));

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildImagePrompt({ transcript, gestures, strokes, mode, visualAnalysis, previousBrief, visualHistory }) {
  const speech = transcript?.trim() || "The teacher is explaining a concept.";
  const gestureSummary = gestures?.length
    ? gestures.slice(-8).map((item) => `${item.label} (${item.score})`).join(", ")
    : "No clear gesture detected yet.";
  const strokeSummary = strokes?.length
    ? strokes
        .slice(-4)
        .map((stroke, index) => `stroke ${index + 1}: ${stroke.hand || "hand"} drew ${stroke.points} points, ${stroke.direction}`)
        .join("; ")
    : "No visible tracing yet.";
  const sceneSummary = visualAnalysis?.trim() || "No camera scene analysis yet.";
  const continuity = previousBrief?.trim()
    ? `Continue and refine the previous visual instead of restarting: ${previousBrief.trim()}`
    : "This may be the first visual. Establish a simple reusable diagram foundation.";
  const historySummary = Array.isArray(visualHistory) && visualHistory.length
    ? visualHistory
        .slice(0, 3)
        .map((item, index) => `visual ${index + 1}: ${item.mode || "diagram"} at ${item.time || "recent"} - ${item.brief || "no brief"}`)
        .join("; ")
    : "No previous visual history.";

  return [
    "Create one clear educational visual aid for a live teacher overlay.",
    "The image should be instantly readable in a screen overlay and useful for deaf or hard-of-hearing learners following the lesson visually.",
    "Use a clean infographic, classroom diagram, or whiteboard visual that directly follows the current lesson.",
    "Preserve continuity: evolve the active idea, add the new concept, and avoid changing style or subject unless the lesson clearly moved on.",
    "If the teacher traced arrows, circles, comparisons, or paths, convert those gestures into semantic arrows, highlights, groupings, or process flow.",
    "Prioritize the latest camera scene analysis over generic assumptions when choosing what to draw.",
    "Reflect the teacher's visible pointing, board content, objects, and traced hand paths when they are pedagogically meaningful.",
    "Do not include photorealistic people, clutter, tiny text, brand marks, watermarks, or UI chrome.",
    continuity,
    `Recent visual history: ${historySummary}`,
    `Lesson context: ${speech}`,
    `Camera scene analysis: ${sceneSummary}`,
    `Detected gestures: ${gestureSummary}`,
    `Teacher traced lines: ${strokeSummary}`,
    `Visual mode: ${mode || "diagram"}`
  ].join("\n");
}

function sanitizeOpenAIError(message) {
  return String(message || "Image generation failed.").replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted-api-key]");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeFallbackImage({ transcript, gestures, strokes, mode }) {
  const title = mode === "steps" ? "Step-by-step cue" : mode === "metaphor" ? "Visual metaphor" : "Teaching diagram";
  const shortTranscript = (transcript || "Live lesson context").slice(0, 92);
  const gesture = gestures?.at?.(-1)?.label || "tracking gesture";
  const stroke = strokes?.at?.(-1)?.direction || "waiting for trace";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0d151b"/>
          <stop offset="1" stop-color="#1e2930"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="url(#bg)"/>
      <rect x="74" y="74" width="876" height="876" rx="46" fill="#f7f1df"/>
      <path d="M176 690 C310 560 358 612 462 480 S652 318 822 282" fill="none" stroke="#e4a83d" stroke-width="34" stroke-linecap="round"/>
      <circle cx="224" cy="646" r="46" fill="#4e9f86"/>
      <circle cx="512" cy="438" r="54" fill="#2f7190"/>
      <circle cx="790" cy="292" r="48" fill="#d65f4b"/>
      <text x="132" y="178" font-family="Inter, Arial, sans-serif" font-size="54" font-weight="800" fill="#182128">${escapeXml(title)}</text>
      <text x="132" y="258" font-family="Inter, Arial, sans-serif" font-size="34" fill="#31414a">${escapeXml(shortTranscript)}</text>
      <rect x="132" y="752" width="760" height="64" rx="18" fill="#182128"/>
      <text x="164" y="794" font-family="Inter, Arial, sans-serif" font-size="30" fill="#f7f1df">Gesture: ${escapeXml(gesture)}</text>
      <rect x="132" y="834" width="760" height="64" rx="18" fill="#31414a"/>
      <text x="164" y="876" font-family="Inter, Arial, sans-serif" font-size="30" fill="#f7f1df">Trace: ${escapeXml(stroke)}</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY)
  });
});

app.get("/api/realtime-token", async (_req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not available to the server process."
    });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
          instructions: "Listen to the teacher and transcribe accurately. Do not generate spoken audio responses.",
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              transcription: {
                model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe",
                language: "en",
                prompt: "Classroom teaching, technical terminology, diagrams, hand gestures, and visual explanations."
              },
              turn_detection: {
                type: "server_vad",
                create_response: false,
                threshold: 0.45,
                prefix_padding_ms: 300,
                silence_duration_ms: 650
              }
            }
          }
        }
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: sanitizeOpenAIError(payload.error?.message),
        details: payload.error?.type || response.statusText
      });
    }

    res.json({
      value: payload.value || payload.client_secret?.value,
      expiresAt: payload.expires_at || payload.client_secret?.expires_at,
      model: payload.session?.model
    });
  } catch (error) {
    res.status(500).json({
      error: sanitizeOpenAIError(error instanceof Error ? error.message : "Failed to create Realtime token.")
    });
  }
});

app.post("/api/analyze-frame", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not available to the server process."
    });
  }

  const { frame, transcript, gestures, strokes } = req.body || {};
  if (!frame || !String(frame).startsWith("data:image/")) {
    return res.status(400).json({
      error: "A camera frame data URL is required."
    });
  }

  const context = [
    transcript ? `Recent speech: ${transcript}` : "",
    gestures?.length ? `Recent gestures: ${gestures.slice(-6).map((item) => item.label).join(", ")}` : "",
    strokes?.length ? `Recent traces: ${strokes.slice(-4).map((stroke) => `${stroke.hand || "hand"} ${stroke.direction}`).join("; ")}` : ""
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Analyze this live teaching camera frame for an assistive visual-generation system.",
                  "Return 3 concise bullets only:",
                  "1. What topic or board/object content appears visible.",
                  "2. What the teacher's hands/traces seem to emphasize.",
                  "3. What visual aid should be generated next.",
                  context
                ].filter(Boolean).join("\n")
              },
              {
                type: "input_image",
                image_url: frame
              }
            ]
          }
        ]
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: sanitizeOpenAIError(payload.error?.message),
        details: payload.error?.type || response.statusText
      });
    }

    res.json({
      analysis: extractResponseText(payload),
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: sanitizeOpenAIError(error instanceof Error ? error.message : "Frame analysis failed.")
    });
  }
});

app.post("/api/generate", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not available to the server process."
    });
  }

  const prompt = buildImagePrompt(req.body || {});

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
        prompt,
        size: "1024x1024",
        quality: "low",
        n: 1
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      return res.status(200).json({
        imageUrl: makeFallbackImage(req.body || {}),
        prompt,
        fallback: true,
        error: sanitizeOpenAIError(payload.error?.message),
        details: payload.error?.type || response.statusText,
        createdAt: new Date().toISOString()
      });
    }

    const first = payload.data?.[0];
    const imageUrl = first?.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : first?.url;

    if (!imageUrl) {
      return res.status(502).json({
        error: "OpenAI returned no image URL or base64 image data."
      });
    }

    res.json({
      imageUrl,
      prompt,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(200).json({
      imageUrl: makeFallbackImage(req.body || {}),
      prompt,
      fallback: true,
      error: sanitizeOpenAIError(error instanceof Error ? error.message : "Unexpected server error."),
      createdAt: new Date().toISOString()
    });
  }
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
