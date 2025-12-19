// server.js (DROP-IN, FULLY UPDATED)
// PT Summary backend for iOS client (SwiftUI)
// - Adds /clean endpoint
// - Enforces Subjective rules (Pt reports/noted/verbalized/c/c of/complaints of/consent/agrees)
// - Forces varied Summary intros (rotates per patient)
// - Uses abbreviations; avoids repeating generic openers
// - No hallucinations: only use details explicitly present in userText
// - Summary final sentence must include EXACT phrase: "Continued skilled PT remains indicated"

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config(); // loads .env in this folder

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3301);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Basic sanity logging (does not print full key)
console.log("Booting PT summary backend...");
console.log("PORT =", PORT);
console.log("MODEL =", MODEL);
console.log(
            "OPENAI_API_KEY present =",
            OPENAI_API_KEY && OPENAI_API_KEY.startsWith("sk-") ? "YES" : "NO"
            );

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in env (.env or shell).");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- Intro variation (anti-repeat) ----------------

// Rotate summary intros per patient while the server is running.
// This guarantees each new generation for the same patient starts differently.
const INTRO_STYLES = [
  `Start Summary with "Today, pt..."`,
  `Start Summary with "Overall, pt..."`,
  `Start Summary with "Pt demonstrates..."`,
  `Start Summary with "Pt displays..."`,
  `Start Summary with "During today's tx, pt..."`,
  `Start Summary with "Pt continues..."`,
  `Start Summary with "Pt presents..."`,
  `Start Summary with "Tx focused on..." (then continue with Pt-based wording)`
];

const patientCounters = new Map();

function pickIntroStyle(patientLabel) {
  const n = (patientCounters.get(patientLabel) || 0) + 1;
  patientCounters.set(patientLabel, n);
  return INTRO_STYLES[(n - 1) % INTRO_STYLES.length];
}

// ---------------- Small helpers ----------------

function normalizeSpaces(s) {
  return String(s || "")
  .replace(/\r\n/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}

// “Clean” is intentionally conservative: normalize whitespace, remove weird bullets,
// and reduce accidental duplicated lines. It does NOT rewrite clinical meaning.
function cleanUserText(rawText) {
  let t = String(rawText || "");
  
  // Normalize common bullet glyphs to simple hyphen, then remove repeated hyphens spacing
  t = t.replace(/[•●◦▪️]/g, "-");
  t = t.replace(/-\s*-\s*/g, "- ");
  
  // Remove repeated identical lines (simple de-dupe)
  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  
  return normalizeSpaces(out.join("\n"));
}

// ---------------- Prompt builders ----------------

function buildCleanPrompt(rawText) {
  return `
Task: Clean the user's PT visit instruction for clarity WITHOUT adding new facts.

Rules:
- Do NOT add any clinical details that are not explicitly present.
- Keep abbreviations (LBP, C/S, ROM, TherEx, TherAct, MT, STM, VC/TC, ADLs, PLOF, etc.).
- Remove filler words and repeated phrases.
- Keep it as a single concise paragraph (no bullets).

Input:
${rawText}

Output ONLY the cleaned text (no quotes, no labels).
`.trim();
}

function buildGeneratePrompt({ patientLabel, userText, introStyle }) {
  return `
You are generating a PT visit note in EXACTLY this format:

Subjective
<one sentence ONLY. Must be patient-reported content ONLY using ONE of these starters:
"Pt reports", "Pt noted", "Pt verbalized", "Pt c/c of", "Pt complaints of", "Pt provided consent for tx", "Pt agrees to PT tx and POC".
Do NOT add objective findings here. Do NOT say "Pt tolerates tx well" in Subjective.>

Summary
<5–7 sentences, professional, Medicare-compliant, STRICTLY based on the user instruction only (no hallucinations).
Use abbreviations: LBP, C/S, T/S, L/S, B, R, L, ROM, MT, STM, TherEx, TherAct, VC/TC, ADLs, PLOF, gait, SBA/CGA, SPC, FWW, etc.
Do NOT spell out abbreviations.
Do NOT use arrows (↑ ↓).
Do NOT use these repetitive starters anywhere in the Summary:
"Pt demonstrated good engagement", "Pt tolerated treatment well", "Range of motion showed slight improvement", "pain levels remained manageable".
Summary must start with a varied opener matching this required intro style: ${introStyle}
The final sentence of Summary must include EXACTLY this phrase: "Continued skilled PT remains indicated".>

POC
PT POC: TherEx, TherAct, MT, mobility/function/PLOF/ADLs.

Hard rules:
- Output must contain EXACTLY 3 sections in this order: Subjective, Summary, POC.
- Each section title must be on its own line (no colon).
- There must be a blank line between sections.
- Do NOT add bullets or numbering.
- Never write "The patient" or "patient"; always "Pt".
- Keep topic consistent with the user instruction.

No-hallucination policy:
- Only mention findings, body regions, interventions, and measures that are explicitly stated in the user instruction.
- If the user instruction is vague, write general-but-accurate statements without inventing specifics.

Context:
Patient: ${patientLabel}
User instruction (only source of truth): ${userText}

Now produce the formatted output.
`.trim();
}

// ---------------- Routes ----------------

app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug endpoint (local use)
app.get("/debug-env", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    model: MODEL,
    hasKey: OPENAI_API_KEY.startsWith("sk-"),
    keyPrefix: OPENAI_API_KEY.slice(0, 7) + "..." // do not expose full key
  });
});

// iOS calls this with { rawText: "..." } and expects { cleaned: "..." }
app.post("/clean", async (req, res) => {
  try {
    const rawText = String(req.body?.rawText || "");
    if (!rawText.trim()) return res.status(400).json({ error: "rawText is required." });
    
    // First do local conservative cleaning
    const locallyCleaned = cleanUserText(rawText);
    
    // Then optionally use AI to further compress/clarify without adding facts
    const prompt = buildCleanPrompt(locallyCleaned);
    
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You rewrite text conservatively without adding facts." },
        { role: "user", content: prompt }
      ]
    });
    
    const cleaned = completion.choices?.[0]?.message?.content?.trim() || locallyCleaned;
    
    return res.json({ cleaned: normalizeSpaces(cleaned) });
  } catch (err) {
    console.error("❌ /clean failed");
    console.error(err?.status, err?.message || err);
    return res.status(500).json({
      error: "Clean failed.",
      details: err?.message || String(err)
    });
  }
});

// iOS calls this with { patientLabel, userText } and expects { summary: "..." }
app.post("/generate", async (req, res) => {
  try {
    const patientLabel = String(req.body?.patientLabel || "Patient #1").trim() || "Patient #1";
    const userTextRaw = String(req.body?.userText || "");
    const userText = normalizeSpaces(userTextRaw);
    
    if (!userText.trim()) {
      return res.status(400).json({ error: "userText is required." });
    }
    
    const introStyle = pickIntroStyle(patientLabel);
    const prompt = buildGeneratePrompt({ patientLabel, userText, introStyle });
    
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.35,
      messages: [
        {
          role: "system",
        content:
          "You write concise PT visit notes per strict formatting rules. Never hallucinate. Use abbreviations."
        },
        { role: "user", content: prompt }
      ]
    });
    
    const text = completion.choices?.[0]?.message?.content?.trim() || "";
    if (!text) {
      return res.status(500).json({ error: "Empty response from model." });
    }
    
    // Final sanity: normalize spacing (does not change meaning)
    return res.json({ summary: normalizeSpaces(text) });
  } catch (err) {
    console.error("❌ /generate failed");
    console.error(err?.status, err?.message || err);
    if (err?.response) {
      console.error("Response status:", err.response.status);
      console.error("Response data:", err.response.data);
    }
    return res.status(500).json({
      error: "Generation failed.",
      details: err?.message || String(err)
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("PT summary backend running on:");
  console.log(`- http://localhost:${PORT}`);
  console.log(`- http://0.0.0.0:${PORT}`);
});
