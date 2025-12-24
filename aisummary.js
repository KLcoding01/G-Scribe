// ======================= aisummary.js (PART 1/2) =======================
// Express routes for PT/OT diffdx, summary, goals
//
// Endpoints (POST):
//  - /pt_generate_diffdx
//  - /pt_generate_summary
//  - /pt_generate_goals
//  - /ot_generate_diffdx
//  - /ot_generate_summary
//  - /ot_generate_goals
//
// Request JSON:
//  { fields: { ... }, summary_type?: "Evaluation"|"Progress Note"|"Discharge" }
//
// Response JSON:
//  { result: "..." }
//
// ENV:
//  OPENAI_API_KEY (required)
//  OPENAI_MODEL (optional, default gpt-4o-mini)
//  AI_API_KEY (optional, if you enable header auth below)

import express from "express";
import OpenAI from "openai";

const router = express.Router();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// --------------------------------------------------
// Optional header auth
// --------------------------------------------------

const REQUIRE_API_KEY = !!process.env.AI_API_KEY;
const AI_API_KEY = process.env.AI_API_KEY || "";

function requireKey(req, res, next) {
  if (!REQUIRE_API_KEY) return next();
  const got = req.header("X-API-Key") || "";
  if (!got || got !== AI_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.use(requireKey);

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY missing. AI routes will fail.");
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// --------------------------------------------------
// Utilities
// --------------------------------------------------

function safeStr(v) {
  return (v ?? "").toString().trim();
}

function normalizeNewlines(s) {
  return safeStr(s)
  .replace(/\r\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}

function hasBannedThirdPersonRef(text) {
  // Ban "The patient" and third-person pronouns anywhere in AI outputs
  return /\b(the patient|they|their|them|theirs|themselves)\b/i.test(
                                                                     String(text || "")
                                                                     );
}

function containsArrows(text) {
  return /[↑↓]/.test(String(text || ""));
}

function hasBulletsOrNumbering(text) {
  const t = String(text || "");
  return /^\s*[-*•]\s+/m.test(t) || /^\s*\d+\.\s+/m.test(t);
}

/**
 * Strip dictation lead-ins globally
 * Ensures PMH / meds / dx dictation transfers cleanly
 */
function normalizeDictation(text) {
  let t = safeStr(text);
  
  const patterns = [
    /^(past medical history|medical history|pmh)\s*(consists of|includes|is)?/i,
    /^(medications?|current medications?)\s*(include|are|consist of)?/i,
    /^(medical diagnosis|diagnosis)\s*(is|includes)?/i,
    /^(subjective|pt reports|pt states)\s*/i,
    /^(pain)\s*(is|located at|located in)?/i,
  ];
  
  for (const p of patterns) t = t.replace(p, "");
  
  return t.replace(/^[:\-–]\s*/, "").trim();
}

/**
 * Normalize all incoming fields once.
 * Also harmonizes snake_case + camelCase by setting BOTH aliases.
 */
function normalizeFields(fields = {}) {
  const raw = fields && typeof fields === "object" ? fields : {};
  const out = {};
  
  // 1) normalize existing keys
  for (const k of Object.keys(raw)) out[k] = normalizeDictation(raw[k]);
  
  // 2) harmonize common aliases used by Swift/Flask/templates
  const aliasPairs = [
    ["pain_location", "painLocation"],
    ["pain_onset", "painOnset"],
    ["pain_condition", "painCondition"],
    ["pain_mechanism", "painMechanism"],
    ["pain_rating", "painRating"],
    ["pain_frequency", "painFrequency"],
    ["pain_description", "painDescription"],
    ["pain_aggravating", "painAggravating"],
    ["pain_relieved", "painRelieved"],
    ["pain_interferes", "painInterferes"],
    ["bmi_category", "bmiCategory"],
    ["meddiag", "meddiag"], // keep
    ["history", "history"],
    ["subjective", "subjective"],
    ["meds", "meds"],
  ];
  
  for (const [snake, camel] of aliasPairs) {
    const sVal = safeStr(out[snake]);
    const cVal = safeStr(out[camel]);
    if (!sVal && cVal) out[snake] = cVal;
    if (!cVal && sVal) out[camel] = sVal;
  }
  
  return out;
}

function computeAge(dobRaw, fallbackAge = "X") {
  const dob = safeStr(dobRaw);
  if (!dob) return fallbackAge;
  
  // Accept yyyy-mm-dd, mm/dd/yyyy, mm-dd-yyyy
  const m =
  dob.match(/^(\d{4})-(\d{2})-(\d{2})$/) ||
  dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) ||
  dob.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  
  if (!m) return fallbackAge;
  
  // If yyyy-mm-dd: m[1]=yyyy, m[2]=mm, m[3]=dd
  // If mm/dd/yyyy or mm-dd-yyyy: m[1]=mm, m[2]=dd, m[3]=yyyy
  const isISO = /^\d{4}-/.test(dob);
  const year = isISO ? +m[1] : +m[3];
  const month = (isISO ? +m[2] : +m[1]) - 1;
  const day = isISO ? +m[3] : +m[2];
  
  const dt = new Date(year, month, day);
  const today = new Date();
  
  let age = today.getFullYear() - dt.getFullYear();
  if (
      today.getMonth() < dt.getMonth() ||
      (today.getMonth() === dt.getMonth() && today.getDate() < dt.getDate())
      ) {
        age--;
      }
  return String(age);
}

function buildPainLine(f) {
  // supports snake + camel
  const pairs = [
    ["Area/Location", f.pain_location || f.painLocation],
    ["Onset", f.pain_onset || f.painOnset],
    ["Condition", f.pain_condition || f.painCondition],
    ["Mechanism", f.pain_mechanism || f.painMechanism],
    ["Rating", f.pain_rating || f.painRating],
    ["Frequency", f.pain_frequency || f.painFrequency],
    ["Description", f.pain_description || f.painDescription],
    ["Aggravating", f.pain_aggravating || f.painAggravating],
    ["Relieved", f.pain_relieved || f.painRelieved],
    ["Interferes", f.pain_interferes || f.painInterferes],
  ];
  
  return pairs
  .map(([lbl, val]) => {
    const v = safeStr(val);
    return v ? `${lbl}: ${v}` : "";
  })
  .filter(Boolean)
  .join("; ");
}

/**
 * SOAP Assessment builder (kept stable)
 * Matches your Swift relocation logic keys:
 *  Soap Assessment:
 *  Pain Location:
 *  ROM:
 *  Palpation:
 *  Functional Test(s):
 *  Goals:
 */
function buildSoapAssessment(f) {
  const painLoc = safeStr(f.pain_location || f.painLocation);
  const painRating = safeStr(f.pain_rating || f.painRating);
  const painLine = painLoc
  ? painRating
  ? `${painLoc}: ${painRating}`
  : painLoc
  : "N/A";
  
  return normalizeNewlines(
                           [
                             "Soap Assessment:",
                             "",
                             "Pain Location:",
                             painLine || "N/A",
                             "",
                             "ROM:",
                             safeStr(f.rom) || "N/A",
                             "",
                             "Palpation:",
                             safeStr(f.palpation) || "N/A",
                             "",
                             "Functional Test(s):",
                             safeStr(f.functional) || "N/A",
                             "",
                             "Goals:",
                             safeStr(f.goals) || "N/A",
                           ].join("\n")
                           );
}

async function gptCall(prompt, maxTokens = 500) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured.");
  
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
      content:
        "You are a clinical documentation assistant for rehab clinicians. " +
        "Use abbreviations where appropriate. Always refer to the person as 'Pt' (never 'the patient' or they/their). " +
        "No bullets/numbering. No arrows (↑ ↓). Medicare-compliant. Do not invent facts.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  });
  
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

async function enforceCleanOutputOrRepair({
  text,
  purpose,
  maxTokens = 350,
}) {
  const raw = safeStr(text);
  if (!raw) return raw;
  
  const violates =
  hasBannedThirdPersonRef(raw) || containsArrows(raw) || hasBulletsOrNumbering(raw);
  
  if (!violates) return raw;
  
  const repairPrompt = `
Fix this ${purpose} text to comply:
- Use "Pt" only. Do NOT use "the patient" or they/their/them/theirs/themselves.
- No bullets/numbering
- No arrows (↑ ↓)
- Do not add facts
Return corrected text only.

Bad text:
${raw}
`.trim();
  
  const repaired = await gptCall(repairPrompt, maxTokens);
  return safeStr(repaired) || raw;
}

function jsonError(res, status, msg, detail) {
  return res.status(status).json({ error: msg, detail });
}

function normalizeSummaryType(x) {
  const s = safeStr(x || "Evaluation").toLowerCase();
  if (s.includes("progress")) return "Progress Note";
  if (s.includes("discharge")) return "Discharge";
  return "Evaluation";
}
// ======================= aisummary.js (PART 2/2) =======================

// --------------------------------------------------
// PT ROUTES
// --------------------------------------------------

router.post("/pt_generate_diffdx", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const pain = buildPainLine(f);
    
    const prompt =
    "You are a PT clinical assistant. Based on the evaluation details below, " +
    "provide a concise PT differential diagnosis (3–6 items) in ONE paragraph separated by semicolons. " +
    "Do NOT state as confirmed diagnosis; use language such as 'findings are consistent with / suggestive of'. " +
    "No bullets.\n\n" +
    `Subjective:\n${safeStr(f.subjective) || "N/A"}\n\n` +
    `Pain:\n${pain || "N/A"}\n\n` +
    `Objective:\nROM: ${safeStr(f.rom) || "N/A"}\nStrength: ${safeStr(f.strength) || "N/A"}\nPosture: ${safeStr(f.posture) || "N/A"}\n` +
    `Functional: ${safeStr(f.functional) || "N/A"}\n`;
    
    const draft = await gptCall(prompt, 280);
    const result = await enforceCleanOutputOrRepair({
      text: draft,
      purpose: "PT differential dx",
      maxTokens: 220,
    });
    
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_diffdx failed", e?.message || e);
  }
});

router.post("/pt_generate_summary", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const summaryType = normalizeSummaryType(req.body?.summary_type);
    
    const name =
    safeStr(f.name) ||
    safeStr(f.pt_patient_name) ||
    safeStr(f.patient_name) ||
    safeStr(f.full_name) ||
    "Pt";
    
    const age = computeAge(f.dob, f.age || "X");
    const gender = safeStr(f.gender || "patient").toLowerCase();
    const pmh = safeStr(f.history) || "no significant history";
    const meds = safeStr(f.meds) || "N/A";
    const today = safeStr(f.currentdate) || new Date().toLocaleDateString("en-US");
    
    let prompt = "";
    
    if (summaryType === "Evaluation") {
      prompt =
      "Generate a concise 7–8 sentence PT evaluation assessment summary that is Medicare compliant. " +
      "No bullets. No arrows. Do not use 'the patient' or third-person pronouns.\n\n" +
      `Start with EXACTLY: "${name}, a ${age} y/o ${gender} with PMH of ${pmh}."\n` +
      `Include PT eval on ${today}. Primary complaint: ${safeStr(f.subjective) || "N/A"}. ` +
      `Meds: ${meds}. Referring dx: ${safeStr(f.meddiag) || "N/A"}. ` +
      `Summarize impairments (ROM: ${safeStr(f.rom) || "N/A"}; strength: ${safeStr(f.strength) || "N/A"}; posture: ${safeStr(f.posture) || "N/A"}). ` +
      `Summarize functional limitations: ${safeStr(f.functional) || "N/A"}. ` +
      "End by stating continued skilled PT is medically necessary to progress toward PLOF.";
    } else if (summaryType === "Progress Note") {
      prompt =
      "Generate a concise 5–7 sentence PT progress note summary that is Medicare compliant. " +
      "No bullets. No arrows. Use 'Pt' only.\n\n" +
      `Context: ${safeStr(f.subjective) || "N/A"}\n` +
      `Objective cues: ROM: ${safeStr(f.rom) || "N/A"}; strength: ${safeStr(f.strength) || "N/A"}; functional: ${safeStr(f.functional) || "N/A"}.\n` +
      "Include progress/tolerance and continued need for skilled PT per POC.";
    } else {
      prompt =
      "Generate a concise 5–7 sentence PT discharge summary that is Medicare compliant. " +
      "No bullets. No arrows. Use 'Pt' only.\n\n" +
      `Discharge context: ${safeStr(f.subjective) || "N/A"}\n` +
      `Functional status: ${safeStr(f.functional) || "N/A"}; remaining impairments: ${safeStr(f.impairments) || "N/A"}.\n` +
      "Include current status, goal status (met/partially met if supported), HEP and follow-up recommendations without inventing facts.";
    }
    
    const narrativeDraft = await gptCall(prompt, 520);
    const narrative = await enforceCleanOutputOrRepair({
      text: narrativeDraft,
      purpose: "PT summary",
      maxTokens: 420,
    });
    
    // ✅ Append SOAP block (your Swift can relocate it if needed)
    const soap = buildSoapAssessment(f);
    
    return res.json({ result: `${narrative}\n\n${soap}`.trim() });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_summary failed", e?.message || e);
  }
});

router.post("/pt_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const prompt = `
You are a clinical assistant helping a Physical Therapist write documentation.

Use ONLY the info below. Do NOT invent details.
No bullets/numbering in free text beyond the required numbered goal lines.
Do NOT use third-person pronouns; use "Pt" only.

Diagnosis/Region: ${safeStr(f.meddiag) || safeStr(f.pain_location || f.painLocation) || "N/A"}
Strength: ${safeStr(f.strength) || "N/A"}
ROM: ${safeStr(f.rom) || "N/A"}
Impairments: ${safeStr(f.impairments) || "N/A"}
Functional Limitations: ${safeStr(f.functional) || "N/A"}

ALWAYS follow this EXACT format. Do NOT add or remove any sections.

Short-Term Goals (1–12 visits):
1. Pt will report pain ≤[target]/10 during [functional activity].
2. Pt will improve [objective finding] by ≥[measurable amount] to allow [activity].
3. Pt will demonstrate ≥[percent]% adherence to HEP during ADLs.
4. Pt will perform transfers or mobility with [level of independence] to support function.

Long-Term Goals (13–25 visits):
1. Pt will increase strength of 1 grade or higher or functional capacity to safely perform ADLs.
2. Pt will restore AROM to WNL to enable daily activities.
3. Pt will demonstrate independence with HEP to prevent reinjury.
4. Pt will self report resume PLOF with minimal or no symptoms.
`.trim();
    
    const draft = await gptCall(prompt, 450);
    const result = await enforceCleanOutputOrRepair({
      text: draft,
      purpose: "PT goals",
      maxTokens: 420,
    });
    
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_goals failed", e?.message || e);
  }
});

// --------------------------------------------------
// OT ROUTES
// --------------------------------------------------

router.post("/ot_generate_diffdx", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const pain = buildPainLine(f);
    
    const prompt =
    "You are an OT clinical assistant. Based on the evaluation details below, " +
    "provide a concise OT differential considerations list (3–6 items) in ONE paragraph separated by semicolons. " +
    "Use non-diagnostic language ('findings are consistent with / suggestive of'). No bullets.\n\n" +
    `Subjective:\n${safeStr(f.subjective) || safeStr(f.summary) || "N/A"}\n\n` +
    `Pain:\n${pain || "N/A"}\n\n` +
    `Objective:\nROM: ${safeStr(f.rom) || "N/A"}\nStrength: ${safeStr(f.strength) || "N/A"}\n` +
    `Functional (ADLs/IADLs): ${safeStr(f.functional) || "N/A"}\n` +
    `Impairments: ${safeStr(f.impairments) || "N/A"}\n`;
    
    const draft = await gptCall(prompt, 280);
    const result = await enforceCleanOutputOrRepair({
      text: draft,
      purpose: "OT differential dx",
      maxTokens: 220,
    });
    
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_diffdx failed", e?.message || e);
  }
});

router.post("/ot_generate_summary", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const summaryType = normalizeSummaryType(req.body?.summary_type);
    
    const name =
    safeStr(f.name) ||
    safeStr(f.ot_patient_name) ||
    safeStr(f.patient_name) ||
    safeStr(f.full_name) ||
    "Pt";
    
    const age = computeAge(f.dob, f.age || "X");
    const gender = safeStr(f.gender || "patient").toLowerCase();
    const pmh = safeStr(f.history) || "no significant history";
    const meds = safeStr(f.meds) || "N/A";
    const today = safeStr(f.currentdate) || new Date().toLocaleDateString("en-US");
    
    let prompt = "";
    
    if (summaryType === "Evaluation") {
      prompt =
      "Generate a concise 7–8 sentence OT evaluation assessment summary that is Medicare compliant. " +
      "No bullets. No arrows. Use 'Pt' only.\n\n" +
      `Start with EXACTLY: "${name}, a ${age} y/o ${gender} with PMH of ${pmh}."\n` +
      `Include OT eval on ${today}. Primary complaint: ${safeStr(f.subjective) || safeStr(f.summary) || "N/A"}. ` +
      `Meds: ${meds}. Referring dx: ${safeStr(f.meddiag) || "N/A"}. ` +
      `Summarize UE function/ROM/strength if provided (ROM: ${safeStr(f.rom) || "N/A"}; strength: ${safeStr(f.strength) || "N/A"}). ` +
      `Summarize ADL/IADL limitations: ${safeStr(f.functional) || "N/A"}. ` +
      "End by stating continued skilled OT is medically necessary to improve safety and independence with ADLs/IADLs.";
    } else if (summaryType === "Progress Note") {
      prompt =
      "Generate a concise 5–7 sentence OT progress note summary that is Medicare compliant. " +
      "No bullets. No arrows. Use 'Pt' only.\n\n" +
      `Context: ${safeStr(f.subjective) || safeStr(f.summary) || "N/A"}\n` +
      `Objective cues: ROM: ${safeStr(f.rom) || "N/A"}; strength: ${safeStr(f.strength) || "N/A"}; ADL/IADL function: ${safeStr(f.functional) || "N/A"}.\n` +
      "Include progress/tolerance and continued need for skilled OT per POC.";
    } else {
      prompt =
      "Generate a concise 5–7 sentence OT discharge summary that is Medicare compliant. " +
      "No bullets. No arrows. Use 'Pt' only.\n\n" +
      `Discharge context: ${safeStr(f.subjective) || safeStr(f.summary) || "N/A"}\n` +
      `Functional status (ADLs/IADLs): ${safeStr(f.functional) || "N/A"}; remaining impairments: ${safeStr(f.impairments) || "N/A"}.\n` +
      "Include current status, HEP/strategy carryover, and follow-up recommendations without inventing facts.";
    }
    
    const narrativeDraft = await gptCall(prompt, 520);
    const narrative = await enforceCleanOutputOrRepair({
      text: narrativeDraft,
      purpose: "OT summary",
      maxTokens: 420,
    });
    
    // SOAP block is still useful for your Swift relocation logic (even if OT)
    const soap = buildSoapAssessment(f);
    
    return res.json({ result: `${narrative}\n\n${soap}`.trim() });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_summary failed", e?.message || e);
  }
});

router.post("/ot_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const summary = safeStr(f.summary) || safeStr(f.subjective) || "N/A";
    
    const prompt = `
You are a clinical assistant helping an occupational therapist write documentation.

Below is the patient's evaluation data. Use ONLY this information.
Do NOT invent details. Do NOT use third-person pronouns.
Always refer to the person as "Pt".

Evaluation Summary:
${summary}

Pain:
${safeStr(f.pain_location || f.painLocation) || "N/A"}

ROM:
${safeStr(f.rom) || "N/A"}

Strength:
${safeStr(f.strength) || "N/A"}

Impairments:
${safeStr(f.impairments) || "N/A"}

Functional Limitations (ADLs/IADLs):
${safeStr(f.functional) || "N/A"}

Generate Medicare-compliant OT goals using EXACTLY the following structure.
Do NOT add or remove sections or lines.

Short-Term Goals (1–12 visits):
1. Pt will perform [specific ADL/IADL] with [level of assistance or AE] to improve functional independence.
2. Pt will improve [ROM/strength/endurance] by [measurable amount] to support safe task performance.
3. Pt will demonstrate improved activity tolerance during [task] with appropriate pacing or strategy use.
4. Pt will report pain ≤[target]/10 during completion of [functional task].

Long-Term Goals (13–25 visits):
1. Pt will independently perform ADLs/IADLs using learned strategies or AE as needed.
2. Pt will demonstrate safe completion of [home/community task] without increased symptoms.
3. Pt will tolerate ≥[time] of functional activity to support daily routines.
4. Pt will independently manage HEP and compensatory strategies to maintain functional gains.
`.trim();
    
    const draft = await gptCall(prompt, 450);
    const result = await enforceCleanOutputOrRepair({
      text: draft,
      purpose: "OT goals",
      maxTokens: 420,
    });
    
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_goals failed", e?.message || e);
  }
});

// --------------------------------------------------
// EXPORT ROUTER
// --------------------------------------------------

export default router;
