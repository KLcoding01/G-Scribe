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

// Optional header auth
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
 * 🔧 NEW: Global dictation lead-in stripping
 * Applied to ALL text fields before prompt assembly
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
 * 🔧 NEW: Normalize ALL incoming fields once
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
  if (!dob) return safeStr(fallbackAge) || "X";
  
  const tryParse = (s) => {
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    return null;
  };
  
  const dobDt = tryParse(dob);
  if (!dobDt || Number.isNaN(dobDt.getTime())) return safeStr(fallbackAge) || "X";
  
  const today = new Date();
  let age = today.getFullYear() - dobDt.getFullYear();
  const m = today.getMonth() - dobDt.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dobDt.getDate())) age -= 1;
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
 * 🔧 NEW: SOAP Assessment builder (mirrors Python export logic)
 */
function buildSoapAssessment(f) {
  return (
          "Soap Assessment:\n\n" +
          "Pain:\n" +
          `${safeStr(f.pain_location)}\n${safeStr(f.pain_rating)}\n\n` +
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
  if (!openai) throw new Error("OPENAI_API_KEY not configured on server.");
  
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
      content:
        "You are a clinical documentation assistant for rehab clinicians. Follow instructions exactly. Keep output clean and compliant.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  });
  
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

function jsonError(res, status, msg, extra = {}) {
  return res.status(status).json({ error: msg, ...extra });
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
    "provide a concise statement of the most clinically-associated PT differential diagnosis. " +
    "Do NOT state as fact or as a medical diagnosis—use only language such as 'symptoms and clinical findings are associated with or consistent with' the diagnosis.\n\n" +
    `Subjective:\n${f.subjective}\n\n` +
    `Pain:\n${pain}\n\n` +
    `Objective:\nPosture: ${f.posture}\nROM: ${f.rom}\nStrength: ${f.strength}`;
    
    const result = await gptCall(prompt, 250);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_diffdx failed", {
      detail: String(e?.message || e),
    });
  }
});

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
    const today = f.currentdate || new Date().toLocaleDateString("en-US");
    
    let prompt = "";
    
    if (summaryType === "Evaluation") {
      prompt =
      "Generate a concise, 7-8 sentence Physical Therapy assessment summary that is Medicare compliant. " +
      "Use only abbreviations. Never use 'the patient'.\n" +
      `Start with: "${name}, a ${age} y/o ${gender} with relevant history of ${pmh}."\n` +
      `Include PT eval on ${today} for ${f.subjective}. ` +
      `Symptoms are associated with referring dx ${f.meddiag} and PT diff dx ${f.diffdx}. ` +
      `Summarize impairments (strength: ${f.strength}; ROM: ${f.rom}). ` +
      `Summarize functional limitations: ${f.functional}. ` +
      "End stating skilled PT is medically necessary to return to PLOF.";
    }
    
    const narrative = await gptCall(prompt, 500);
    const soap = buildSoapAssessment(f);
    
    return res.json({ result: `${narrative}\n\n${soap}` });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_summary failed", {
      detail: String(e?.message || e),
    });
  }
});

// --------------------------------------------------
// PT: Goals
// --------------------------------------------------

router.post("/pt_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const summary = safeStr(f.summary);
    const strength = safeStr(f.strength);
    const rom = safeStr(f.rom);
    const impairments = safeStr(f.impairments);
    const functional = safeStr(f.functional);
    const meddiag = safeStr(f.meddiag);
    const painLocation = safeStr(f.pain_location);
    
    const prompt = `
You are a clinical assistant helping a PT write documentation.
Below is a summary of the patient's evaluation and findings:
Diagnosis/Region: ${meddiag || painLocation}
Summary: ${summary}
Strength: ${strength}
ROM: ${rom}
Impairments: ${impairments}
Functional Limitations: ${functional}

Using ONLY the above provided eval info, generate clinically-appropriate, Medicare-compliant short-term and long-term PT goals for the region/problem described.
Each goal must be functionally focused and follow this EXACT format, time frame, and language example (do NOT copy example content, use it as a style guide):

Short-Term Goals (1–12 visits):
1. Pt will report [symptom] ≤[target]/10 with [functional activity].
2. Pt will improve [objective finding] by ≥[measurable target] to allow [activity].
3. Pt will demonstrate ≥[percent]% adherence to [strategy/technique] during [ADL].
4. Pt will perform HEP, transfer, or mobility with [level of independence] to support [function].

Long-Term Goals (13–25 visits):
1. Pt will increase [strength or ability] by ≥[amount] to support safe [ADL/task].
2. Pt will restore [ROM/ability] to within [target] of normal, enabling [activity].
3. Pt will demonstrate 100% adherence to [technique/precaution] during [ADL/IADL].
4. Pt will independently perform [home program or self-management] to maintain function and prevent recurrence.

ALWAYS use this structure, always begin each statement with 'Pt will', and do NOT add any extra text.
`.trim();
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_goals failed", {
      detail: String(e?.message || e),
    });
  }
});

// --------------------------------------------------
// OT: Differential Dx
// --------------------------------------------------

router.post("/ot_generate_diffdx", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    let dx = safeStr(f.diffdx);
    
    if (!dx) {
      const pain = buildPainLine(f);
      const dxPrompt =
      "You are an OT clinical assistant. Based on the following OT evaluation details, " +
      "provide a concise statement of the most clinically-associated OT differential diagnosis. " +
      "Do NOT state as fact or as a medical diagnosis—use only language such as " +
      "'symptoms and clinical findings are associated with or consistent with' the diagnosis.\n\n" +
      `Subjective:\n${f.subjective}\n\nPain:\n${pain}`;
      
      dx = await gptCall(dxPrompt, 200);
    }
    
    return res.json({ result: dx });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_diffdx failed", {
      detail: String(e?.message || e),
    });
  }
});

// --------------------------------------------------
// OT: Summary
// --------------------------------------------------

router.post("/ot_generate_summary", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const name =
    f.name ||
    f.ot_patient_name ||
    f.patient_name ||
    f.full_name ||
    "Pt";
    
    const age = computeAge(f.dob, f.age);
    const gender = (f.gender || "patient").toLowerCase();
    const pmh = f.history || "no significant history";
    const today = f.currentdate || new Date().toLocaleDateString("en-US");
    const subj = f.subjective;
    const moi = f.pain_mechanism;
    const meddiag = f.meddiag || f.medical_diagnosis;
    
    let dx = safeStr(f.diffdx);
    if (!dx) {
      const pain = buildPainLine(f);
      const dxPrompt =
      "You are an OT clinical assistant. Based on the following OT evaluation details, " +
      "provide a concise statement of the most clinically-associated OT differential diagnosis. " +
      "Do NOT state as fact or as a medical diagnosis—use only language such as " +
      "'symptoms and clinical findings are associated with or consistent with' the diagnosis.\n\n" +
      `Subjective:\n${subj}\n\nPain:\n${pain}`;
      
      dx = await gptCall(dxPrompt, 200);
    }
    
    const strg = f.strength;
    const rom = f.rom;
    const impair = f.impairments;
    const func = f.functional;
    
    const prompt =
    "Generate a concise, 7-8 sentence Occupational Therapy assessment summary that is Medicare compliant. " +
    "Use only abbreviations (e.g., HEP, ADLs, IADLs, STM, TherEx). Never use 'the patient'. " +
    "Do NOT use parentheses, asterisks, or markdown formatting.\n" +
    `Start with: "${name}, a ${age} y/o ${gender} with relevant history of ${pmh}."\n` +
    `Include OT eval on ${today} for ${subj}. ` +
    (moi ? `Mention MOI: ${moi}. ` : "") +
    `State symptoms are associated with referring dx ${meddiag} and OT diff dx ${dx}. ` +
    `Summarize impairments (strength: ${strg}; ROM: ${rom}). ` +
    `Summarize functional limitations: ${func}. ` +
    "End stating skilled OT is medically necessary to return to PLOF.";
    
    const narrative = await gptCall(prompt, 500);
    const soap = buildSoapAssessment(f);
    
    return res.json({ result: `${narrative}\n\n${soap}` });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_summary failed", {
      detail: String(e?.message || e),
    });
  }
});

// --------------------------------------------------
// OT: Goals
// --------------------------------------------------

router.post("/ot_generate_goals", async (req, res) => {
  try {
    const f = normalizeFields(req.body?.fields || {});
    
    const summary =
    f.summary ||
    "Pt evaluated for functional deficits impacting ADLs/IADLs.";
    const strength = f.strength || "N/A";
    const rom = f.rom || "N/A";
    const impairments = f.impairments || "N/A";
    const functional = f.functional || "N/A";
    
    const prompt = `
You are a clinical assistant helping an occupational therapist write documentation.
Below is a summary of the patient's evaluation and findings:
Summary: ${summary}
Strength: ${strength}
ROM: ${rom}
Impairments: ${impairments}
Functional Limitations: ${functional}

Using ONLY the above provided eval info, generate clinically-appropriate, Medicare-compliant short-term and long-term OT goals.

ALWAYS follow this exact format—do not add, skip, reorder, or alter any lines or labels.
Output ONLY this structure:

Short-Term Goals (1–12 visits):
1. Pt will [specific ADL/IADL task] with [level of assistance/adaptive strategy].
2. Pt will improve [ROM/strength/endurance] by [amount or %] to support [task].
3. Pt will independently use [adaptive equipment] during [ADL/IADL].
4. Pt will report pain ≤[target]/10 during [functional task].

Long-Term Goals (13–25 visits):
1. Pt will complete all ADLs/IADLs independently or with AE as needed.
2. Pt will demonstrate safe performance of [home/community task].
3. Pt will participate in [activity] with [level of independence].
4. Pt will independently implement learned strategies to maintain function.
`.trim();
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_goals failed", {
      detail: String(e?.message || e),
    });
  }
});

export default router;
