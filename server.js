// server.js (DROP-IN, FULLY UPDATED)
// PT Summary backend for iOS client (SwiftUI)
//
// What this version fixes/implements:
// - Uses dotenv (so Render + local .env work reliably)
// - Adds /health, /debug-env, /clean, /generate
// - Hard-enforces output format: EXACTLY 3 sections (Subjective / Summary / POC)
// - Subjective: 1 sentence, MUST start with allowed starters, MUST be patient-reported only
// - Summary: 5–7 sentences, abbrev only, no arrows, no banned generic openers
// - Summary intro: rotated per patient (server-side), enforced as exact prefix on first Summary sentence
// - Summary final sentence: varies BUT MUST CONTAIN the exact substring:
//     "Continued skilled PT remains indicated"
// - POC: one line, "PT POC:" + rotated opener (server-side) + required phrase content
// - No hallucination guard: forbids new numbers/devices/vitals/etc unless userText includes them
// - Auto-repair pass if the model violates constraints (1 retry)
//
// IMPORTANT:
// - Ensure package.json includes: "dotenv": "^16.4.5" (or newer).
// - On Render, set OPENAI_API_KEY and OPENAI_MODEL in Environment Variables.
// - Render provides PORT automatically; this uses process.env.PORT.

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

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

// ---------------- Utilities ----------------

function normalizeSpaces(s) {
  return String(s || "")
  .replace(/\r\n/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\u00A0/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}

function countSentences(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  // Count sentence endings; tolerate clinical abbreviations by requiring end punctuation.
  const matches = t.match(/[.!?](?=\s|$)/g);
  return matches ? matches.length : 0;
}

function splitSections(noteText) {
  const t = normalizeSpaces(noteText);
  // Expect:
  // Subjective\n...\n\nSummary\n...\n\nPOC\n...
  const re =
  /^Subjective\s*\n([\s\S]*?)\n\nSummary\s*\n([\s\S]*?)\n\nPOC\s*\n([\s\S]*?)$/i;
  const m = t.match(re);
  if (!m) return null;
  return {
    subjective: m[1].trim(),
    summary: m[2].trim(),
    poc: m[3].trim(),
    raw: t,
  };
}

function containsAnyNumbers(str) {
  return /\d/.test(String(str || ""));
}

function hasArrowChars(str) {
  return /[↑↓]/.test(String(str || ""));
}

function lineIsSingleLine(str) {
  return !String(str || "").includes("\n");
}

function includesExactClosingPhrase(lastSentence) {
  return String(lastSentence || "").includes("Continued skilled PT remains indicated");
}

function getLastSentence(text) {
  const t = String(text || "").trim();
  // Split on sentence terminators while keeping terminator
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].trim() : "";
}

// ---------------- Conservative Clean ----------------

function cleanUserText(rawText) {
  let t = String(rawText || "");
  
  // Normalize bullet glyphs to hyphen
  t = t.replace(/[•●◦▪️]/g, "-");
  
  // De-dupe identical lines
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  
  // Join with newline then normalize whitespace
  return normalizeSpaces(out.join("\n"));
}

function buildCleanPrompt(rawText) {
  return `
Task: Clean the user's PT visit instruction for clarity WITHOUT adding new facts.

Rules:
- Do NOT add any clinical details that are not explicitly present.
- Keep abbreviations (LBP, C/S, ROM, TherEx, TherAct, MT, STM, VC/TC, ADLs, PLOF, etc.).
- Remove filler words and repeated phrases.
- Keep it as a single concise paragraph (no bullets, no numbering).

Input:
${rawText}

Output ONLY the cleaned text (no quotes, no labels).
`.trim();
}

// ---------------- Variation (server-side rotation) ----------------

const SUMMARY_INTRO_PREFIXES = [
  "Today, pt ",
  "Overall, pt ",
  "Pt demonstrates ",
  "Pt displays ",
  "Pt shows ",
  "During today's tx, pt ",
  "Pt continues ",
  "Pt presents ",
  "Tx focused on ",
  "Functional mobility indicates pt ",
];

// Closing sentences must CONTAIN the exact substring
// "Continued skilled PT remains indicated" but can vary around it.
const SUMMARY_CLOSERS = [
  "Continued skilled PT remains indicated to progress POC and support functional carryover to ADLs.",
  "Continued skilled PT remains indicated to address impairments and promote safe mobility to meet goals.",
  "Continued skilled PT remains indicated to improve strength, ROM, and functional tolerance for ADLs and PLOF.",
  "Continued skilled PT remains indicated to reduce fall/injury risk and improve safe functional performance.",
  "Continued skilled PT remains indicated to advance therapeutic progression and optimize functional outcomes.",
];

const POC_OPENERS = [
  "Continue to focus on",
  "Plan to progress",
  "Continue skilled PT emphasizing",
  "Continue with a focus on",
  "Proceed with ongoing skilled PT targeting",
  "Maintain POC with emphasis on",
  "Continue intervention focus on",
  "Advance POC with continued emphasis on",
];

const patientCounters = new Map();

function nextIndexForPatient(patientLabel) {
  const n = (patientCounters.get(patientLabel) || 0) + 1;
  patientCounters.set(patientLabel, n);
  return n - 1;
}

function pickForPatient(patientLabel, arr) {
  const idx = nextIndexForPatient(patientLabel);
  return arr[idx % arr.length];
}

function pickIntroPrefix(patientLabel) {
  return pickForPatient(`${patientLabel}::intro`, SUMMARY_INTRO_PREFIXES);
}

function pickCloser(patientLabel) {
  return pickForPatient(`${patientLabel}::close`, SUMMARY_CLOSERS);
}

function pickPocOpener(patientLabel) {
  return pickForPatient(`${patientLabel}::poc`, POC_OPENERS);
}

// ---------------- Prompt Builders ----------------

const SUBJECTIVE_STARTERS = [
  "Pt reports",
  "Pt noted",
  "Pt verbalized",
  "Pt c/c of",
  "Pt complaints of",
  "Pt provided consent for tx",
  "Pt agrees to PT tx and POC",
];

const BANNED_SUMMARY_STARTS = [
  "Pt demonstrated good engagement",
  "Pt tolerated treatment well",
  "ROM showed slight improvement",
  "pain levels remained manageable",
];

function buildGeneratePrompt({ patientLabel, userText, introPrefix, closerSentence, pocOpener }) {
  // IMPORTANT: keep rules out of the 3-section output by separating constraints cleanly.
  return `
  Write a PT visit note with EXACTLY 3 sections in this order:
  
  Subjective
  (one sentence)
  
  Summary
  (5 to 7 sentences)
  
  POC
  (one line)
  
  FORMAT (must follow exactly):
  - Output must contain ONLY these 3 section headers: Subjective, Summary, POC.
  - Each header is on its own line (no colon).
  - Exactly ONE blank line between sections.
  - No bullets, no numbering, no extra labels.
  - Never write "patient" or "the patient"; always "Pt".
  - No arrows (↑ ↓).
  - Use abbreviations only; do NOT spell out abbreviations.
  
  SOURCE OF TRUTH / NO-HALLUCINATION:
  - Use ONLY the user instruction as factual input.
  - Do NOT invent: pain scores, distances, devices, vitals, diagnoses, grades, times, frequencies, or side (R/L/B) unless explicitly stated in user instruction.
  - If instruction is vague, write general-but-accurate statements without adding specifics.
  
  SUBJECTIVE RULES:
  - Subjective must be ONE sentence only.
  - Must start with exactly ONE of these starters:
  ${SUBJECTIVE_STARTERS.join(" / ")}
  - Subjective must be patient-reported content only.
  - Do NOT add objective findings in Subjective.
  - Do NOT say "tolerates tx well" in Subjective.
  
  SUMMARY RULES:
  - Summary must be 5 to 7 sentences.
  - Summary first sentence MUST start with this exact prefix (case-sensitive): "${introPrefix}"
  - Do NOT use arrows (↑ ↓).
  - Do NOT start any Summary sentence with these phrases:
  ${BANNED_SUMMARY_STARTS.map((s) => `"${s}"`).join(", ")}.
- The FINAL sentence of Summary must be EXACTLY this sentence (copy it verbatim, do not alter):
  ${closerSentence}

POC RULES:
- POC must be ONE line only.
- Must start with: "PT POC:"
- Must use this exact opener immediately after "PT POC:" (do not change): "${pocOpener}"
- Must include ALL required elements and end with "to meet goals."
- Required POC content:
  TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.

User instruction (only source of truth):
${userText}

Patient label:
${patientLabel}
`.trim();
}

function buildRepairPrompt({ patientLabel, userText, badOutput, introPrefix, closerSentence, pocOpener }) {
  return `
You must FIX the note to comply with ALL constraints. Do not add facts.

Return ONLY the corrected note with EXACTLY 3 sections: Subjective, Summary, POC.

Constraints to enforce:
- Subjective: ONE sentence, patient-reported only, must start with one of:
  ${SUBJECTIVE_STARTERS.join(" / ")}
- Summary: 5 to 7 sentences.
- Summary first sentence MUST start with: "${introPrefix}"
- Summary final sentence MUST be EXACTLY: ${closerSentence}
- No arrows (↑ ↓).
- Never write "patient"; always "Pt".
- No bullets or numbering.
- POC: ONE line, must be:
  PT POC: ${pocOpener} TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.

No-hallucination:
- Only use details explicitly present in user instruction; no new numbers/devices/vitals/diagnoses.

User instruction:
${userText}

Bad output to fix:
${badOutput}

Now output the corrected note only.
`.trim();
}

// ---------------- Validation ----------------

function validateGenerated({ text, introPrefix, closerSentence, pocOpener }) {
  const sections = splitSections(text);
  if (!sections) return { ok: false, reason: "Could not parse 3 sections (Subjective/Summary/POC) with required spacing." };
  
  const { subjective, summary, poc } = sections;
  
  // Subjective: 1 sentence, allowed starter, no objective-ish "tolerates tx well"
  if (countSentences(subjective) !== 1) return { ok: false, reason: "Subjective must be exactly 1 sentence." };
  
  const starterOk = SUBJECTIVE_STARTERS.some((s) => subjective.startsWith(s));
  if (!starterOk) return { ok: false, reason: "Subjective must start with an allowed starter." };
  
  if (/tolerates?\s+tx\s+well/i.test(subjective)) return { ok: false, reason: 'Subjective must not say "tolerates tx well".' };
  
  // Summary: 5-7 sentences, no arrows, intro prefix, banned openers, final sentence exact
  const sc = countSentences(summary);
  if (sc < 5 || sc > 7) return { ok: false, reason: "Summary must be 5–7 sentences." };
  if (hasArrowChars(summary)) return { ok: false, reason: "Summary contains arrow characters." };
  if (!summary.startsWith(introPrefix)) return { ok: false, reason: "Summary does not start with required intro prefix." };
  
  // Banned starters: check each sentence start
  const sentences = summary.split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const s of sentences) {
    const trimmed = s.trim();
    if (BANNED_SUMMARY_STARTS.some((b) => trimmed.startsWith(b))) {
      return { ok: false, reason: "Summary uses a banned generic starter." };
    }
  }
  
  const last = getLastSentence(summary);
  if (last !== closerSentence) return { ok: false, reason: "Summary final sentence is not the required exact closing sentence." };
  if (!includesExactClosingPhrase(last)) return { ok: false, reason: 'Summary final sentence must include: "Continued skilled PT remains indicated"' };
  
  // POC: one line, exact template
  if (!lineIsSingleLine(poc)) return { ok: false, reason: "POC must be one line." };
  const expectedPoc = `PT POC: ${pocOpener} TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.`;
  if (poc !== expectedPoc) return { ok: false, reason: "POC line does not match required template." };
  
  // Global: must not contain the word "patient"
  if (/\bpatient\b/i.test(text)) return { ok: false, reason: 'Output contains forbidden word "patient".' };
  
  return { ok: true };
}

// ---------------- Routes ----------------

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/debug-env", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    model: MODEL,
    hasKey: OPENAI_API_KEY.startsWith("sk-"),
    keyPrefix: OPENAI_API_KEY.slice(0, 7) + "...",
  });
});

app.post("/clean", async (req, res) => {
  try {
    const rawText = String(req.body?.rawText || "");
    if (!rawText.trim()) return res.status(400).json({ error: "rawText is required." });
    
    const locallyCleaned = cleanUserText(rawText);
    const prompt = buildCleanPrompt(locallyCleaned);
    
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.15,
      messages: [
        { role: "system", content: "You rewrite text conservatively without adding facts." },
        { role: "user", content: prompt },
      ],
    });
    
    const cleaned = completion.choices?.[0]?.message?.content?.trim() || locallyCleaned;
    return res.json({ cleaned: normalizeSpaces(cleaned) });
  } catch (err) {
    console.error("❌ /clean failed");
    console.error(err?.status, err?.message || err);
    return res.status(500).json({
      error: "Clean failed.",
      details: err?.message || String(err),
    });
  }
});

app.post("/generate", async (req, res) => {
  try {
    const patientLabel = String(req.body?.patientLabel || "Patient #1").trim() || "Patient #1";
    const userTextRaw = String(req.body?.userText || "");
    const userText = normalizeSpaces(userTextRaw);
    
    if (!userText.trim()) return res.status(400).json({ error: "userText is required." });
    
    // Rotate intro/closer/poc opener server-side (reliably varied)
    const introPrefix = pickIntroPrefix(patientLabel);
    const closerSentence = pickCloser(patientLabel);
    const pocOpener = pickPocOpener(patientLabel);
    
    const prompt = buildGeneratePrompt({
      patientLabel,
      userText,
      introPrefix,
      closerSentence,
      pocOpener,
    });
    
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
        content:
          "You write concise PT visit notes per strict formatting rules. Use abbreviations. Do not hallucinate.",
        },
        { role: "user", content: prompt },
      ],
    });
    
    let text = completion.choices?.[0]?.message?.content?.trim() || "";
    if (!text) return res.status(500).json({ error: "Empty response from model." });
    
    text = normalizeSpaces(text);
    
    // Validate; if invalid, do one repair pass.
    const v1 = validateGenerated({ text, introPrefix, closerSentence, pocOpener });
    if (!v1.ok) {
      const repairPrompt = buildRepairPrompt({
        patientLabel,
        userText,
        badOutput: text,
        introPrefix,
        closerSentence,
        pocOpener,
      });
      
      const repair = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Fix formatting strictly. Do not add facts. Output only the corrected note." },
          { role: "user", content: repairPrompt },
        ],
      });
      
      const repaired = normalizeSpaces(repair.choices?.[0]?.message?.content?.trim() || "");
      if (repaired) text = repaired;
      
      const v2 = validateGenerated({ text, introPrefix, closerSentence, pocOpener });
      if (!v2.ok) {
        return res.status(500).json({
          error: "Generation produced invalid format.",
          details: v2.reason,
          raw: text,
        });
      }
    }
    
    return res.json({ summary: text });
  } catch (err) {
    console.error("❌ /generate failed");
    console.error(err?.status, err?.message || err);
    return res.status(500).json({
      error: "Generation failed.",
      details: err?.message || String(err),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("PT summary backend running on:");
  console.log(`- http://localhost:${PORT}`);
  console.log(`- http://0.0.0.0:${PORT}`);
});
