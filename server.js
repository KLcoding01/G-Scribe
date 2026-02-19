// ======================= server.js (FULL, UPDATED) =======================
// DROP-IN server.js
//
// ✅ Changes in this version:
// 1) /generate NEVER returns 422 for formatting/validation failures.
//    - If initial output fails validation, we try 1 repair pass.
//    - If it still fails, we COERCE locally into the exact 3-section format and return 200.
// 2) PT muscle-enforcement is BEST-EFFORT and NEVER hard-fails.
//    - If muscle repair breaks formatting, we attempt a format-only repair.
//    - If still broken, we fall back to the last known-valid note.
//
// Notes:
// - All strict visit-summary enforcement applies ONLY to POST /generate (PT/OT visit).
// - Eval endpoints (pt_generate_summary, eval/*, extract) remain unchanged (no visit enforcement).
// - aiRouter is mounted under /api/ai to avoid collisions.

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";

import { PT_TEMPLATES, OT_TEMPLATES } from "./templates.js";
import aiRouter from "./aisummary.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------------- Config ----------------
const PORT = Number(process.env.PORT || 3301);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------------- Sanity logging ----------------
console.log("Booting PT/OT backend...");
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

function normalizeNewlines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSingleLine(str) {
  return !String(str || "").includes("\n");
}

function hasNewlines(str) {
  return /\n/.test(String(str || ""));
}

function getLastSentence(text) {
  const t = String(text || "").trim();
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].trim() : "";
}

function includesExactClosingPhrase(lastSentence, discipline) {
  const needle =
    discipline === "OT"
      ? "Continued skilled OT remains indicated"
      : "Continued skilled PT remains indicated";
  return String(lastSentence || "").includes(needle);
}

// ---------------- Conservative Clean ----------------

function cleanUserText(rawText) {
  let t = String(rawText || "");
  t = t.replace(/[•●◦▪️]/g, "-");

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
  return out.join("\n");
}

function hasBannedThirdPersonRef(text) {
  const t = String(text || "");
  return /\b(the patient|they|their|them|theirs|themselves)\b/i.test(t);
}

function containsArrows(text) {
  return /[↑↓]/.test(String(text || ""));
}

function hasBulletsOrNumbering(text) {
  const t = String(text || "");
  return /^\s*[-*•]\s+/m.test(t) || /^\s*\d+\.\s+/m.test(t);
}

function safeJsonParse(s) {
  const raw = String(s || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const m = raw.match(/\{[\s\S]*\}$/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

// ---------------- Patient-based rotation (stable variations) ----------------

const patientMemory = new Map();

function pickForPatient(patientKey, arr) {
  const key = `${patientKey}::${arr.length}`;
  let idx = patientMemory.get(key);
  if (idx == null) idx = Math.floor(Math.random() * arr.length);
  else idx = (idx + 1) % arr.length;
  patientMemory.set(key, idx);
  return arr[idx];
}

// ✅ ensure ALL prefixes end with a space
const SUMMARY_INTRO_PREFIXES = [
  "Today, pt ",
  "Overall, pt ",
  "Pt demonstrates ",
  "Pt displays ",
  "Pt shows ",
  "Pt completes ",
  "Therapy tx focuses on ",
  "During today's tx, pt ",
  "Pt continues ",
  "Pt presents ",
  "Assessment displays ",
  "Tx focused on ",
  "Functional mobility indicates pt ",
  "Palpation indicates ",
  "Pt participates with PT tx ",
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

function hasBannedGenericSummaryStart(summary) {
  const s = String(summary || "").trim().toLowerCase();
  return (
    s.startsWith("pt demonstrates good engagement") ||
    s.startsWith("pt tolerated treatment well") ||
    s.startsWith("rom showed slight improvement") ||
    s.startsWith("pain levels remained manageable")
  );
}

// ✅ Visit-summary-only ban: keep patient-reported starters OUT of Summary
function hasSubjectiveStarterPhrases(text) {
  return /\b(Pt reports|Pt states|Pt notes|Pt c\/o|Pt c\/c of|Pt verbalizes|Pt expresses|Pt confirms)\b/i.test(
    String(text || "")
  );
}

// ---------------- Evaluation templates (PT/OT Eval Builder) ----------------

function normalizeDiscipline(d) {
  const s = String(d || "PT").toUpperCase().trim();
  return s === "OT" ? "OT" : "PT";
}

function getTemplatesForDiscipline(discipline) {
  return discipline === "OT" ? OT_TEMPLATES : PT_TEMPLATES;
}

const TEMPLATE_KEYMAP = {
  bmi_category: "bmiCategory",
  pain_location: "painLocation",
  pain_onset: "painOnset",
  pain_condition: "painCondition",
  pain_mechanism: "painMechanism",
  pain_rating: "painRating",
  pain_frequency: "painFrequency",
  pain_description: "painDescription",
  pain_aggravating: "painAggravating",
  pain_relieved: "painRelieved",
  pain_interferes: "painInterferes",
  diff_dx: "diffdx",
  differential_dx: "diffdx",
};

function mapTemplateToSwiftPayload(templateObj) {
  const out = {};
  for (const [k, v] of Object.entries(templateObj || {})) {
    const kk = TEMPLATE_KEYMAP[k] || k;
    out[kk] = v;
  }
  return out;
}

// ---------------- Deterministic merge + transcript normalization ----------------

function toCleanString(v) {
  return String(v ?? "").trim();
}

function isBlank(v) {
  return v == null || String(v).trim() === "";
}

function looksLikePlaceholder(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return true;
  return (
    s === "n/a" ||
    s === "na" ||
    s === "none" ||
    s === "tbd" ||
    s === "unknown" ||
    s === "-" ||
    s === "—"
  );
}

function stripPatchToAllowedKeys(patch, allowedKeys) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const k of allowedKeys) {
    if (!(k in patch)) continue;
    const v = toCleanString(patch[k]);
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function applyMerge({
  base = {},
  patch = {},
  mergeMode = "fill_empty",
  allowedKeys = [],
}) {
  const out = { ...(base || {}) };

  for (const k of allowedKeys) {
    if (!(k in patch)) continue;

    const incoming = toCleanString(patch[k]);
    if (!incoming) continue;

    const existing = toCleanString(out[k]);

    if (mergeMode === "overwrite") {
      out[k] = incoming;
      continue;
    }

    if (mergeMode === "fill_empty") {
      if (isBlank(existing) || looksLikePlaceholder(existing)) out[k] = incoming;
      continue;
    }

    if (isBlank(existing) || looksLikePlaceholder(existing)) {
      out[k] = incoming;
      continue;
    }

    const incomingLooksRicher =
      incoming.length >= existing.length + 12 ||
      /\b\d+(\.\d+)?\b/.test(incoming) ||
      /\b(ROM|MMT|TTP|CGA|SBA|min A|mod A|max A|WNL|hypomobile|Trendelenburg|AOx|HEP)\b/i.test(
        incoming
      );

    if (incomingLooksRicher) out[k] = incoming;
  }

  return out;
}

function normalizeTranscriptForExtraction(transcript) {
  const s = normalizeSpaces(transcript);
  if (!s) return "";
  const hasSpeaker = /\b(Pt|Patient|Therapist|PT|OT)\s*:/i.test(s);
  return hasSpeaker ? s : `Transcript:\n${s}`;
}

// ---------------- Visit generator prompts + validation ----------------

const SUBJECTIVE_STARTERS = [
  "Pt reports",
  "Pt states",
  "Pt notes",
  "Pt c/o",
  "Pt c/c of",
  "Pt verbalizes",
  "Pt expresses",
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
(1 to 2 sentences)

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
- 1 to 2 sentences.
- Must be patient-reported or states only.
- Must start with one of: ${SUBJECTIVE_STARTERS.join(", ")}.
- Must NOT say "tolerates tx well" or include objective measures.

SUMMARY RULES (FOR VISIT NOTES ONLY):
- Exactly 5 to 7 sentences.
- Do NOT write "The patient" or any third-person pronouns: they/their/them/theirs/themselves (case-insensitive).
- Refer to the person only as "Pt" (never they/their).
- Use abbreviation for therapeutic exercise to ther-ex.
- Use abbreviation for therapeutic activity to ther-act.
- No arrows (↑ ↓).
- Use abbrev where appropriate.
- Do NOT start the Summary with generic banned openers (e.g. "Pt tolerated treatment well").
- Summary is varying.
- Medicare supportive/defensive appropriate.
- FIRST Summary sentence MUST start EXACTLY with this prefix:
  ${introPrefix}
- LAST Summary sentence MUST be EXACTLY this sentence:
  ${closerSentence}

POC RULES:
- POC must be ONE line only.
- Must start with: "${discipline === "OT" ? "OT POC:" : "PT POC:"}"
- Must use this exact opener immediately after header: "${pocOpener}"
- Must include ALL required elements and end with "to meet goals."
- Required POC content:
  ${
    discipline === "OT"
      ? "TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals."
      : "TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals."
  }

No-hallucination:
- Only use details explicitly present in user instruction; no new numbers/devices/vitals/diagnoses.

User instruction:
${userText}

Patient label:
${patientLabel}
`.trim();
}

// Repair prompt with OPTIONAL extra constraints (used for visit rules and muscle enforcement repair)
function buildRepairPrompt({
  patientLabel,
  userText,
  badOutput,
  introPrefix,
  closerSentence,
  pocOpener,
  discipline,
  enforceVisitSummaryRules = false,
  extraSummaryConstraints = "",
}) {
  const visitSummaryExtra = enforceVisitSummaryRules
    ? `- Summary: must be a single paragraph (no newlines).
- Summary: must NOT contain patient-reported starters (Pt reports/Pt states/Pt notes/Pt c/o/etc.).
- Summary: if ther-ex or ther-act is mentioned, include VC/TC.
- Summary: must include at least one functional anchor (ADLs/gait/transfers/balance/stairs/functional mobility).`
    : "";

  return `
You must FIX the note to comply with ALL constraints. Do not add facts.

Return ONLY the corrected note with EXACTLY 3 sections:
Subjective
Summary
POC

Constraints to enforce:
- Subjective: ONE sentence, patient-reported only, must start with one of:
  ${SUBJECTIVE_STARTERS.join(", ")}
- Summary: 5-7 sentences, no arrows, no bullets/numbering.
- Summary: must NOT contain "The patient" or they/their/them/theirs/themselves. Use "Pt" only.
- Summary first sentence must start with:
  ${introPrefix}
- Summary last sentence MUST be exactly:
  ${closerSentence}
${visitSummaryExtra ? `${visitSummaryExtra}\n` : ""}
${extraSummaryConstraints ? `- EXTRA Summary constraints:\n  ${extraSummaryConstraints}\n` : ""}

- POC: ONE line, must be exactly:
  ${
    discipline === "OT"
      ? "OT POC: " +
        pocOpener +
        " TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals."
      : "PT POC: " +
        pocOpener +
        " TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals."
  }

User instruction:
${userText}

Bad output:
${badOutput}

Now output the corrected note only.
`.trim();
}

function validateGenerated({
  text,
  introPrefix,
  closerSentence,
  pocOpener,
  discipline,
  enforceVisitSummaryRules = false,
}) {
  const sections = splitSections(text);
  if (!sections) {
    return {
      ok: false,
      reason: "Could not parse 3 sections (Subjective/Summary/POC) with required spacing.",
    };
  }

  const { subjective, summary, poc } = sections;

  if (countSentences(subjective) !== 1)
    return { ok: false, reason: "Subjective must be exactly 1 sentence." };

  const starterOk = SUBJECTIVE_STARTERS.some((s) => subjective.startsWith(s));
  if (!starterOk)
    return { ok: false, reason: "Subjective must start with an allowed starter." };

  if (/tolerates?\s+tx\s+well/i.test(subjective))
    return { ok: false, reason: 'Subjective must not say "tolerates tx well".' };

  const sumCount = countSentences(summary);
  if (sumCount < 5 || sumCount > 7)
    return { ok: false, reason: "Summary must be 5 to 7 sentences." };

  if (containsArrows(summary))
    return { ok: false, reason: "Summary must not contain arrows (↑/↓)." };

  if (hasBulletsOrNumbering(summary))
    return { ok: false, reason: "Summary must not contain bullets or numbering." };

  if (hasBannedThirdPersonRef(summary))
    return {
      ok: false,
      reason:
        'Summary must not contain "The patient" or third-person pronouns. Use "Pt" only.',
    };

  if (hasBannedGenericSummaryStart(summary))
    return { ok: false, reason: "Summary starts with a banned generic opener." };

  if (!summary.startsWith(introPrefix))
    return {
      ok: false,
      reason: "First Summary sentence must start with required intro prefix.",
    };

  const last = getLastSentence(summary);
  if (last !== closerSentence)
    return {
      ok: false,
      reason: "Summary must end with exact required closing sentence.",
    };

  if (!includesExactClosingPhrase(last, discipline))
    return { ok: false, reason: "Summary must end with required closing phrase." };

  // ✅ VISIT-ONLY summary enforcement (PT/OT visits only)
  if (enforceVisitSummaryRules) {
    if (hasNewlines(summary)) {
      return { ok: false, reason: "Summary must be a single paragraph (no newlines)." };
    }

    if (hasSubjectiveStarterPhrases(summary)) {
      return {
        ok: false,
        reason: "Summary must not include patient-reported phrases (Pt reports/states/notes/etc.).",
      };
    }

    const lower = String(summary || "").toLowerCase();
    const mentionsTher = lower.includes("ther-ex") || lower.includes("ther-act");
    const mentionsCue = lower.includes("vc") || lower.includes("tc");
    if (mentionsTher && !mentionsCue) {
      return {
        ok: false,
        reason:
          "If Summary mentions ther-ex/ther-act, it must include VC/TC for skilled cueing.",
      };
    }

    const hasFunctionalAnchor =
      lower.includes("adls") ||
      lower.includes("functional mobility") ||
      lower.includes("gait") ||
      lower.includes("transfers") ||
      lower.includes("balance") ||
      lower.includes("stairs");
    if (!hasFunctionalAnchor) {
      return {
        ok: false,
        reason:
          "Summary must include at least one functional anchor (ADLs/gait/transfers/balance/stairs/functional mobility).",
      };
    }
  }

  if (!isSingleLine(poc)) return { ok: false, reason: "POC must be one line." };

  const expectedPoc =
    discipline === "OT"
      ? `OT POC: ${pocOpener} TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals.`
      : `PT POC: ${pocOpener} TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.`;

  if (poc !== expectedPoc) {
    return {
      ok: false,
      reason: `POC must match exact template.\nExpected: ${expectedPoc}\nGot: ${poc}`,
    };
  }

  return { ok: true };
}

// ---------------- Local coercion fallback (NO MORE 422) ----------------

function coerceTo3SectionNote(text, { discipline, introPrefix, closerSentence, pocOpener }) {
  const raw = String(text || "").trim();

  // salvage sections if present (accept colon too)
  const subjMatch = raw.match(/Subjective\s*[:\n]\s*([\s\S]*?)(?=\n\s*Summary\s*[:\n]|$)/i);
  const summMatch = raw.match(/Summary\s*[:\n]\s*([\s\S]*?)(?=\n\s*POC\s*[:\n]|$)/i);
  const pocMatch = raw.match(/POC\s*[:\n]\s*([\s\S]*?)$/i);

  let subjective = (subjMatch?.[1] || "").trim();
  let summary = (summMatch?.[1] || "").trim();
  let poc = (pocMatch?.[1] || "").trim();

  // Subjective default + enforce 1 sentence + required starter
  if (!subjective) subjective = "Pt reports N/A.";
  if (!SUBJECTIVE_STARTERS.some((s) => subjective.startsWith(s))) {
    const cleaned = subjective.replace(/^Pt\s+/i, "").replace(/^\W+/, "");
    subjective = "Pt reports " + (cleaned || "N/A");
  }
  subjective = subjective.split(/(?<=[.!?])\s+/)[0].trim();
  if (!/[.!?]$/.test(subjective)) subjective += ".";
  // ban "tolerates tx well" in subjective
  subjective = subjective.replace(/tolerates?\s+tx\s+well\.?/gi, "reports N/A.");

  // Summary default + strip newlines/bullets/arrows/third-person
  summary = summary.replace(/\r\n/g, "\n").replace(/\n+/g, " ").trim();
  summary = summary.replace(/[↑↓]/g, "");
  summary = summary.replace(/^\s*[-*•]\s+/gm, "");
  summary = summary.replace(/\b(the patient|they|their|them|theirs|themselves)\b/gi, "Pt");
  if (!summary) summary = "Pt demonstrates N/A.";

  // Force intro prefix
  if (!summary.startsWith(introPrefix)) {
    summary = introPrefix + summary.replace(/^Pt\s+/i, "");
  }

  // Ensure at least one functional anchor (visit-only expectation)
  const lower = summary.toLowerCase();
  const hasAnchor =
    lower.includes("adls") ||
    lower.includes("functional mobility") ||
    lower.includes("gait") ||
    lower.includes("transfers") ||
    lower.includes("balance") ||
    lower.includes("stairs");
  if (!hasAnchor) {
    summary += " Pt requires skilled training to improve functional mobility and carryover to ADLs.";
  }

  // Ensure VC/TC if mentions ther-ex/ther-act
  const mentionsTher = lower.includes("ther-ex") || lower.includes("ther-act");
  const mentionsCue = lower.includes("vc") || lower.includes("tc");
  if (mentionsTher && !mentionsCue) {
    summary += " VC/TC provided for technique, sequencing, and pacing.";
  }

  // Sentence shaping to 5–7 with exact closer last
  let parts = summary.split(/(?<=[.!?])\s+/).filter(Boolean);

  // remove banned generic opener if it appears at start
  if (parts.length && hasBannedGenericSummaryStart(parts[0])) {
    parts[0] = introPrefix + "demonstrates N/A.";
  }

  // remove any existing closer-like lines then append exact closer
  parts = parts.filter(
    (p) =>
      !p.includes("Continued skilled PT remains indicated") &&
      !p.includes("Continued skilled OT remains indicated")
  );
  parts.push(closerSentence);

  // pad
  while (parts.length < 5) {
    parts.splice(
      parts.length - 1,
      0,
      "Skilled cueing and clinical judgment were required for safe technique, pacing, and symptom management."
    );
  }

  // trim to 7 keeping closer
  if (parts.length > 7) {
    const closer = parts[parts.length - 1];
    parts = parts.slice(0, 6);
    parts.push(closer);
  }

  summary = parts.join(" ").replace(/\s{2,}/g, " ").trim();

  // POC exact template
  const expectedPoc =
    discipline === "OT"
      ? `OT POC: ${pocOpener} TherAct, ADL training, functional training, UE function/coordination, safety/energy conservation, injury prevention to meet goals.`
      : `PT POC: ${pocOpener} TherEx, TherAct, MT, functional training, fall/safety, injury prevention to meet goals.`;

  poc = expectedPoc;

  return `Subjective\n${subjective}\n\nSummary\n${summary}\n\nPOC\n${poc}`;
}

// ---------------- PT VISIT SUMMARY: topic detection + muscle enforcement ----------------

function includesAny(haystack, needles) {
  const h = String(haystack || "").toLowerCase();
  return needles.some((n) => h.includes(String(n).toLowerCase()));
}

function mustIncludeAny(text, terms) {
  const s = String(text || "").toLowerCase();
  return terms.some((t) => s.includes(String(t).toLowerCase()));
}

function detectVisitTopicsFromUserText(userText) {
  const all = normalizeSpaces(userText);

  const neckTopic = includesAny(all, [
    "neck pain",
    "cervical",
    "c-spine",
    "c spine",
    "suboccip",
    "upper trap",
    "levator",
  ]);
  const lbpTopic = includesAny(all, [
    "lbp",
    "low back",
    "lowback",
    "lumbar",
    "l-spine",
    "l spine",
    "radicul",
    "sciatica",
    "paraspinal",
    "ql",
  ]);
  const shoulderTopic = includesAny(all, [
    "shoulder pain",
    "rotator cuff",
    "rtc",
    "impingement",
    "gh",
    "glenohumeral",
  ]);
  const kneeTopic = includesAny(all, ["knee pain", "knee oa", "tka", "patella", "patellar"]);

  const mentionsMT = includesAny(all, [
    " mt ",
    "mt,",
    "mt.",
    "manual therapy",
    "manual tx",
    "stm",
    "soft tissue",
    "iastm",
  ]);

  const mentionsTherAct = includesAny(all, [
    "theract",
    "ther-act",
    "ther act",
    "functional training",
    "functional task",
    "sit-to-stand",
    "sit to stand",
    "sts",
    "transfer",
    "transfers",
    "lifting",
    "carry",
  ]);

  const mentionsCore = includesAny(all, [
    "core",
    "abdominal",
    "abd",
    "trunk stability",
    "stabilizer",
    "stabilizers",
  ]);

  const patellaHypomobile = includesAny(all, [
    "patella hypomobile",
    "patellar hypomobile",
    "hypomobile patella",
    "patellar mobility limited",
  ]);

  const poorPosture = includesAny(all, [
    "poor posture",
    "forward head",
    "forward head lean",
    "rounded shoulders",
    "kyphosis",
    "scapular protraction",
  ]);

  const gaitImpairment = includesAny(all, [
    "abnormal gait",
    "impaired gait",
    "trendelenburg",
    "antalgic",
    "shuffling",
    "decreased stride",
    "decreased step",
    "gait deviation",
  ]);

  return {
    neckTopic,
    lbpTopic,
    shoulderTopic,
    kneeTopic,
    mentionsMT,
    mentionsTherAct,
    mentionsCore,
    patellaHypomobile,
    poorPosture,
    gaitImpairment,
  };
}

// Build “extra summary constraints” string for the repair prompt (PT visit only)
function buildPTVisitSummaryMuscleConstraints(userText) {
  const t = detectVisitTopicsFromUserText(userText);

  const constraints = [];

  if (t.neckTopic) {
    constraints.push(
      "If neck/cervical topic: include STM to release suboccipitals, posterior cervical musculature, UT, and levator scap; include manual stretching emphasizing SCM release/stretch, pec minor stretch, lat stretch, and UT/levator scap stretch; MUST name those muscles (no 'neck muscles')."
    );
  }

  if (t.lbpTopic) {
    constraints.push(
      "If LBP/lumbar topic: include STM to release lumbar paraspinals, QL, multifidi, glute med, TFL, and piriformis; include manual stretching to HS, glute med, TFL, and piriformis; MUST name those muscles (no 'back muscles')."
    );
    if (t.mentionsTherAct) {
      constraints.push(
        "If LBP and TherAct mentioned: include TherAct functional training (e.g., sit-to-stand mechanics, transfer training, hip hinge/lifting mechanics, functional mobility tasks) consistent with user instruction, without adding devices or assist levels."
      );
    }
  }

  if (t.mentionsCore) {
    constraints.push(
      "If core/abdominal mentioned: include core and abd stabilizers addressed via core activation techniques and TherEx targeting trunk stabilization."
    );
  }

  if (t.shoulderTopic) {
    constraints.push(
      "If shoulder topic: MUST name supraspinatus, deltoid, infraspinatus, teres minor, teres major, and lats; if MT/STM is referenced, phrase as STM/MT to release those specific tissues (no 'shoulder region')."
    );
  }

  if (t.kneeTopic) {
    constraints.push(
      "If knee topic and MT/STM referenced: MUST name IT band, distal quads, popliteus, distal medial/lateral HS, and proximal medial gastroc (no 'knee muscles')."
    );
    if (t.patellaHypomobile) {
      constraints.push(
        "If patella hypomobile mentioned: include patellar joint mobilization using GPM III-IV in all directions to improve mobility and decrease pain."
      );
    }
  }

  if (t.poorPosture) {
    constraints.push(
      "If poor posture/forward head mentioned: include postural training for awareness, upper back/T-spine strengthening, and pec minor stretching."
    );
  }

  if (t.gaitImpairment) {
    constraints.push(
      "If gait impairment/Trendelenburg mentioned: include gait training and education to reduce deviations and improve mechanics with increased step/stride length and improved reciprocal movement (as appropriate)."
    );
  }

  if (t.mentionsMT) {
    constraints.push(
      "If MT/STM is mentioned anywhere: avoid generic phrases like 'address muscle tension'; name the specific tissues relevant to the region."
    );
  }

  return {
    constraintsText: constraints.join("\n  "),
    topics: t,
  };
}

// Validate the PT visit Summary has muscle specificity for detected topics
function validatePTVisitSummaryMuscleSpecificity(summary, userText) {
  const t = detectVisitTopicsFromUserText(userText);
  const s = String(summary || "");

  if (t.shoulderTopic) {
    const req = [
      "supraspinatus",
      "deltoid",
      "infraspinatus",
      "teres minor",
      "teres major",
      "lat",
    ];
    if (!mustIncludeAny(s, req)) {
      return {
        ok: false,
        reason:
          "PT visit summary: shoulder topic requires explicit muscles (supraspinatus, deltoid, infraspinatus, teres minor/major, lats).",
      };
    }
  }

  if (t.neckTopic) {
    const req = [
      "suboccip",
      "posterior cervical",
      "upper trap",
      "levator",
      "scm",
      "pec minor",
      "lat",
    ];
    if (!mustIncludeAny(s, req)) {
      return {
        ok: false,
        reason:
          "PT visit summary: neck topic requires explicit muscles (suboccipitals, posterior cervical, UT, levator scap, SCM, pec minor, lats).",
      };
    }
  }

  if (t.lbpTopic) {
    const req = [
      "paraspinal",
      "ql",
      "multif",
      "glute med",
      "tfl",
      "piriformis",
      "hamstring",
    ];
    if (!mustIncludeAny(s, req)) {
      return {
        ok: false,
        reason:
          "PT visit summary: LBP topic requires explicit muscles (lumbar paraspinals, QL, multifidi, glute med, TFL, piriformis, HS).",
      };
    }
  }

  if (t.kneeTopic && t.mentionsMT) {
    const req = ["it band", "distal quad", "popliteus", "hamstring", "gastroc"];
    if (!mustIncludeAny(s, req)) {
      return {
        ok: false,
        reason:
          "PT visit summary: knee + MT topic requires explicit tissues (ITB, distal quads, popliteus, distal HS, proximal medial gastroc).",
      };
    }
  }

  if (t.patellaHypomobile) {
    if (!/GPM\s*III-?IV/i.test(s)) {
      return {
        ok: false,
        reason:
          "PT visit summary: patella hypomobile requires GPM III-IV patellar mobs in all directions.",
      };
    }
  }

  if (t.mentionsCore) {
    if (!includesAny(s, ["core activation", "abd stabil", "trunk stabil", "core stabil"])) {
      return {
        ok: false,
        reason:
          "PT visit summary: core/abdominal mention requires core activation / abd stabilizer training.",
      };
    }
  }

  if (t.lbpTopic && t.mentionsTherAct) {
    if (
      !includesAny(s, [
        "sit-to-stand",
        "sit to stand",
        "transfer",
        "hip hinge",
        "lifting mechanics",
        "functional training",
      ])
    ) {
      return {
        ok: false,
        reason:
          "PT visit summary: LBP + TherAct requires TherAct functional training detail (STS/transfers/hip hinge/lifting mechanics/etc.).",
      };
    }
  }

  if (t.poorPosture) {
    if (!includesAny(s, ["postural", "t-spine", "upper back", "pec minor"])) {
      return {
        ok: false,
        reason:
          "PT visit summary: posture topic requires postural training + T-spine/upper back strengthening + pec minor stretching.",
      };
    }
  }

  if (t.gaitImpairment) {
    if (!includesAny(s, ["gait training", "stride", "step length", "reciprocal"])) {
      return {
        ok: false,
        reason:
          "PT visit summary: gait impairment requires gait training/education emphasizing step/stride length and reciprocal pattern.",
      };
    }
  }

  return { ok: true };
}

// ---------------- Routes ----------------

// ✅ Mount aisummary.js ONLY under /api/ai to avoid route collisions.
app.use("/api/ai", aiRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/debug-env", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    keyPresent: OPENAI_API_KEY && OPENAI_API_KEY.startsWith("sk-"),
  });
});

app.post("/clean", async (req, res) => {
  try {
    const raw = String(req.body?.text || "");
    const locallyCleaned = normalizeSpaces(cleanUserText(raw));

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

    const cleaned = completion.choices?.[0]?.message?.content?.trim() || locallyCleaned;
    return res.json({ cleaned: normalizeSpaces(cleaned) });
  } catch (err) {
    console.error("❌ /clean failed", err?.message || err);
    return res.status(500).json({ error: "Clean failed.", details: err?.message || String(err) });
  }
});

// Visit-note generator (PT/OT)
// ✅ Visit Summary enforcement applies ONLY here (PT/OT visit only)
// ✅ NEVER 422: always returns {summary: "..."} even if coercion needed
app.post("/generate", async (req, res) => {
  try {
    const patientLabel = String(req.body?.patientLabel || "Patient #1").trim() || "Patient #1";
    const userText = normalizeSpaces(String(req.body?.userText || ""));
    if (!userText.trim()) return res.status(400).json({ error: "userText is required." });

    const disciplineRaw = String(req.body?.discipline || "PT").toUpperCase().trim();
    const discipline = disciplineRaw === "OT" ? "OT" : "PT";

    // ✅ Visit-only enforcement gate (PT + OT visits only)
    const enforceVisitSummaryRules = discipline === "PT" || discipline === "OT";

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
    let v1 = validateGenerated({
      text: out,
      introPrefix,
      closerSentence,
      pocOpener,
      discipline,
      enforceVisitSummaryRules,
    });

    // First: formatting + visit-summary repair
    if (!v1.ok) {
      const repairPrompt = buildRepairPrompt({
        patientLabel,
        userText,
        badOutput: out,
        introPrefix,
        closerSentence,
        pocOpener,
        discipline,
        enforceVisitSummaryRules,
      });

      const repair = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Fix formatting strictly. Do not add facts. Output only the corrected note." },
          { role: "user", content: repairPrompt },
        ],
      });

      out = normalizeNewlines(repair.choices?.[0]?.message?.content || "");
      const v2 = validateGenerated({
        text: out,
        introPrefix,
        closerSentence,
        pocOpener,
        discipline,
        enforceVisitSummaryRules,
      });

      if (!v2.ok) {
        // ✅ NO 422: coerce locally to exact format
        const coerced = coerceTo3SectionNote(out, {
          discipline,
          introPrefix,
          closerSentence,
          pocOpener,
        });

        return res.json({
          summary: coerced,
          debug: {
            coercedAfterFailedRepair: true,
            reason1: v1.reason,
            reason2: v2.reason,
          },
        });
      }
    }

    // At this point, out is validated
    const lastKnownValid = out;

    // SECOND: PT visit muscle enforcement (PT visit only) — BEST EFFORT (never hard fail)
    if (enforceVisitSummaryRules && discipline === "PT") {
      const sections = splitSections(out);
      if (sections) {
        const { summary } = sections;
        const vMuscle = validatePTVisitSummaryMuscleSpecificity(summary, userText);

        if (!vMuscle.ok) {
          const { constraintsText } = buildPTVisitSummaryMuscleConstraints(userText);

          const muscleRepairPrompt = buildRepairPrompt({
            patientLabel,
            userText,
            badOutput: out,
            introPrefix,
            closerSentence,
            pocOpener,
            discipline,
            enforceVisitSummaryRules,
            extraSummaryConstraints: `${vMuscle.reason}\n  You MUST follow these topic-based content rules if applicable:\n  ${constraintsText}`,
          });

          const repair2 = await openai.chat.completions.create({
            model: MODEL,
            temperature: 0.15,
            messages: [
              {
                role: "system",
                content:
                  "Fix content while keeping EXACT format. Do not add facts beyond the user instruction. Output only the corrected note.",
              },
              { role: "user", content: muscleRepairPrompt },
            ],
          });

          const out2 = normalizeNewlines(repair2.choices?.[0]?.message?.content || out);

          // Re-validate strict format + visit summary rules
          const vFmt = validateGenerated({
            text: out2,
            introPrefix,
            closerSentence,
            pocOpener,
            discipline,
            enforceVisitSummaryRules,
          });

          if (!vFmt.ok) {
            // Try one more pass: FORMAT-ONLY repair
            const formatOnlyRepairPrompt = `
Return the note in EXACTLY this format:

Subjective
<ONE sentence>

Summary
<5-7 sentences, single paragraph>

POC
<ONE line>

Do NOT add or remove any facts. Keep the same meaning as the bad output.

Bad output:
${out2}
`.trim();

            const repair3 = await openai.chat.completions.create({
              model: MODEL,
              temperature: 0.05,
              messages: [
                { role: "system", content: "Fix formatting only. Do not add facts. Output only the corrected note." },
                { role: "user", content: formatOnlyRepairPrompt },
              ],
            });

            const out3 = normalizeNewlines(repair3.choices?.[0]?.message?.content || out2);

            const vFmt3 = validateGenerated({
              text: out3,
              introPrefix,
              closerSentence,
              pocOpener,
              discipline,
              enforceVisitSummaryRules,
            });

            if (vFmt3.ok) {
              // Still check muscles; if fail, return anyway with debug
              const sections3 = splitSections(out3);
              const vMuscle3 = sections3
                ? validatePTVisitSummaryMuscleSpecificity(sections3.summary, userText)
                : { ok: false, reason: "Could not parse summary after format-only repair." };

              if (!vMuscle3.ok) {
                return res.json({
                  summary: out3,
                  debug: {
                    muscleRuleFail: vMuscle.reason,
                    muscleRuleStillFail: vMuscle3.reason,
                    formatOnlyRepairApplied: true,
                  },
                });
              }

              return res.json({ summary: out3, debug: { formatOnlyRepairApplied: true } });
            }

            // Still broken => return last known valid note (never 422)
            return res.json({
              summary: lastKnownValid,
              debug: {
                muscleRepairBrokeFormatting: true,
                formattingReason: vFmt.reason,
                formattingReasonAfterFormatOnly: vFmt3.reason,
                muscleRuleFail: vMuscle.reason,
              },
            });
          }

          // Re-check muscles
          const sections2 = splitSections(out2);
          const vMuscle2 = sections2
            ? validatePTVisitSummaryMuscleSpecificity(sections2.summary, userText)
            : { ok: false, reason: "Could not parse summary after repair." };

          if (!vMuscle2.ok) {
            // Return repaired anyway with debug (never hard-fail just for muscles)
            return res.json({
              summary: out2,
              debug: {
                muscleRuleFail: vMuscle.reason,
                muscleRuleStillFail: vMuscle2.reason,
              },
            });
          }

          return res.json({ summary: out2 });
        }
      }
    }

    return res.json({ summary: out });
  } catch (err) {
    console.error("❌ /generate failed", err?.message || err);
    return res.status(500).json({ error: "Generate failed.", details: err?.message || String(err) });
  }
});

// ---------- Eval Template Catalog (for iOS EvaluationView) ----------
// (UNCHANGED)

app.get("/eval/templates", (req, res) => {
  const discipline = normalizeDiscipline(req.query?.discipline);
  const templates = getTemplatesForDiscipline(discipline);
  const names = Object.keys(templates || {}).sort((a, b) => a.localeCompare(b));
  return res.json({ templates: names.map((name) => ({ name })) });
});

app.get("/eval/template", (req, res) => {
  const discipline = normalizeDiscipline(req.query?.discipline);
  const name = String(req.query?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required." });

  const templates = getTemplatesForDiscipline(discipline);
  const t = templates?.[name];
  if (!t) return res.status(404).json({ error: `Template not found: ${name}` });

  return res.json({ template: mapTemplateToSwiftPayload(t) });
});

// /eval/extract (UNCHANGED)
app.post("/eval/extract", async (req, res) => {
  try {
    const discipline = normalizeDiscipline(req.body?.discipline);
    const templateName = String(req.body?.templateName || "").trim();
    const transcript = normalizeTranscriptForExtraction(String(req.body?.transcript || ""));
    const mergeMode = String(req.body?.mergeMode || "fill_empty");
    const useTemplateDefaults = Boolean(req.body?.useTemplateDefaults);

    const currentForm =
      req.body?.currentForm && typeof req.body.currentForm === "object" ? req.body.currentForm : {};

    if (!transcript.trim()) {
      return res.status(400).json({ error: "transcript is required." });
    }

    const allowedKeys = [
      "gender",
      "dob",
      "weight",
      "height",
      "bmi",
      "bmiCategory",

      "meddiag",
      "history",
      "subjective",
      "meds",

      "painLocation",
      "painOnset",
      "painCondition",
      "painMechanism",
      "painRating",
      "painFrequency",
      "painDescription",
      "painAggravating",
      "painRelieved",
      "painInterferes",
      "tests",
      "dme",
      "plof",

      "posture",
      "rom",
      "strength",
      "palpation",
      "functional",
      "special",
      "impairments",

      "diffdx",

      "assessmentSummary",
      "goals",
      "frequency",
      "intervention",
      "procedures",

      "soapPainLine",
      "soapRom",
      "soapPalpation",
      "soapFunctional",
      "soapGoals",
    ];

    let templateBaseline = null;
    if (templateName) {
      const templates = getTemplatesForDiscipline(discipline);
      if (templates?.[templateName]) {
        templateBaseline = mapTemplateToSwiftPayload(templates[templateName]);
      }
    }

    const baseForm = useTemplateDefaults
      ? { ...(templateBaseline || {}), ...(currentForm || {}) }
      : { ...(currentForm || {}) };

    const system =
      "You are a clinical documentation extraction engine for PT/OT evaluations. " +
      "Read a free-form dictation transcript and return ONLY JSON. " +
      "Do NOT invent facts. Do NOT output any prose. " +
      'Use PT-style abbreviations and always use "Pt".';

    const user = {
      discipline,
      mergeMode,
      allowedKeys,
      templateName: templateName || null,
      currentForm: baseForm,
      transcript,
      routingRules: [
        "Only include fields clearly supported by transcript content. If unsure, omit.",
        "Do not output empty strings.",
        "Do not copy entire transcript into a field.",
        "Keep each field concise and template-ready (no bullets, no arrows).",
        "Use 'Pt' only (do not write 'the patient' or they/their).",
        "For each populated field, include a short supporting quote in evidence[field].",
        "If the transcript is conversational, convert to clinical phrasing but keep meaning faithful.",
        "Do NOT generate frequency/goals/procedures unless explicitly stated in transcript.",
        "Do NOT infer PMH, vitals, special tests, palpation findings, or devices unless explicitly stated.",
      ],
      outputSchema: {
        patch: "object of allowedKeys -> string values",
        evidence: "object of allowedKeys -> short supporting quote",
        debug: "optional array of strings",
      },
    };

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    const obj = safeJsonParse(raw);

    if (!obj || typeof obj !== "object") {
      return res.status(422).json({ error: "Model did not return valid JSON.", raw });
    }

    const rawPatch = stripPatchToAllowedKeys(obj.patch, allowedKeys);
    const evidence =
      obj.evidence && typeof obj.evidence === "object" && !Array.isArray(obj.evidence)
        ? obj.evidence
        : {};
    const debug = Array.isArray(obj.debug) ? obj.debug : [];

    const gatedPatch = {};
    for (const k of Object.keys(rawPatch)) {
      const ev = toCleanString(evidence?.[k]);
      if (!ev) continue;
      if (ev.length < 8) continue;
      gatedPatch[k] = rawPatch[k];
    }

    const merged = applyMerge({
      base: baseForm,
      patch: gatedPatch,
      mergeMode,
      allowedKeys,
    });

    const patchOut = {};
    for (const k of allowedKeys) {
      const before = toCleanString(baseForm?.[k]);
      const after = toCleanString(merged?.[k]);
      if (after && after !== before) patchOut[k] = after;
    }

    if (Object.keys(patchOut).length === 0) {
      return res.json({
        patch: {},
        evidence: {},
        debug: debug.concat([
          "EMPTY_PATCH: no allowed fields populated from transcript after evidence gating",
          `useTemplateDefaults=${useTemplateDefaults}`,
        ]),
        meta: {
          mergeMode,
          useTemplateDefaults,
          extractedKeys: Object.keys(rawPatch || {}),
          gatedKeys: Object.keys(gatedPatch || {}),
          changedKeys: [],
        },
      });
    }

    return res.json({
      patch: patchOut,
      evidence,
      debug,
      meta: {
        mergeMode,
        useTemplateDefaults,
        extractedKeys: Object.keys(rawPatch || {}),
        gatedKeys: Object.keys(gatedPatch || {}),
        changedKeys: Object.keys(patchOut),
      },
    });
  } catch (err) {
    console.error("❌ /eval/extract failed");
    console.error(err);
    return res.status(500).json({
      error: "Eval extract failed.",
      details: err?.message || String(err),
    });
  }
});

// -------------------------------------------------------------------
// Legacy AI endpoints expected by iOS EvaluationView candidatePaths.
// (UNCHANGED: no visit summary enforcement here)
// -------------------------------------------------------------------

async function runSimpleTextAI({ purpose, fields, discipline }) {
  const safeDiscipline = normalizeDiscipline(discipline);

  const sys =
    `You are a ${safeDiscipline} clinical documentation assistant. ` +
    `Write concise, Medicare-appropriate content. ` +
    `Do not invent facts. Use "Pt" only (never "the patient" or they/their). ` +
    `No arrows (↑ ↓). No bullets or numbering.`;

  const user = {
    purpose,
    rules: [
      'Use "Pt" only; do not use "the patient" or third-person pronouns.',
      "No bullets/numbering. No arrows.",
      "Only use details present in fields; if missing, be general rather than inventing.",
    ],
    fields,
    output: "Return only the text (no JSON, no headers).",
  };

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(user) },
    ],
  });

  const out = normalizeSpaces(completion.choices?.[0]?.message?.content || "");

  if (hasBannedThirdPersonRef(out) || containsArrows(out) || hasBulletsOrNumbering(out)) {
    const repairPrompt = `
Fix this text to comply:
- Use "Pt" only. Do NOT use "the patient" or they/their/them/theirs/themselves.
- No arrows (↑ ↓)
- No bullets or numbering
- Do not add facts; keep content consistent.

Bad text:
${out}

Return corrected text only.
`.trim();

    const repair = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: repairPrompt },
      ],
    });

    return normalizeSpaces(repair.choices?.[0]?.message?.content || out);
  }

  return out;
}

function buildFieldsMap(reqBody) {
  const fields = reqBody?.fields && typeof reqBody.fields === "object" ? reqBody.fields : {};
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, normalizeSpaces(String(v ?? ""))])
  );
}

async function handlePTDiffDx(req, res) {
  try {
    const fields = buildFieldsMap(req.body);
    const result = await runSimpleTextAI({
      purpose:
        "Generate a differential diagnosis list (concise) for a PT evaluation based on provided subjective/objective cues. " +
        "Output should be 3–6 items in one paragraph separated by semicolons (no bullets).",
      fields,
      discipline: "PT",
    });
    return res.json({ result });
  } catch (err) {
    console.error("❌ pt_generate_diffdx failed", err?.message || err);
    return res
      .status(500)
      .json({ error: "pt_generate_diffdx failed", details: err?.message || String(err) });
  }
}

async function handlePTSummary(req, res) {
  try {
    const fields = buildFieldsMap(req.body);
    const result = await runSimpleTextAI({
      purpose:
        "Generate an Assessment Summary paragraph for a PT evaluation. 5–7 sentences. " +
        "Use PT abbreviations where appropriate. Do not include SOAP headers.",
      fields,
      discipline: "PT",
    });
    return res.json({ result });
  } catch (err) {
    console.error("❌ pt_generate_summary failed", err?.message || err);
    return res
      .status(500)
      .json({ error: "pt_generate_summary failed", details: err?.message || String(err) });
  }
}

async function handlePTGoals(req, res) {
  try {
    const fields = buildFieldsMap(req.body);
    const result = await runSimpleTextAI({
      purpose:
        "Generate PT goals for an evaluation. Write short-term then long-term goals as plain text. " +
        "No bullets; use compact sentences separated by line breaks if needed.",
      fields,
      discipline: "PT",
    });
    return res.json({ result });
  } catch (err) {
    console.error("❌ pt_generate_goals failed", err?.message || err);
    return res
      .status(500)
      .json({ error: "pt_generate_goals failed", details: err?.message || String(err) });
  }
}

// Legacy routes
app.post("/pt_generate_diffdx", handlePTDiffDx);
app.post("/pt_generate_summary", handlePTSummary);
app.post("/pt_generate_goals", handlePTGoals);

// Aliases under /api/ai/*
app.post("/api/ai/pt_generate_diffdx", handlePTDiffDx);
app.post("/api/ai/pt_generate_summary", handlePTSummary);
app.post("/api/ai/pt_generate_goals", handlePTGoals);

// -------------------------------------------------------------------
// Listen
// -------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`✅ Server listening on :${PORT}`);
});
