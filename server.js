// server.js (DROP-IN, FULLY UPDATED)
// PT/OT Summary backend for iOS client (SwiftUI)
//
// Key behaviors:
// - /health, /debug-env, /clean, /generate
// - Enforces EXACT output format: 3 sections (Subjective / Summary / POC)
// - Summary intro rotated per patient, enforced as exact prefix
// - Summary closing sentence MUST CONTAIN:
//     "Continued skilled PT remains indicated"  (PT)
//     "Continued skilled OT remains indicated"  (OT)
// - POC is one line and must be exact discipline-specific template

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
console.log("Booting PT/OT summary backend...");
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

// ---------------- Small Utilities ----------------

function normalizeSpaces(s) {
  return String(s || "")
  .replace(/\r\n/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}

function isSingleLine(str) {
  return !String(str || "").includes("\n");
}

function includesExactClosingPhrase(lastSentence, discipline) {
  const needle =
  discipline === "OT"
  ? "Continued skilled OT remains indicated"
  : "Continued skilled PT remains indicated";
  return String(lastSentence || "").includes(needle);
}

function getLastSentence(text) {
  const t = String(text || "").trim();
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].trim() : "";
}

// ---------------- Conservative Clean ----------------

function cleanUserText(rawText) {
  let t = String(rawText || "");
  
  // Normalize bullet glyphs to hyphen
  t = t.replace(/[•●◦▪️]/g, "-");
  
  // De-dupe identical lines
  const lines = t
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);
  
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  
  // Keep it reasonable
  return out.joined ? out.joined("\n") : out.join("\n");
}

// ---------------- Patient-based rotation (stable variations) ----------------

const patientMemory = new Map();

function pickForPatient(patientKey, arr) {
  const key = `${patientKey}::${arr.length}`;
  let idx = patientMemory.get(key);
  if (idx == null) {
    idx = Math.floor(Math.random() * arr.length);
  } else {
    idx = (idx + 1) % arr.length;
  }
  patientMemory.set(key, idx);
  return arr[idx];
}

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

const SUMMARY_CLOSERS = [
  "Continued skilled PT remains indicated to progress POC and support functional carryover to ADLs.",
  "Continued skilled PT remains indicated to address impairments and promote safe mobility to meet goals.",
  "Continued skilled PT remains indicated to improve strength, ROM, and functional tolerance for PLOF.",
  "Continued skilled PT remains indicated to reduce fall/injury risk and improve safe functional independence.",
  "Continued skilled PT remains indicated to advance therapeutic progression and optimize functional outcomes.",
];

const OT_SUMMARY_CLOSERS = [
  "Continued skilled OT remains indicated to progress POC and support functional carryover to ADLs.",
  "Continued skilled OT remains indicated to address impairments and promote safe performance of ADLs/IADLs to meet goals.",
  "Continued skilled OT remains indicated to improve UE function, coordination, and task tolerance for ADLs and PLOF.",
  "Continued skilled OT remains indicated to reduce fall/injury risk and improve safe functional independence.",
  "Continued skilled OT remains indicated to advance therapeutic progression and optimize functional outcomes.",
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

const OT_POC_OPENERS = [
  "Continue to focus on",
  "Plan to progress",
  "Continue skilled OT emphasizing",
  "Continue with a focus on",
  "Proceed with ongoing skilled OT targeting",
  "Maintain POC with emphasis on",
  "Continue intervention focus on",
  "Advance POC with continued emphasis on",
];

function pickIntroPrefix(patientLabel) {
  return pickForPatient(`${patientLabel}::intro`, SUMMARY_INTRO_PREFIXES);
}

function pickCloser(patientLabel) {
  return pickForPatient(`${patientLabel}::closePT`, SUMMARY_CLOSERS);
}

function pickPocOpener(patientLabel) {
  return pickForPatient(`${patientLabel}::pocPT`, POC_OPENERS);
}

function pickCloserForDiscipline(patientLabel, discipline) {
  return discipline === "OT"
  ? pickForPatient(`${patientLabel}::closeOT`, OT_SUMMARY_CLOSERS)
  : pickForPatient(`${patientLabel}::closePT`, SUMMARY_CLOSERS);
}

function pickPocOpenerForDiscipline(patientLabel, discipline) {
  return discipline === "OT"
  ? pickForPatient(`${patientLabel}::pocOT`, OT_POC_OPENERS)
  : pickForPatient(`${patientLabel}::pocPT`, POC_OPENERS);
}

// ---------------- Parsing / Counting helpers ----------------

function splitSections(text) {
  const t = String(text || "").trim();
  
  // Expect:
  // Subjective\n
  // <line>\n
  // \n
  // Summary\n
  // <multi>\n
  // \n
  // POC\n
  // <one line>
  const re =
  /^Subjective\s*\n([\s\S]*?)\n\nSummary\s*\n([\s\S]*?)\n\nPOC\s*\n([\s\S]*?)$/;
  
  const m = t.match(re);
  if (!m) return null;
  
  const subjective = m[1].trim();
  const summary = m[2].trim();
  const poc = m[3].trim();
  
  if (!subjective || !summary || !poc) return null;
  return { subjective, summary, poc };
}

function countSentences(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length;
}

function containsArrows(text) {
  return /[↑↓]/.test(String(text || ""));
}

function hasBulletsOrNumbering(text) {
  const t = String(text || "");
  return /^\s*[-*•]\s+/m.test(t) || /^\s*\d+\.\s+/m.test(t);
}

function hasBannedGenericSummaryStart(summary) {
  const s = String(summary || "").trim().toLowerCase();
  return (
          s.startsWith("pt demonstrates good engagement") ||
          s.startsWith("pt tolerated treatment well") ||
          s.startsWith("rom showed slight improvement") ||
          s.startsWith("pain levels remained manageable")
          );
}

function normalizeNewlines(text) {
  return String(text || "")
  .replace(/\r\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}

// ---------------- Rules ----------------

const SUBJECTIVE_STARTERS = [
  "Pt reports",
  "Pt states",
  "Pt notes",
  "Pt c/o",
  "Pt denies",
  "Pt agrees",
  "Pt confirms",
];

function buildGeneratePrompt({
  patientLabel,
  userText,
  introPrefix,
  closerSentence,
  pocOpener,
  discipline,
}) {
  return `
Write a ${discipline} visit note with EXACTLY 3 sections in this order:

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
- No bullets or numbering anywhere.
- Do not output any extra text before Subjective or after POC.

SUBJECTIVE RULES:
- Exactly ONE sentence.
- Must be patient-reported only.
- Must start with one of: ${SUBJECTIVE_STARTERS.join(", ")}.
- Must NOT say "tolerates tx well" or include objective measures.

SUMMARY RULES:
- Exactly 5 to 7 sentences.
- No arrows (↑ ↓).
- Use abbrev where appropriate.
- Do NOT start the Summary with generic banned openers (e.g. "Pt tolerated treatment well").
- FIRST Summary sentence MUST start EXACTLY with this prefix (copy it verbatim):
  ${introPrefix}
- LAST Summary sentence MUST be EXACTLY this sentence (copy it verbatim, do not alter):
  ${closerSentence}

POC RULES:
- POC must be ONE line only.
- Must start with: "${discipline === "OT" ? "OT POC:" : "PT POC:"}"
- Must use this exact opener immediately after header (do not change): "${pocOpener}"
- Must include ALL required elements and end with "to meet goals."
- Required POC content:
  ${
    discipline === "OT"
      ? "TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals."
      : "TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals."
  }

No-hallucination:
- Only use details explicitly present in user instruction; no new numbers/devices/vitals/diagnoses.

User instruction (only source of truth):
${userText}

Patient label:
${patientLabel}
`.trim();
}

function buildRepairPrompt({
  patientLabel,
  userText,
  badOutput,
  introPrefix,
  closerSentence,
  pocOpener,
  discipline,
}) {
  return `
You must FIX the note to comply with ALL constraints. Do not add facts.

Return ONLY the corrected note with EXACTLY 3 sections:
Subjective
Summary
POC

Constraints to enforce:
- Subjective: ONE sentence, patient-reported only, must start with one of:
  ${SUBJECTIVE_STARTERS.join(", ")}
- Summary: 5-7 sentences, no arrows, no bullets/numbering, first Summary sentence must start with:
  ${introPrefix}
- Summary last sentence MUST be exactly:
  ${closerSentence}
- POC: ONE line, must be exactly:
  ${
    discipline === "OT"
      ? ("OT POC: " +
        pocOpener +
        " TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals.")
      : ("PT POC: " +
        pocOpener +
        " TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.")
  }

No-hallucination:
- Only use details explicitly present in user instruction; no new facts.

User instruction:
${userText}

Bad output to fix:
${badOutput}

Now output the corrected note only.
`.trim();
}

// ---------------- Validation ----------------

function validateGenerated({ text, introPrefix, closerSentence, pocOpener, discipline }) {
  const sections = splitSections(text);
  if (!sections)
    return {
      ok: false,
    reason:
      "Could not parse 3 sections (Subjective/Summary/POC) with required spacing.",
    };
  
  const { subjective, summary, poc } = sections;
  
  // Subjective: 1 sentence, allowed starter, no objective-ish "tolerates tx well"
  if (countSentences(subjective) !== 1)
    return { ok: false, reason: "Subjective must be exactly 1 sentence." };
  
  const starterOk = SUBJECTIVE_STARTERS.some((s) => subjective.startsWith(s));
  if (!starterOk)
    return { ok: false, reason: "Subjective must start with an allowed starter." };
  
  if (/tolerates?\s+tx\s+well/i.test(subjective))
    return { ok: false, reason: 'Subjective must not say "tolerates tx well".' };
  
  // Summary: 5-7 sentences, no arrows, intro
  const sumCount = countSentences(summary);
  if (sumCount < 5 || sumCount > 7)
    return { ok: false, reason: "Summary must be 5 to 7 sentences." };
  
  if (containsArrows(summary))
    return { ok: false, reason: "Summary must not contain arrows (↑/↓)." };
  
  if (hasBulletsOrNumbering(summary))
    return { ok: false, reason: "Summary must not contain bullets/numbering." };
  
  if (hasBannedGenericSummaryStart(summary))
    return { ok: false, reason: "Summary starts with a banned generic opener." };
  
  if (!summary.startsWith(introPrefix))
    return {
      ok: false,
      reason: "First Summary sentence must start with required intro prefix.",
    };
  
  const last = getLastSentence(summary);
  if (last !== closerSentence)
    return { ok: false, reason: "Summary must end with exact required closing sentence." };
  
  if (!includesExactClosingPhrase(last, discipline))
    return { ok: false, reason: "Summary must end with required closing phrase." };
  
  // POC must be one line and match expected
  if (!isSingleLine(poc)) return { ok: false, reason: "POC must be one line." };
  
  const expectedPoc =
  discipline === "OT"
  ? `OT POC: ${pocOpener} TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals.`
  : `PT POC: ${pocOpener} TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.`;
  
  if (poc !== expectedPoc)
    return {
      ok: false,
      reason: `POC must match exact template.\nExpected: ${expectedPoc}\nGot: ${poc}`,
    };
  
  return { ok: true };
}

// ---------------- Routes ----------------

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/debug-env", (req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    keyPresent: OPENAI_API_KEY && OPENAI_API_KEY.startsWith("sk-"),
  });
});

// Optional helper: clean user input conservatively (not required by your iOS client)
app.post("/clean", async (req, res) => {
  try {
    const raw = String(req.body?.text || "");
    const locallyCleaned = normalizeSpaces(cleanUserText(raw));
    
    // If you want pure local clean, return here:
    // return res.json({ cleaned: locallyCleaned });
    
    const prompt = `Clean this note text conservatively:
- Remove obvious duplication
- Normalize spacing
- Do not add facts
Return only the cleaned text.

TEXT:
${locallyCleaned}`.trim();
    
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.15,
      messages: [
        { role: "system", content: "You rewrite text conservatively without adding facts." },
        { role: "user", content: prompt },
      ],
    });
    
    const cleaned =
    completion.choices?.[0]?.message?.content?.trim() || locallyCleaned;
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
    
    // Discipline (PT/OT) + rotate intro/closer/poc opener server-side (reliably varied)
    const disciplineRaw = String(req.body?.discipline || "PT").toUpperCase().trim();
    const discipline = disciplineRaw === "OT" ? "OT" : "PT";
    
    const introPrefix = pickIntroPrefix(patientLabel);
    const closerSentence = pickCloserForDiscipline(patientLabel, discipline);
    const pocOpener = pickPocOpenerForDiscipline(patientLabel, discipline);
    
    const prompt = buildGeneratePrompt({
      patientLabel,
      userText,
      introPrefix,
      closerSentence,
      pocOpener,
      discipline,
    });
    
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Follow formatting rules exactly. Do not add facts. Output only the note." },
        { role: "user", content: prompt },
      ],
    });
    
    let out = normalizeNewlines(completion.choices?.[0]?.message?.content || "");
    
    // Validate; if fails, attempt one repair pass
    const v1 = validateGenerated({ text: out, introPrefix, closerSentence, pocOpener, discipline });
    if (!v1.ok) {
      const repairPrompt = buildRepairPrompt({
        patientLabel,
        userText,
        badOutput: out,
        introPrefix,
        closerSentence,
        pocOpener,
        discipline,
      });
      
      const repair = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Fix formatting strictly. Do not add facts. Output only the corrected note." },
          { role: "user", content: repairPrompt },
        ],
      });
      
      const repaired = normalizeNewlines(repair.choices?.[0]?.message?.content || "");
      const v2 = validateGenerated({ text: repaired, introPrefix, closerSentence, pocOpener, discipline });
      
      if (!v2.ok) {
        return res.status(422).json({
          error: "Model output failed validation after repair.",
          reason1: v1.reason,
          reason2: v2.reason,
          raw: repaired || out,
        });
      }
      
      return res.json({ summary: repaired });
    }
    
    return res.json({ summary: out });
  } catch (err) {
    console.error("❌ /generate failed");
    console.error(err?.status, err?.message || err);
    return res.status(500).json({
      error: "Generate failed.",
      details: err?.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
});
