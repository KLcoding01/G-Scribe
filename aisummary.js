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
//  { result: "..." , region?: "..." }
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
  return safeStr(s).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

/**
 * Some outputs (GOALS) MUST include numbered lines. Others must not.
 * - allowNumbered: permits "1. ..." patterns
 */
function hasBulletsOrNumbering(text, { allowNumbered = false } = {}) {
  const t = String(text || "");
  const hasBullets = /^\s*[-*•]\s+/m.test(t);
  const hasNumbered = /^\s*\d+\.\s+/m.test(t);
  if (hasBullets) return true;
  if (hasNumbered && !allowNumbered) return true;
  return false;
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
    ["summary", "summary"],
    ["meds", "meds"],
    ["impairments", "impairments"],
    ["functional", "functional"],
    ["rom", "rom"],
    ["strength", "strength"],
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
  const painLine = painLoc ? (painRating ? `${painLoc}: ${painRating}` : painLoc) : "N/A";
  
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

async function gptCall(prompt, maxTokens = 500, temperature = 0.2) {
  if (!openai) throw new Error("OPENAI_API_KEY not configured.");
  
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
      content:
        "You are a clinical documentation assistant for rehab clinicians. " +
        "Use abbreviations where appropriate. Always refer to the person as 'Pt' (never 'the patient' or they/their). " +
        "No bullets unless explicitly required by the user prompt. No arrows (↑ ↓). " +
        "Medicare-compliant. Do not invent facts. Use ONLY provided information.",
      },
      { role: "user", content: prompt },
    ],
    temperature,
    max_tokens: maxTokens,
  });
  
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

async function enforceCleanOutputOrRepair({
  text,
  purpose,
  maxTokens = 350,
  allowNumbered = false,
}) {
  const raw = safeStr(text);
  if (!raw) return raw;
  
  const violates =
  hasBannedThirdPersonRef(raw) ||
  containsArrows(raw) ||
  hasBulletsOrNumbering(raw, { allowNumbered });
  
  if (!violates) return raw;
  
  const repairPrompt = `
Fix this ${purpose} text to comply:
- Use "Pt" only. Do NOT use "the patient" or they/their/them/theirs/themselves.
- No bullets
- ${allowNumbered ? "Numbered lines are allowed only if already present and required." : "No numbering"}
- No arrows (↑ ↓)
- Do not add facts
Return corrected text only.

Bad text:
${raw}
`.trim();
  
  const repaired = await gptCall(repairPrompt, maxTokens, 0.2);
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

// --------------------------------------------------
// Region detection + banks (PT + OT)
// --------------------------------------------------

function detectPTRegion(f) {
  const src = [
    f.meddiag,
    f.pain_location,
    f.painLocation,
    f.region,
    f.body_region,
    f.bodyRegion,
  ]
  .filter(Boolean)
  .join(" ")
  .toLowerCase();
  
  if (/(knee|patell|pfps|acl|mcl|menisc|tka|oa knee|osteoarthritis.*knee)/.test(src)) return "knee";
  if (/(shoulder|shld|rotator|rtc|imping|bursitis|labrum|adhesive capsul|frozen|biceps tend|supraspinatus)/.test(src)) return "shoulder";
  if (/(low back|lbp|lumbar|l[-\s]?spine|sciatic|radicul|disc|stenosis|spondyl|facet)/.test(src)) return "lbp";
  
  return "general";
}

function detectOTRegion(f) {
  const src = [
    f.meddiag,
    f.pain_location,
    f.painLocation,
    f.region,
    f.body_region,
    f.bodyRegion,
    f.summary,
    f.subjective,
    f.impairments,
    f.functional,
  ]
  .filter(Boolean)
  .join(" ")
  .toLowerCase();
  
  // Neuro / CVA / TBI etc.
  if (/(cva|stroke|tbi|brain injury|parkinson|ms\b|cp\b|hemip|neglect|ataxia|aphasia)/.test(src)) return "neuro";
  
  // Hand/Wrist
  if (/(hand|wrist|carpal|ctr\b|trigger finger|dupuy|tenosynov|de quervain|metacarp|phalanx|thumb|cmc)/.test(src))
    return "hand_wrist";
  
  // Elbow
  if (/(elbow|lateral epicond|tennis elbow|medial epicond|golfer|olecranon)/.test(src)) return "elbow";
  
  // Shoulder (OT often UE shoulder)
  if (/(shoulder|shld|rotator|rtc|imping|adhesive capsul|frozen|biceps tend)/.test(src)) return "shoulder";
  
  return "general";
}

const PT_GOAL_BANKS = {
  lbp: {
    label: "PT — Low Back / Lumbar",
    painActivities: [
      "prolonged sitting",
      "prolonged standing",
      "household ambulation",
      "functional bending",
      "lifting light household items",
      "transfers (sit<>stand/bed mobility)",
    ],
    objectiveFocus: [
      "trunk AROM (flexion/extension/side-bending)",
      "hip strength and lumbopelvic stability",
      "core endurance and motor control",
      "functional tolerance (standing/walking duration)",
    ],
    measures: [
      "increase trunk AROM by ≥[measurable amount]",
      "improve core endurance by ≥[measurable amount]",
      "increase standing tolerance by ≥[measurable amount]",
      "increase walking tolerance by ≥[measurable amount]",
    ],
    mobilityLine: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
  
  knee: {
    label: "PT — Knee",
    painActivities: [
      "sit<>stand transfers",
      "stair negotiation",
      "prolonged walking",
      "squatting to retrieve items",
      "car transfers",
      "household ambulation",
    ],
    objectiveFocus: [
      "knee AROM (flexion/extension)",
      "quad/hamstring strength",
      "hip strength for dynamic valgus control",
      "single-limb stability/balance",
    ],
    measures: [
      "increase knee flexion/extension AROM by ≥[measurable amount]",
      "improve quad strength by ≥[measurable amount]",
      "improve stair tolerance by ≥[measurable amount]",
      "improve transfer performance by ≥[measurable amount]",
    ],
    mobilityLine: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
  
  shoulder: {
    label: "PT — Shoulder",
    painActivities: [
      "reaching overhead",
      "reaching behind back",
      "lifting/carrying light household items",
      "donning/doffing shirt/jacket",
      "grooming/hair care",
      "sleep positioning without symptom flare",
    ],
    objectiveFocus: [
      "shoulder AROM (flex/abd/ER/IR)",
      "scapular stability and rotator cuff strength",
      "postural control and thoracic mobility as applicable",
      "functional reaching tolerance",
    ],
    measures: [
      "increase shoulder AROM by ≥[measurable amount]",
      "improve rotator cuff/scapular strength by ≥[measurable amount]",
      "improve overhead tolerance by ≥[measurable amount]",
      "reduce symptom provocation with reaching tasks",
    ],
    mobilityLine: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
  
  general: {
    label: "PT — General",
    painActivities: [
      "walking",
      "standing tasks",
      "sitting tolerance",
      "transfers",
      "lifting light household items",
      "stairs as applicable",
    ],
    objectiveFocus: ["ROM as applicable", "strength as applicable", "activity tolerance", "functional mobility"],
    measures: [
      "improve ROM by ≥[measurable amount]",
      "improve strength by ≥[measurable amount]",
      "improve activity tolerance by ≥[measurable amount]",
    ],
    mobilityLine: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
};

const OT_GOAL_BANKS = {
  shoulder: {
    label: "OT — UE Shoulder",
    adlTasks: [
      "donning/doffing shirt or jacket",
      "grooming/hair care",
      "reaching to cabinets (light items)",
      "meal prep reaching tasks",
      "sleep positioning without symptom flare",
    ],
    objectiveFocus: [
      "UE AROM (shoulder flex/abd/ER/IR) as applicable",
      "scapular control and proximal stability",
      "functional reach tolerance with pain management strategies",
      "task modification and joint protection",
    ],
    measures: [
      "increase UE AROM by ≥[measurable amount]",
      "improve functional reaching tolerance for ≥[time] without symptom flare",
      "reduce pain to ≤[target]/10 during functional reaching",
      "improve performance using AE/compensatory strategies as indicated",
    ],
    assistance: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
  
  elbow: {
    label: "OT — Elbow",
    adlTasks: [
      "self-care tasks requiring elbow flex/extend",
      "lifting/carrying light household items",
      "household cleaning tasks",
      "meal prep/light cooking",
      "computer/phone use with symptom management",
    ],
    objectiveFocus: [
      "elbow/wrist AROM as applicable",
      "grip/pinch strength as applicable",
      "pain management and activity modification",
      "endurance for repetitive UE tasks",
    ],
    measures: [
      "increase elbow AROM by ≥[measurable amount]",
      "improve grip/pinch by ≥[measurable amount]",
      "reduce pain to ≤[target]/10 during repetitive UE tasks",
      "tolerate ≥[time] of functional UE activity with pacing strategies",
    ],
    assistance: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
  
  hand_wrist: {
    label: "OT — Hand/Wrist",
    adlTasks: [
      "buttoning/zippers",
      "opening containers/jars",
      "writing/typing",
      "self-feeding tasks",
      "light household chores requiring grasp",
    ],
    objectiveFocus: [
      "wrist/hand ROM as applicable",
      "grip/pinch strength",
      "edema/pain management strategies as applicable",
      "fine motor coordination and dexterity",
      "joint protection and AE training",
    ],
    measures: [
      "increase wrist/hand ROM by ≥[measurable amount]",
      "improve grip/pinch by ≥[measurable amount]",
      "improve fine motor control to complete [task] with ≤[assist] cues",
      "reduce pain to ≤[target]/10 during functional grasp/release",
    ],
    assistance: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
  
  neuro: {
    label: "OT — Neuro (CVA/TBI/etc.)",
    adlTasks: [
      "dressing with strategy use",
      "bathing with safety setup",
      "toileting routine with sequencing strategies",
      "simple meal prep with compensatory techniques",
      "home management task with safety awareness",
    ],
    objectiveFocus: [
      "UE motor control and functional use",
      "balance/safety during ADLs as applicable",
      "cognitive strategies (sequencing/attention) as applicable",
      "visual-perceptual/neglect strategies as applicable",
      "caregiver training and home safety recommendations",
    ],
    measures: [
      "complete [ADL] with ≤[level] cues using compensatory strategies",
      "improve functional UE use during [task] with ≥[measurable amount] carryover",
      "tolerate ≥[time] of structured ADL activity with rest breaks as needed",
      "demonstrate safety awareness during ADLs with ≤[number] cues",
    ],
    assistance: ["independent", "modified independent", "SBA", "CGA", "min A", "mod A"],
  },
  
  general: {
    label: "OT — General",
    adlTasks: ["dressing", "grooming", "bathing", "meal prep", "light home management", "functional reaching/lifting (light)"],
    objectiveFocus: ["ROM as applicable", "strength/endurance as applicable", "pain management strategies", "AE training and task modification"],
    measures: [
      "improve ROM by ≥[measurable amount]",
      "improve strength/endurance by ≥[measurable amount]",
      "reduce pain to ≤[target]/10 during ADLs",
      "complete [task] with [assist level] using AE/strategies as needed",
    ],
    assistance: ["independent", "modified independent", "SBA", "CGA", "min A"],
  },
};

function buildPTGoalsPrompt(f, regionKey) {
  const bank = PT_GOAL_BANKS[regionKey] || PT_GOAL_BANKS.general;
  const diag = safeStr(f.meddiag) || safeStr(f.pain_location || f.painLocation) || "N/A";
  
  return `
You are a clinical assistant helping a Physical Therapist write documentation.

Use ONLY the info below. Do NOT invent details.
Do NOT use third-person pronouns; use "Pt" only.
No bullets beyond the required numbered goal lines.
Do NOT add or remove any sections.

Diagnosis/Region: ${diag}
Strength: ${safeStr(f.strength) || "N/A"}
ROM: ${safeStr(f.rom) || "N/A"}
Impairments: ${safeStr(f.impairments) || "N/A"}
Functional Limitations: ${safeStr(f.functional) || "N/A"}

Region Bank Selected: ${bank.label}

You MUST generate goals using ONLY these option pools (choose different options to create variation):
- Pain activity options: ${bank.painActivities.join(", ")}
- Objective focus options: ${bank.objectiveFocus.join(", ")}
- Measure phrasing options: ${bank.measures.join(", ")}
- Mobility independence options: ${bank.mobilityLine.join(", ")}

Variability rules:
- Choose a pain activity option for STG #1.
- For STG #2, choose ONE objective focus option and ONE measure phrasing option.
- For STG #4, choose ONE mobility independence option.
- Keep placeholders (e.g., [measurable amount]) if exact values are not provided.

ALWAYS follow this EXACT format. Do NOT add or remove any sections.

Short-Term Goals (1–12 visits):
1. Pt will report pain ≤[target]/10 during [pain activity option].
2. Pt will improve [objective focus option] using [measure phrasing option] to allow [activity from functional limitations].
3. Pt will demonstrate ≥[percent]% adherence to HEP during ADLs.
4. Pt will perform transfers or mobility with [mobility independence option] to support function.

Long-Term Goals (13–25 visits):
1. Pt will increase strength of 1 grade or higher or functional capacity to safely perform ADLs.
2. Pt will restore AROM to WNL as applicable to enable daily activities.
3. Pt will demonstrate independence with HEP to prevent reinjury.
4. Pt will self report resume PLOF with minimal or no symptoms.
`.trim();
}

function buildOTGoalsPrompt(f, regionKey) {
  const bank = OT_GOAL_BANKS[regionKey] || OT_GOAL_BANKS.general;
  const diag = safeStr(f.meddiag) || safeStr(f.pain_location || f.painLocation) || "N/A";
  
  return `
You are a clinical assistant helping an Occupational Therapist write documentation.

Use ONLY the info below. Do NOT invent details.
Do NOT use third-person pronouns; use "Pt" only.
No bullets beyond the required numbered goal lines.
Do NOT add or remove any sections.

Diagnosis/Region: ${diag}
Summary: ${safeStr(f.summary) || safeStr(f.subjective) || "N/A"}
Strength: ${safeStr(f.strength) || "N/A"}
ROM: ${safeStr(f.rom) || "N/A"}
Impairments: ${safeStr(f.impairments) || "N/A"}
Functional Limitations (ADLs/IADLs): ${safeStr(f.functional) || "N/A"}

Region Bank Selected: ${bank.label}

You MUST generate goals using ONLY these option pools (choose different options to create variation):
- ADL/IADL task options: ${bank.adlTasks.join(", ")}
- Objective focus options: ${bank.objectiveFocus.join(", ")}
- Measure phrasing options: ${bank.measures.join(", ")}
- Assistance/independence options: ${bank.assistance.join(", ")}

Variability rules:
- Choose an ADL/IADL task option for STG #1 and a different task for LTG #2 when possible.
- For STG #2, choose ONE objective focus option and ONE measure phrasing option.
- Use placeholders if exact values are not provided.

ALWAYS follow this EXACT format. Do NOT add or remove any sections.

Short-Term Goals (1–12 visits):
1. Pt will perform [ADL/IADL task option] with [assistance/independence option or AE] to improve functional independence.
2. Pt will improve [objective focus option] using [measure phrasing option] to support safe task performance.
3. Pt will demonstrate improved activity tolerance during [ADL/IADL task option] with appropriate pacing or strategy use.
4. Pt will report pain ≤[target]/10 during completion of [ADL/IADL task option].

Long-Term Goals (13–25 visits):
1. Pt will independently perform ADLs/IADLs using learned strategies or AE as needed.
2. Pt will demonstrate safe completion of [ADL/IADL task option] without increased symptoms.
3. Pt will tolerate ≥[time] of functional activity to support daily routines.
4. Pt will independently manage HEP and compensatory strategies to maintain functional gains.
`.trim();
}
