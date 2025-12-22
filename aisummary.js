// aisummary.js
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

const openai = OPENAI_API_KEY
? new OpenAI({ apiKey: OPENAI_API_KEY })
: null;

// --------------------------------------------------
// Utilities
// --------------------------------------------------

function safeStr(v) {
  return (v ?? "").toString().trim();
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
  
  for (const p of patterns) {
    t = t.replace(p, "");
  }
  
  return t.replace(/^[:\-–]\s*/, "").trim();
}

/**
 * Normalize all incoming fields once
 */
function normalizeFields(fields = {}) {
  const out = {};
  for (const k of Object.keys(fields)) {
    out[k] = normalizeDictation(fields[k]);
  }
  return out;
}

function computeAge(dobRaw, fallbackAge = "X") {
  const dob = safeStr(dobRaw);
  if (!dob) return fallbackAge;
  
  let m =
  dob.match(/^(\d{4})-(\d{2})-(\d{2})$/) ||
  dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) ||
  dob.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  
  if (!m) return fallbackAge;
  
  const year = +m[3];
  const month = +m[1] - 1;
  const day = +m[2];
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
  const pairs = [
    ["Area/Location", "pain_location"],
    ["Onset", "pain_onset"],
    ["Condition", "pain_condition"],
    ["Mechanism", "pain_mechanism"],
    ["Rating", "pain_rating"],
    ["Frequency", "pain_frequency"],
    ["Description", "pain_description"],
    ["Aggravating", "pain_aggravating"],
    ["Relieved", "pain_relieved"],
    ["Interferes", "pain_interferes"],
  ];
  
  return pairs
  .map(([lbl, key]) => `${lbl}: ${safeStr(f[key])}`)
  .filter((s) => !s.endsWith(":"))
  .join("; ");
}

/**
 * SOAP Assessment builder
 * Mirrors Python export format exactly
 */
function buildSoapAssessment(f) {
  return (
          "Soap Assessment:\n\n" +
          "Pain Location:\n" +
          `${safeStr(f.pain_location)}${f.pain_rating ? ": " + f.pain_rating : ""}\n\n` +
          "ROM:\n" +
          `${safeStr(f.rom)}\n\n` +
          "Palpation:\n" +
          `${safeStr(f.palpation)}\n\n` +
          "Functional Test(s):\n" +
          `${safeStr(f.functional)}\n\n` +
          "Goals:\n" +
          `${safeStr(f.goals)}`
          ).trim();
}

async function gptCall(prompt, maxTokens = 500) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured.");
  
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
      content:
        "You are a clinical documentation assistant for rehab clinicians. Use abbreviations only. Never say 'the patient'. Be Medicare compliant.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  });
  
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

function jsonError(res, status, msg, detail) {
  return res.status(status).json({ error: msg, detail });
}
// --------------------------------------------------
// PT ROUTES
// --------------------------------------------------

router.post("/pt_generate_diffdx", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const pain = buildPainLine(f);
    
    const prompt =
    "You are a PT clinical assistant. Based on the following evaluation details, " +
    "provide a concise PT differential diagnosis. " +
    "Do NOT state as fact or as a medical diagnosis—use language such as " +
    "'symptoms and clinical findings are consistent with or associated with'.\n\n" +
    `Subjective:\n${f.subjective}\n\n` +
    `Pain:\n${pain}\n\n` +
    `Objective:\nROM: ${f.rom}\nStrength: ${f.strength}\nPosture: ${f.posture}`;
    
    const result = await gptCall(prompt, 250);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_diffdx failed", e?.message || e);
  }
});

// --------------------------------------------------
// PT SUMMARY
// --------------------------------------------------

router.post("/pt_generate_summary", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const summaryType = safeStr(req.body?.summary_type || "Evaluation");
    
    const name =
    f.name ||
    f.pt_patient_name ||
    f.patient_name ||
    f.full_name ||
    "Pt";
    
    const age = computeAge(f.dob, f.age);
    const gender = (f.gender || "patient").toLowerCase();
    const pmh = f.history || "no significant history";
    const meds = f.meds || "N/A";
    const today = f.currentdate || new Date().toLocaleDateString("en-US");
    
    let prompt = "";
    
    if (summaryType === "Evaluation") {
      prompt =
      "Generate a concise 7–8 sentence Physical Therapy assessment summary that is Medicare compliant. " +
      "Use abbreviations only. Never use 'the patient' or third-person pronouns.\n" +
      `Start with: "${name}, a ${age} y/o ${gender} with PMH of ${pmh}."\n` +
      `Include PT eval on ${today} for ${f.subjective}. ` +
      `Medications: ${meds}. ` +
      `Symptoms are associated with referring dx ${f.meddiag}. ` +
      `Summarize impairments (ROM: ${f.rom}; strength: ${f.strength}). ` +
      `Summarize functional limitations: ${f.functional}. ` +
      "End stating continued skilled PT is medically necessary to return to PLOF.";
    }
    
    const narrative = await gptCall(prompt, 500);
    const soap = buildSoapAssessment(f);
    
    return res.json({
      result: `${narrative}\n\n${soap}`,
    });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_summary failed", e?.message || e);
  }
});

// --------------------------------------------------
// PT GOALS
// --------------------------------------------------

router.post("/pt_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const prompt = `
You are a clinical assistant helping a Physical Therapist write documentation.

Diagnosis/Region: ${f.meddiag || f.pain_location}
Strength: ${f.strength}
ROM: ${f.rom}
Impairments: ${f.impairments}
Functional Limitations: ${f.functional}

Using ONLY the above provided evaluation info, generate Medicare-compliant PT goals.
ALWAYS follow this EXACT format. Do NOT add or remove any sections.

Short-Term Goals (1–12 visits):
1. Pt will report pain ≤[target]/10 during [functional activity].
2. Pt will improve [objective finding] by ≥[measurable amount] to allow [activity].
3. Pt will demonstrate ≥[percent]% adherence to HEP during ADLs.
4. Pt will perform transfers or mobility with [level of independence] to support function.

Long-Term Goals (13–25 visits):
1. Pt will increase strength or functional capacity to safely perform ADLs.
2. Pt will restore ROM to within functional limits to enable daily activities.
3. Pt will demonstrate independence with HEP to prevent reinjury.
4. Pt will resume PLOF with minimal or no symptoms.
`.trim();
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_goals failed", e?.message || e);
  }
});
// --------------------------------------------------
// PT ROUTES
// --------------------------------------------------

router.post("/pt_generate_diffdx", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const pain = buildPainLine(f);
    
    const prompt =
    "You are a PT clinical assistant. Based on the following evaluation details, " +
    "provide a concise PT differential diagnosis. " +
    "Do NOT state as fact or as a medical diagnosis—use language such as " +
    "'symptoms and clinical findings are consistent with or associated with'.\n\n" +
    `Subjective:\n${f.subjective}\n\n` +
    `Pain:\n${pain}\n\n` +
    `Objective:\nROM: ${f.rom}\nStrength: ${f.strength}\nPosture: ${f.posture}`;
    
    const result = await gptCall(prompt, 250);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_diffdx failed", e?.message || e);
  }
});

// --------------------------------------------------
// PT SUMMARY
// --------------------------------------------------

router.post("/pt_generate_summary", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    const summaryType = safeStr(req.body?.summary_type || "Evaluation");
    
    const name =
    f.name ||
    f.pt_patient_name ||
    f.patient_name ||
    f.full_name ||
    "Pt";
    
    const age = computeAge(f.dob, f.age);
    const gender = (f.gender || "patient").toLowerCase();
    const pmh = f.history || "no significant history";
    const meds = f.meds || "N/A";
    const today = f.currentdate || new Date().toLocaleDateString("en-US");
    
    let prompt = "";
    
    if (summaryType === "Evaluation") {
      prompt =
      "Generate a concise 7–8 sentence Physical Therapy assessment summary that is Medicare compliant. " +
      "Use abbreviations only. Never use 'the patient' or third-person pronouns.\n" +
      `Start with: "${name}, a ${age} y/o ${gender} with PMH of ${pmh}."\n` +
      `Include PT eval on ${today} for ${f.subjective}. ` +
      `Medications: ${meds}. ` +
      `Symptoms are associated with referring dx ${f.meddiag}. ` +
      `Summarize impairments (ROM: ${f.rom}; strength: ${f.strength}). ` +
      `Summarize functional limitations: ${f.functional}. ` +
      "End stating continued skilled PT is medically necessary to return to PLOF.";
    }
    
    const narrative = await gptCall(prompt, 500);
    const soap = buildSoapAssessment(f);
    
    return res.json({
      result: `${narrative}\n\n${soap}`,
    });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_summary failed", e?.message || e);
  }
});

// --------------------------------------------------
// PT GOALS
// --------------------------------------------------

router.post("/pt_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const prompt = `
You are a clinical assistant helping a Physical Therapist write documentation.

Diagnosis/Region: ${f.meddiag || f.pain_location}
Strength: ${f.strength}
ROM: ${f.rom}
Impairments: ${f.impairments}
Functional Limitations: ${f.functional}

Using ONLY the above provided evaluation info, generate Medicare-compliant PT goals.
ALWAYS follow this EXACT format. Do NOT add or remove any sections.

Short-Term Goals (1–12 visits):
1. Pt will report pain ≤[target]/10 during [functional activity].
2. Pt will improve [objective finding] by ≥[measurable amount] to allow [activity].
3. Pt will demonstrate ≥[percent]% adherence to HEP during ADLs.
4. Pt will perform transfers or mobility with [level of independence] to support function.

Long-Term Goals (13–25 visits):
1. Pt will increase strength or functional capacity to safely perform ADLs.
2. Pt will restore ROM to within functional limits to enable daily activities.
3. Pt will demonstrate independence with HEP to prevent reinjury.
4. Pt will resume PLOF with minimal or no symptoms.
`.trim();
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_goals failed", e?.message || e);
  }
});
// --------------------------------------------------
// OT GOALS
// --------------------------------------------------

router.post("/ot_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const summary =
    safeStr(f.summary) ||
    "Pt evaluated for functional deficits impacting ADLs and IADLs.";
    
    const strength = safeStr(f.strength) || "N/A";
    const rom = safeStr(f.rom) || "N/A";
    const impairments = safeStr(f.impairments) || "N/A";
    const functional = safeStr(f.functional) || "N/A";
    const pain = safeStr(f.pain_location) || "N/A";
    
    const prompt = `
You are a clinical assistant helping an occupational therapist write documentation.

Below is the patient's evaluation data. Use ONLY this information.
Do NOT invent details. Do NOT use third-person pronouns.
Always begin each goal with "Pt will".

Evaluation Summary:
${summary}

Pain:
${pain}

ROM:
${rom}

Strength:
${strength}

Impairments:
${impairments}

Functional Limitations:
${functional}

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
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_goals failed", {
      detail: String(e?.message || e),
    });
  }
});

// --------------------------------------------------
// EXPORT ROUTER
// --------------------------------------------------

export default router;
