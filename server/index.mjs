import express from "express";
import { config } from "dotenv";

config({ path: ".env.local", override: true });
config();

const app = express();
const port = Number(process.env.PORT || 8787);
const falImageModel = process.env.FAL_IMAGE_MODEL || "fal-ai/flux/schnell";
const falImageEndpoint = `https://fal.run/${falImageModel}`;
const openAIImageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const mermaidModel = process.env.OPENAI_MERMAID_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";

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

function buildImagePrompt({ transcript, recentTranscript, gestures, strokes, mode, visualAnalysis, generationAnalysis, previousBrief, visualHistory }) {
  const speech = recentTranscript?.trim() || transcript?.trim() || "The teacher is explaining a concept.";
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
  const freshSummary = generationAnalysis?.trim() || "No fresh generation snapshot analysis.";
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
    "Use the fresh generation snapshot as the strongest signal for what the teacher is pointing at right now.",
    "Use recent speech as the strongest signal for labels, topic, and intended teaching meaning.",
    "Prioritize the latest camera scene analysis over generic assumptions when choosing what to draw.",
    "Reflect the teacher's visible pointing, board content, objects, and traced hand paths when they are pedagogically meaningful.",
    "Do not include photorealistic people, clutter, tiny text, brand marks, watermarks, or UI chrome.",
    continuity,
    `Recent visual history: ${historySummary}`,
    `Recent speech context: ${speech}`,
    `Fresh generation snapshot analysis: ${freshSummary}`,
    `Camera scene analysis: ${sceneSummary}`,
    `Detected gestures: ${gestureSummary}`,
    `Teacher traced lines: ${strokeSummary}`,
    `Visual mode: ${mode || "diagram"}`
  ].join("\n");
}

function sanitizeOpenAIError(message) {
  return String(message || "Image generation failed.").replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted-api-key]");
}

function sanitizeFalError(message) {
  return String(message || "Image generation failed.")
    .replace(/Key\s+[A-Za-z0-9_*.:/-]+/g, "Key [redacted-api-key]")
    .replace(/fal_[A-Za-z0-9_*.-]+/g, "[redacted-api-key]");
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function getImageProvider(value) {
  if (value === "openai" || value === "mermaid") return value;
  return "fal";
}

function buildMermaidPrompt({ transcript, recentTranscript, gestures, strokes, mode, visualAnalysis, previousBrief, visualHistory }) {
  const speech = recentTranscript?.trim() || transcript?.trim() || "The teacher is explaining a concept.";
  const gestureSummary = gestures?.length
    ? gestures.slice(-8).map((item) => `${item.label} (${item.score})`).join(", ")
    : "No clear gesture detected.";
  const strokeSummary = strokes?.length
    ? strokes.slice(-6).map((stroke) => `${stroke.hand || "hand"} ${stroke.direction}, ${stroke.points} points`).join("; ")
    : "No visible trace metadata.";
  const historySummary = Array.isArray(visualHistory) && visualHistory.length
    ? visualHistory.slice(0, 3).map((item) => item.brief || item.mode || "previous visual").join("; ")
    : "No previous visual history.";

  return [
    "Create one Mermaid diagram for a live teaching overlay.",
    "Return Mermaid syntax only. Do not use markdown fences, prose, HTML, emojis, comments, or unsupported styling.",
    "Prefer flowchart TD for processes, cause/effect, comparisons, cycles, or concept maps. Use sequenceDiagram only for clear timelines/conversations.",
    "Keep it readable in an overlay: 4 to 10 nodes, short labels, simple arrows, no dense paragraphs.",
    "Use quoted node labels when labels contain punctuation.",
    "If the teacher trace implies direction, connection, grouping, cycle, or comparison, encode that in the diagram arrows.",
    "Recent speech is the strongest signal for topic and labels.",
    `Visual mode: ${mode || "diagram"}`,
    `Recent speech: ${speech}`,
    `Camera analysis: ${visualAnalysis || "No camera analysis."}`,
    `Gestures: ${gestureSummary}`,
    `Traces: ${strokeSummary}`,
    `Previous brief: ${previousBrief || "none"}`,
    `Recent visual history: ${historySummary}`
  ].join("\n");
}

function cleanMermaidCode(value) {
  let code = String(value || "").trim();
  code = code.replace(/^```(?:mermaid)?\s*/i, "").replace(/```$/i, "").trim();
  code = code.replace(/^mermaid\s*/i, "").trim();
  const validStart = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|journey|timeline|mindmap)\b/i;
  if (validStart.test(code)) return code;

  const fallbackLabel = code
    .split(/\n+/)
    .map((line) => line.replace(/["[\]{}()<>]/g, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const nodes = fallbackLabel.length ? fallbackLabel : ["Lesson context", "Key idea", "Visual aid"];
  return [
    "flowchart TD",
    ...nodes.map((label, index) => `  N${index + 1}["${label.slice(0, 72)}"]`),
    ...nodes.slice(1).map((_label, index) => `  N${index + 1} --> N${index + 2}`)
  ].join("\n");
}

async function analyzeGenerationFrame({ frame, transcript, recentTranscript, gestures, strokes }) {
  if (!process.env.OPENAI_API_KEY || !frame || !String(frame).startsWith("data:image/")) {
    return { analysis: "", durationMs: 0 };
  }

  const startedAt = Date.now();
  const speech = recentTranscript || transcript || "";
  const gestureSummary = gestures?.length
    ? gestures.slice(-8).map((item) => `${item.label} (${item.score})`).join(", ")
    : "No gesture labels.";
  const strokeSummary = strokes?.length
    ? strokes.slice(-6).map((stroke) => `${stroke.hand || "hand"} ${stroke.direction}, ${stroke.points} points`).join("; ")
    : "No committed stroke metadata.";

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
                  "Analyze this current teacher camera snapshot for text-to-image prompt grounding.",
                  "The image may include colored hand-trace overlays drawn from index-finger movement.",
                  "Return 4 concise, high-signal bullets only:",
                  "1. Visible lesson topic, board/object content, or teaching materials.",
                  "2. What the visible colored traces point to, circle, connect, compare, or move across.",
                  "3. How the recent speech should change the visual aid.",
                  "4. The exact visual aid to generate next, including layout and key labels.",
                  `Recent speech: ${speech || "No recent speech."}`,
                  `Gesture labels: ${gestureSummary}`,
                  `Stroke metadata: ${strokeSummary}`
                ].join("\n")
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
    if (!response.ok) return { analysis: "", durationMs: Date.now() - startedAt };

    return {
      analysis: extractResponseText(payload),
      durationMs: Date.now() - startedAt
    };
  } catch {
    return { analysis: "", durationMs: Date.now() - startedAt };
  }
}

async function generateFalImage({ prompt, requestContext, generationFrame, startedAt }) {
  const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;

  if (!falKey) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "fal.ai",
      model: falImageModel,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: "FAL_KEY or FAL_API_KEY is not available to the server process.",
      createdAt: new Date().toISOString()
    };
  }

  const requestBody = {
    prompt,
    num_inference_steps: numberFromEnv("FAL_NUM_INFERENCE_STEPS", 4),
    image_size: process.env.FAL_IMAGE_SIZE || "square_hd",
    guidance_scale: numberFromEnv("FAL_GUIDANCE_SCALE", 3.5),
    sync_mode: false,
    num_images: 1,
    enable_safety_checker: process.env.FAL_ENABLE_SAFETY_CHECKER !== "false",
    output_format: process.env.FAL_OUTPUT_FORMAT || "jpeg",
    acceleration: process.env.FAL_ACCELERATION || "high"
  };

  const response = await fetch(falImageEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const payload = await response.json();
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "fal.ai",
      model: falImageModel,
      durationMs,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      timings: payload.timings,
      error: sanitizeFalError(payload.detail || payload.error?.message || payload.message),
      details: payload.error?.type || response.statusText,
      createdAt: new Date().toISOString()
    };
  }

  const imageUrl = payload.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("fal.ai returned no image URL.");
  }

  return {
    imageUrl,
    prompt,
    provider: "fal.ai",
    model: falImageModel,
    durationMs,
    contextDurationMs: generationFrame.durationMs,
    generationAnalysis: generationFrame.analysis,
    timings: payload.timings,
    seed: payload.seed,
    nsfw: payload.has_nsfw_concepts?.[0] || false,
    createdAt: new Date().toISOString()
  };
}

async function generateOpenAIImage({ prompt, requestContext, generationFrame, startedAt }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "OpenAI",
      model: openAIImageModel,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: "OPENAI_API_KEY is not available to the server process.",
      createdAt: new Date().toISOString()
    };
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: openAIImageModel,
      prompt,
      size: process.env.OPENAI_IMAGE_SIZE || "1024x1024",
      quality: process.env.OPENAI_IMAGE_QUALITY || "low",
      n: 1
    })
  });

  const payload = await response.json();
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "OpenAI",
      model: openAIImageModel,
      durationMs,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: sanitizeOpenAIError(payload.error?.message),
      details: payload.error?.type || response.statusText,
      createdAt: new Date().toISOString()
    };
  }

  const first = payload.data?.[0];
  const imageUrl = first?.b64_json
    ? `data:image/png;base64,${first.b64_json}`
    : first?.url;

  if (!imageUrl) {
    throw new Error("OpenAI returned no image URL or base64 image data.");
  }

  return {
    imageUrl,
    prompt,
    provider: "OpenAI",
    model: openAIImageModel,
    durationMs,
    contextDurationMs: generationFrame.durationMs,
    generationAnalysis: generationFrame.analysis,
    usage: payload.usage,
    createdAt: new Date().toISOString()
  };
}

async function generateMermaidDiagram({ requestContext, generationFrame, startedAt }) {
  const prompt = buildMermaidPrompt({
    ...requestContext,
    generationAnalysis: generationFrame.analysis
  });

  if (!process.env.OPENAI_API_KEY) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "Mermaid",
      model: mermaidModel,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: "OPENAI_API_KEY is not available to the server process.",
      createdAt: new Date().toISOString()
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: mermaidModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt
            }
          ]
        }
      ]
    })
  });

  const payload = await response.json();
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "Mermaid",
      model: mermaidModel,
      durationMs,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: sanitizeOpenAIError(payload.error?.message),
      details: payload.error?.type || response.statusText,
      createdAt: new Date().toISOString()
    };
  }

  const mermaidCode = cleanMermaidCode(extractResponseText(payload));
  return {
    diagramType: "mermaid",
    mermaidCode,
    prompt: mermaidCode,
    provider: "Mermaid",
    model: mermaidModel,
    durationMs,
    contextDurationMs: generationFrame.durationMs,
    generationAnalysis: generationFrame.analysis,
    createdAt: new Date().toISOString()
  };
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
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasFalKey: Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY),
    imageProviders: {
      fal: falImageModel,
      openai: openAIImageModel,
      mermaid: mermaidModel
    }
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
  const startedAt = Date.now();
  const requestContext = req.body || {};
  const imageProvider = getImageProvider(requestContext.imageProvider);

  const generationFrame = imageProvider === "openai" || requestContext.forceGenerationAnalysis
    ? await analyzeGenerationFrame(requestContext)
    : { analysis: "", durationMs: 0 };
  const prompt = buildImagePrompt({
    ...requestContext,
    generationAnalysis: generationFrame.analysis
  });

  try {
    const result = imageProvider === "mermaid"
      ? await generateMermaidDiagram({ requestContext, generationFrame, startedAt })
      : imageProvider === "openai"
        ? await generateOpenAIImage({ prompt, requestContext, generationFrame, startedAt })
        : await generateFalImage({ prompt, requestContext, generationFrame, startedAt });
    res.json(result);
  } catch (error) {
    const providerLabel = imageProvider === "mermaid" ? "Mermaid" : imageProvider === "openai" ? "OpenAI" : "fal.ai";
    const model = imageProvider === "mermaid" ? mermaidModel : imageProvider === "openai" ? openAIImageModel : falImageModel;
    res.status(200).json({
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: providerLabel,
      model,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: imageProvider === "openai" || imageProvider === "mermaid"
        ? sanitizeOpenAIError(error instanceof Error ? error.message : "Unexpected server error.")
        : sanitizeFalError(error instanceof Error ? error.message : "Unexpected server error."),
      createdAt: new Date().toISOString()
    });
  }
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
