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

// Optional: enable simple header auth
// If you set AI_API_KEY in env, require `X-API-Key: <AI_API_KEY>` on every request.
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

// -------------------------
// Utilities
// -------------------------

function safeStr(v) {
  return (v ?? "").toString().trim();
}

function computeAge(dobRaw, fallbackAge = "X") {
  const dob = safeStr(dobRaw);
  if (!dob) return safeStr(fallbackAge) || "X";
  
  const fmts = ["YYYY-MM-DD", "MM/DD/YYYY", "MM-DD-YYYY"];
  
  // Minimal date parsing without extra deps:
  const tryParse = (s) => {
    // YYYY-MM-DD
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    
    // MM/DD/YYYY
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    
    // MM-DD-YYYY
    m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    
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
  
  const text = resp.choices?.[0]?.message?.content ?? "";
  return text.trim();
}

function jsonError(res, status, msg, extra = {}) {
  return res.status(status).json({ error: msg, ...extra });
}

// -------------------------
// PT: Differential Dx
// -------------------------

router.post("/pt_generate_diffdx", async (req, res) => {
  try {
    const f = req.body?.fields || {};
    const pain = buildPainLine(f);
    
    const prompt =
    "You are a PT clinical assistant. Based on the following evaluation details, " +
    "provide a concise statement of the most clinically-associated PT differential diagnosis. " +
    "Do NOT state as fact or as a medical diagnosis—use only language such as 'symptoms and clinical findings are associated with or consistent with' the diagnosis. " +
    "Keep the statement clean and PT-relevant:\n\n" +
    `Subjective:\n${safeStr(f.subjective)}\n\n` +
    `Pain:\n${pain}\n\n` +
    `Objective:\nPosture: ${safeStr(f.posture)}\n` +
    `ROM: ${safeStr(f.rom)}\n` +
    `Strength: ${safeStr(f.strength)}\n`;
    
    const result = await gptCall(prompt, 250);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_diffdx failed", { detail: String(e?.message || e) });
  }
});

// -------------------------
// PT: Summary
// -------------------------

router.post("/pt_generate_summary", async (req, res) => {
  try {
    const f = req.body?.fields || {};
    const summaryType = safeStr(req.body?.summary_type || "Evaluation");
    
    const name =
    safeStr(f.name) ||
    safeStr(f.pt_patient_name) ||
    safeStr(f.patient_name) ||
    safeStr(f.full_name) ||
    "Pt";
    
    const age = computeAge(f.dob, f.age);
    const gender = safeStr(f.gender || "patient").toLowerCase();
    const pmh = safeStr(f.history || "no significant history");
    const today = safeStr(f.currentdate) || new Date().toLocaleDateString("en-US");
    const subj = safeStr(f.subjective);
    const moi = safeStr(f.pain_mechanism);
    const meddiag = safeStr(f.meddiag) || safeStr(f.medical_diagnosis);
    const dx = safeStr(f.diffdx);
    const strg = safeStr(f.strength);
    const rom = safeStr(f.rom);
    const impair = safeStr(f.impairments);
    const func = safeStr(f.functional);
    
    let prompt = "";
    
    if (summaryType === "Progress Note") {
      prompt =
      "Generate a concise, 5-6 sentence Physical Therapy progress note summary that is Medicare compliant. " +
      "Use only abbreviations (e.g., HEP, ADLs, LBP, STM, TherEx) and NEVER spell out abbreviations. " +
      "Do NOT use 'the patient'; use 'Pt' as the subject. " +
      `Start with: "${name} continues skilled PT with relevant history of ${pmh}." ` +
      `Describe progress toward goals, improvements or setbacks in impairments (strength: ${strg}; ROM: ${rom}; balance/mobility: ${impair}), and functional status: ${func}. ` +
      "Include details on interventions applied and patient tolerance. " +
      "Conclude with the continued medical necessity for skilled PT and plan for future care. " +
      "Do NOT use lists; provide a clear, professional paragraph.";
    } else if (summaryType === "Discharge") {
      prompt =
      "Generate a concise, 5-6 sentence Physical Therapy discharge summary that is Medicare compliant. " +
      "Use only abbreviations (e.g., HEP, ADLs, LBP, STM, TherEx) and NEVER spell out abbreviations. " +
      "Do NOT use 'the patient'; use 'Pt' as the subject. " +
      `Start with: "${name} completed skilled PT with relevant history of ${pmh}." ` +
      `Summarize final status of impairments (strength: ${strg}; ROM: ${rom}; balance/mobility: ${impair}), functional gains: ${func}, and goal achievement. ` +
      "Include discharge interventions provided, patient education, and home program instructions. " +
      "Conclude with discharge status and any recommendations for follow-up care. " +
      "Do NOT use lists; provide a concise, professional paragraph.";
    } else {
      // Evaluation default
      prompt =
      "Generate a concise, 7-8 sentence Physical Therapy assessment summary that is Medicare compliant for PT documentation. " +
      "Use only abbreviations (e.g., HEP, ADLs, LBP, STM, TherEx) and NEVER spell out abbreviations. " +
      "Never use 'the patient'; use 'Pt' as the subject. " +
      "Do NOT use parentheses, asterisks, or markdown formatting in your response. " +
      "Do NOT use 'Diagnosis:' as a label—refer directly to the diagnosis in clinical sentences. " +
      "Do NOT state or conclude a medical diagnosis—use clinical phrasing such as 'symptoms and clinical findings are associated with' the medical diagnosis and PT clinical impression. " +
      `Start with: "${name}, a ${age} y/o ${gender} with relevant history of ${pmh}." ` +
      `Include: PT initial eval on ${today} for ${subj}. ` +
      (moi ? `If available, mention the mechanism of injury: ${moi}. ` : "") +
      `State: Pt has symptoms and clinical findings associated with the referring medical diagnosis of ${meddiag}. Clinical findings are consistent with PT differential diagnosis of ${dx} based on assessment. ` +
      `Summarize current impairments (strength: ${strg}; ROM: ${rom}; balance/mobility: ${impair}). ` +
      `Summarize functional/activity limitations: ${func}. ` +
      "End with a professional prognosis stating that skilled PT is medically necessary to address impairments and support return to PLOF. " +
      "Do NOT use bulleted or numbered lists—compose a single, well-written summary paragraph.";
    }
    
    const result = await gptCall(prompt, 500);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_summary failed", { detail: String(e?.message || e) });
  }
});

// -------------------------
// PT: Goals
// -------------------------

router.post("/pt_generate_goals", async (req, res) => {
  try {
    const fields = req.body?.fields || {};
    
    const summary = safeStr(fields.summary);
    const strength = safeStr(fields.strength);
    const rom = safeStr(fields.rom);
    const impairments = safeStr(fields.impairments);
    const functional = safeStr(fields.functional);
    const meddiag = safeStr(fields.meddiag);
    const painLocation = safeStr(fields.pain_location);
    
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
1. Pt will report [symptom, e.g., neck pain] ≤[target]/10 with [functional activity].
2. Pt will improve [objective finding, e.g., cervical rotation] by ≥[measurable target] to allow [activity].
3. Pt will demonstrate ≥[percent]% adherence to [strategy/technique] during [ADL].
4. Pt will perform HEP, transfer, or mobility] with [level of independence] to support [function].

Long-Term Goals (13–25 visits):
1. Pt will increase [strength or ability] by ≥[amount] to support safe [ADL/task].
2. Pt will restore [ROM/ability] to within [target] of normal, enabling [activity].
3. Pt will demonstrate 100% adherence to [technique/precaution] during [ADL/IADL].
4. Pt will independently perform [home program or self-management] to maintain function and prevent recurrence.

ALWAYS use this structure, always begin each statement with 'Pt will', and do NOT add any extra text, dashes, bullets, or lines. Use only info from the above findings.
`.trim();
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "pt_generate_goals failed", { detail: String(e?.message || e) });
  }
});

// -------------------------
// OT: Differential Dx
// -------------------------

router.post("/ot_generate_diffdx", async (req, res) => {
  try {
    const f = req.body?.fields || {};
    let dx = safeStr(f.diffdx);
    
    if (!dx) {
      const pain = buildPainLine(f);
      const dxPrompt =
      "You are an OT clinical assistant. Based on the following OT evaluation details, " +
      "provide a concise statement of the most clinically-associated OT differential diagnosis. " +
      "Do NOT state as fact or as a medical diagnosis—use only language such as 'symptoms and clinical findings are associated with or consistent with' the diagnosis. " +
      `Subjective:\n${safeStr(f.subjective)}\nPain:\n${pain}\n`;
      
      dx = await gptCall(dxPrompt, 200);
    }
    
    return res.json({ result: dx });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_diffdx failed", { detail: String(e?.message || e) });
  }
});

// -------------------------
// OT: Summary
// -------------------------

router.post("/ot_generate_summary", async (req, res) => {
  try {
    const f = req.body?.fields || {};
    
    const name =
    safeStr(f.name) ||
    safeStr(f.ot_patient_name) ||
    safeStr(f.patient_name) ||
    safeStr(f.full_name) ||
    "Pt";
    
    const age = computeAge(f.dob, f.age);
    const gender = safeStr(f.gender || "patient").toLowerCase();
    const pmh = safeStr(f.history || "no significant history");
    const today = safeStr(f.currentdate) || new Date().toLocaleDateString("en-US");
    const subj = safeStr(f.subjective);
    const moi = safeStr(f.pain_mechanism);
    const meddiag = safeStr(f.meddiag) || safeStr(f.medical_diagnosis);
    
    let dx = safeStr(f.diffdx);
    if (!dx) {
      const pain = buildPainLine(f);
      const dxPrompt =
      "You are an OT clinical assistant. Based on the following OT evaluation details, " +
      "provide a concise statement of the most clinically-associated OT differential diagnosis. " +
      "Do NOT state as fact or as a medical diagnosis—use only language such as 'symptoms and clinical findings are associated with or consistent with' the diagnosis. " +
      `Subjective:\n${subj}\nPain:\n${pain}\n`;
      
      dx = await gptCall(dxPrompt, 200);
    }
    
    const strg = safeStr(f.strength);
    const rom = safeStr(f.rom);
    const impair = safeStr(f.impairments);
    const func = safeStr(f.functional);
    
    const prompt =
    "Generate a concise, 7-8 sentence Occupational Therapy assessment summary that is Medicare compliant for OT documentation. " +
    "Use only abbreviations (e.g., HEP, ADLs, IADLs, STM, TherEx) and NEVER spell out abbreviations. " +
    "Never use 'the patient'; use 'Pt' as the subject. " +
    "Do NOT use parentheses, asterisks, or markdown formatting in your response. " +
    "Do NOT use 'Diagnosis:' as a label—refer directly to the diagnosis in clinical sentences. " +
    "Do NOT state or conclude a medical diagnosis—use clinical phrasing such as 'symptoms and clinical findings are associated with' the medical diagnosis and OT clinical impression. " +
    `Start with: "${name}, a ${age} y/o ${gender} with relevant history of ${pmh}." ` +
    `Include: OT initial eval on ${today} for ${subj}. ` +
    (moi ? `If available, mention the mechanism of injury: ${moi}. ` : "") +
    `State: Pt has symptoms and clinical findings associated with the referring medical diagnosis of ${meddiag}. Clinical findings are consistent with OT differential diagnosis of ${dx} based on assessment. ` +
    `Summarize current impairments (strength: ${strg}; ROM: ${rom}; balance/mobility: ${impair}). ` +
    `Summarize functional/activity limitations: ${func}. ` +
    "End with a professional prognosis stating that skilled OT is medically necessary to address impairments and support return to PLOF. " +
    "Do NOT use bulleted or numbered lists—compose a single, well-written summary paragraph.";
    
    const result = await gptCall(prompt, 500);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_summary failed", { detail: String(e?.message || e) });
  }
});

// -------------------------
// OT: Goals
// -------------------------

router.post("/ot_generate_goals", async (req, res) => {
  try {
    const fields = req.body?.fields || {};
    
    const summary = safeStr(fields.summary) || "Pt evaluated for functional deficits impacting ADLs/IADLs.";
    const strength = safeStr(fields.strength) || "N/A";
    const rom = safeStr(fields.rom) || "N/A";
    const impairments = safeStr(fields.impairments) || "N/A";
    const functional = safeStr(fields.functional) || "N/A";
    
    const prompt = `
You are a clinical assistant helping an occupational therapist write documentation.
Below is a summary of the patient's evaluation and findings:
Summary: ${summary}
Strength: ${strength}
ROM: ${rom}
Impairments: ${impairments}
Functional Limitations: ${functional}

Using ONLY the above provided eval info, generate clinically-appropriate, Medicare-compliant short-term and long-term OT goals. Focus on ADLs, IADLs, functional participation, use of adaptive equipment, and safety (e.g., dressing, bathing, toileting, home management, transfers, community integration). Each goal must use the "Pt will..." format, specify an activity and level of independence, and be functionally/measurably stated.

ALWAYS follow this exact format—do not add, skip, reorder, or alter any lines or labels.
DO NOT add any explanations, introductions, dashes, bullets, or extra indentation. Output ONLY this structure:

Short-Term Goals (1–12 visits):
1. Pt will [specific ADL/IADL task] with [level of assistance/adaptive strategy] to promote functional independence.
2. Pt will improve [ROM/strength/endurance] by [amount or %] to support [specific functional task].
3. Pt will independently use [adaptive equipment or compensatory technique] during [ADL/IADL].
4. Pt will report pain ≤[target]/10 during [functional task or ADL].

Long-Term Goals (13–25 visits):
1. Pt will complete all [ADL/IADL] independently or with AE as needed.
2. Pt will demonstrate safe performance of [home/community management task] using proper body mechanics and adaptive strategies.
3. Pt will participate in [community activity/home management/transfer] with [level of independence].
4. Pt will maintain functional gains and independently implement all learned safety/adaptive strategies in daily routines.
`.trim();
    
    const result = await gptCall(prompt, 400);
    return res.json({ result });
  } catch (e) {
    return jsonError(res, 500, "ot_generate_goals failed", { detail: String(e?.message || e) });
  }
});

export default router;
