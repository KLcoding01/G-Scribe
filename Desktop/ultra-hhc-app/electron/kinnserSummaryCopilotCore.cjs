/**
 * Kinnser Summary Copilot — structured context builder + HH PT assessment draft (Anthropic).
 * Clinical text may appear in API requests when the clinician runs generate/improve; stays on device in logs only as redacted metrics.
 */
const https = require('https');
const crypto = require('crypto');
const { classifyKinnserField, FIELD_TYPES } = require('./kinnserFieldIntelligence.cjs');

const ANTHROPIC_API_URL = 'api.anthropic.com';
const MODEL = 'claude-sonnet-4-20250514';
const FAST_MODEL = 'claude-haiku-4-5-20251001';

function callAnthropicMessages(apiKey, userText, maxTokens = 900, useModel, systemPrompt) {
  const chosenModel = useModel || MODEL;
  const body = {
    model: chosenModel,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  };
  // If a system prompt is provided, use it with cache_control for prompt caching
  if (systemPrompt) {
    body.system = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }
  const requestBody = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: ANTHROPIC_API_URL,
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'API error'));
            return;
          }
          const text = parsed.content?.[0]?.text || '';
          const usage = parsed.usage || {};
          if (usage.cache_read_input_tokens) {
            console.log(`[Cache] HIT: ${usage.cache_read_input_tokens} cached tokens (saved ~90% on those). New: ${usage.input_tokens || 0} input, ${usage.output_tokens || 0} output`);
          } else if (usage.cache_creation_input_tokens) {
            console.log(`[Cache] WRITE: ${usage.cache_creation_input_tokens} tokens cached for next calls. Input: ${usage.input_tokens || 0}, Output: ${usage.output_tokens || 0}`);
          }
          resolve({ text: text.trim(), usage });
        } catch {
          reject(new Error('Failed to parse API response'));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error('Network error: ' + e.message));
    });

    req.write(requestBody);
    req.end();
  });
}

const CHAR_BUDGET = 15000;

/**
 * @param {object} snapshot from injected script
 * @param {Array<{ snippet?: string, weight?: number }>} [learnedRows]
 * @param {object} [classification] from classifyKinnserField()
 * @returns {{ structuredText: string, sections: Array<{ title: string, lines: string[] }>, truncated: boolean }}
 */
function buildStructuredNoteContext(snapshot, learnedRows, classification) {
  const s = snapshot || {};
  const sections = [];
  const fc = classification || classifyKinnserField(s);

  const ff = s.focusedField;
  const fieldPurpose = String(ff?.fieldPurpose || s.activeFieldPurpose || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
  if (ff && (ff.value || ff.label)) {
    const lab = String(ff.label || ff.name || ff.id || 'Focused field').slice(0, 200);
    const raw = String(ff.value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2400);
    const trail = Array.isArray(ff.sectionTrail) ? ff.sectionTrail.map((x) => String(x).slice(0, 160)).filter(Boolean) : [];
    const tblParts = [];
    if (ff.tableCaption) tblParts.push(`caption: ${String(ff.tableCaption).slice(0, 120)}`);
    if (ff.tableRow) tblParts.push(`row: ${String(ff.tableRow).slice(0, 140)}`);
    if (ff.tableColumn) tblParts.push(`column: ${String(ff.tableColumn).slice(0, 120)}`);
    const focusLines = [
      'This section is the chart box the clinician is typing in right now — weight it heavily.',
      `label: ${lab}`,
      `identifiers: id=${String(ff.id || '').slice(0, 80)} name=${String(ff.name || '').slice(0, 80)}`,
    ];
    if (fieldPurpose) focusLines.push(`field_purpose: ${fieldPurpose}`);
    if (trail.length) focusLines.push(`section_trail: ${trail.join(' > ')}`);
    if (tblParts.length) focusLines.push(`table_context: ${tblParts.join('; ')}`);
    // Row peer values — sibling cells (assist level, device, checkboxes)
    const rowPeers = Array.isArray(ff.rowPeerValues) ? ff.rowPeerValues : [];
    if (rowPeers.length) {
      const peerStr = rowPeers.map((p) => {
        const col = String(p.column || '').trim();
        const val = String(p.value || '').trim();
        return col ? `${col}: ${val}` : val;
      }).filter(Boolean).join(', ');
      if (peerStr) focusLines.push(`row_peer_values (other cells in same row): ${peerStr}`);
    }
    // Nearby section table data for response/impact fields
    const nearbyData = Array.isArray(ff.nearbySectionData) ? ff.nearbySectionData : [];
    const nearbySectionName = String(ff.nearbySectionName || '').trim();
    if (nearbyData.length) {
      const sectionLabel = nearbySectionName || 'the section above';
      focusLines.push(`section_name: ${sectionLabel}`);
      focusLines.push(`nearby_section_table (training rows from "${sectionLabel}" ONLY):`);
      for (let ni = 0; ni < nearbyData.length && ni < 15; ni++) {
        const row = nearbyData[ni];
        const parts = Object.entries(row).map(([k, v]) => `${k}: ${String(v).slice(0, 100)}`);
        if (parts.length) focusLines.push(`  Row ${ni + 1}: ${parts.join(' | ')}`);
      }
    }
    // Vitals context
    const vitals = ff.vitalsContext || {};
    const vParts = [];
    if (vitals.bpSystolic || vitals.bpDiastolic) vParts.push(`BP: ${vitals.bpSystolic || '?'}/${vitals.bpDiastolic || '?'}`);
    if (vitals.heartRate) vParts.push(`HR: ${vitals.heartRate}`);
    if (vitals.respirations) vParts.push(`Resp: ${vitals.respirations}`);
    if (vitals.temperature) vParts.push(`Temp: ${vitals.temperature}`);
    if (vitals.o2Sat) vParts.push(`O2 Sat: ${vitals.o2Sat}`);
    if (vitals.pain) vParts.push(`Pain: ${vitals.pain}`);
    if (vParts.length) {
      focusLines.push(`vitals_on_page: ${vParts.join(', ')}`);
      const sys = Number(vitals.bpSystolic) || 0;
      const dia = Number(vitals.bpDiastolic) || 0;
      const hr = Number(vitals.heartRate) || 0;
      const temp = Number(vitals.temperature) || 0;
      const flags = [];
      if (sys >= 180 || dia >= 120) flags.push('HYPERTENSIVE CRISIS');
      else if (sys >= 140 || dia >= 90) flags.push('ELEVATED BP');
      if (hr > 100) flags.push('TACHYCARDIA');
      if (temp >= 100.4) flags.push('FEVER');
      if (flags.length) focusLines.push(`clinical_flags: ${flags.join(', ')}`);
    }
    focusLines.push(`content:\n${raw}`);
    sections.push({
      title: 'PRIMARY_FOCUS_FIELD',
      lines: focusLines,
    });
  }

  const metaLines = [
    `path: ${String(s.path || '').slice(0, 400)}`,
    `title: ${String(s.title || '').slice(0, 300)}`,
  ];
  if (s.activeSummaryLabel) metaLines.push(`active_summary_label: ${String(s.activeSummaryLabel).slice(0, 200)}`);
  if (fieldPurpose && !(ff && (ff.value || ff.label))) metaLines.push(`active_field_purpose: ${fieldPurpose}`);
  sections.push({ title: 'Page', lines: metaLines });

  sections.push({
    title: 'FIELD_INTELLIGENCE',
    lines: [
      `inferred_field_type: ${fc.fieldType}`,
      `confidence: ${fc.confidence}`,
      `signals_used: ${(fc.signals || []).slice(0, 10).join('; ') || 'none'}`,
      `strategy_role: ${fc.strategy.role}`,
      `strategy_task: ${fc.strategy.task}`,
      `length_guidance: ${fc.strategy.sentences}`,
      `constraints: ${fc.strategy.constraints}`,
    ],
  });

  const learned = Array.isArray(learnedRows) ? learnedRows : [];
  const learnedSnips = learned
    .map((r) => (r && r.snippet ? String(r.snippet).trim() : ''))
    .filter(Boolean)
    .slice(0, 14);
  if (learnedSnips.length) {
    sections.push({
      title: 'Clinician_taught_preferences',
      lines: [
        'Saved on this device for this chart context; entries matching the current field purpose are listed first when available.',
        ...learnedSnips.map((x, i) => `${i + 1}. ${x.slice(0, 500)}`),
      ],
    });
  }

  const headings = Array.isArray(s.headings) ? s.headings : [];
  if (headings.length) {
    sections.push({
      title: 'Visible_headings',
      lines: headings.slice(0, 40).map((h) => String(h).slice(0, 200)),
    });
  }

  const fields = Array.isArray(s.fields) ? s.fields : [];
  const focusId = ff && ff.id ? String(ff.id) : '';
  const focusName = ff && ff.name ? String(ff.name) : '';
  const fieldLines = [];
  for (const f of fields.slice(0, 120)) {
    if (!f) continue;
    if (focusId && String(f.id || '') === focusId) continue;
    if (focusName && String(f.name || '') === focusName && String(f.role || '') === 'textarea') continue;
    const label = String(f.label || f.name || f.id || 'field').slice(0, 160);
    const role = String(f.role || 'input');
    const val = String(f.value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    fieldLines.push(`[${role}] ${label}: ${val}`);
  }
  if (fieldLines.length) sections.push({ title: 'Rest_of_chart_note', lines: fieldLines });

  // Extract assist levels for clinical mapping
  const assistLevels = extractAssistLevels(fields);
  if (assistLevels) {
    const assistLines = [
      'Detected assist levels from the chart (use these to calibrate documentation language):',
      'Indep=no help | Mod I=device/extra time | SUP=verbal cues only | SBA=standby, arm\'s reach | CGA=contact guard, no lifting | Min A=patient 75%+ | Mod A=patient 50-74% | Max A=patient 25-49% | Dep=patient <25%',
    ];
    for (const [domain, tasks] of Object.entries(assistLevels)) {
      const taskStr = tasks.map((t) => `${t.task}: ${t.level}`).join(', ');
      assistLines.push(`${domain} — ${taskStr}`);
    }
    sections.push({ title: 'Assist_levels', lines: assistLines });
  }

  // Extract pain context for pain-related fields
  const painCtx = extractPainContext(fields, ff);
  if (painCtx) {
    const painLines = [
      `Pain location: ${painCtx.location} (${painCtx.region})`,
    ];
    if (painCtx.intensity) painLines.push(`Pain intensity: ${painCtx.intensity}`);
    painLines.push(`Clinically increased by: ${painCtx.increasedBy}`);
    painLines.push(`Clinically relieved by: ${painCtx.relievedBy}`);
    painLines.push(`Clinically interferes with: ${painCtx.interferesWith}`);
    sections.push({ title: 'Pain_context', lines: painLines });
  }

  let structuredText = '';
  let truncated = false;
  for (const sec of sections) {
    const block = `## ${sec.title}\n${sec.lines.join('\n')}\n\n`;
    if (structuredText.length + block.length > CHAR_BUDGET) {
      truncated = true;
      const room = CHAR_BUDGET - structuredText.length - 50;
      if (room > 80) {
        structuredText += block.slice(0, room) + '\n…[truncated for speed]';
      }
      break;
    }
    structuredText += block;
  }

  return { structuredText: structuredText.trim(), sections, truncated };
}

function fingerprintContext(snapshot) {
  const s = snapshot || {};
  const path = String(s.path || '');
  const ff = s.focusedField || {};
  const fp = String(ff.fieldPurpose || s.activeFieldPurpose || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const fields = Array.isArray(s.fields) ? s.fields : [];
  const parts = fields.map((f) => {
    if (!f) return '';
    const lab = String(f.label || f.name || f.id || '');
    const len = String(f.value || '').length;
    let bucket = '0';
    if (len > 80) bucket = '81+';
    else if (len > 20) bucket = '21-80';
    else if (len > 0) bucket = '1-20';
    return `${lab}:${bucket}`;
  });
  parts.sort();
  const cls = classifyKinnserField(s);
  const raw = path + '|purpose:' + fp + '|type:' + cls.fieldType + '|conf:' + String(cls.confidence) + '|' + parts.join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** @param {object} classification from classifyKinnserField() */
function buildGeneratePrompt(structuredText, mode, priorDraft, improveHint, classification, fieldRules) {
  const fc = classification || classifyKinnserField({});
  const strat = fc.strategy;
  const lowConf = fc.confidence < 0.42;
  const rules = Array.isArray(fieldRules) ? fieldRules.filter(Boolean) : [];
  const rulesBlock = rules.length
    ? `\n## MANDATORY RULES for this field (the clinician set these — follow them strictly)\n${rules.map((r, i) => `${i + 1}. ${String(r).slice(0, 300)}`).join('\n')}\n`
    : '';

  const baseRules = `You are a home health physical therapy documentation assistant. Using ONLY the structured EMR context below (it may be incomplete), produce text for the ACTIVE chart box.

## Detected field role
- **inferred_field_type**: ${fc.fieldType}
- **confidence** (0–1): ${fc.confidence}${lowConf ? ' — confidence is LOW; stay conservative and do not over-speculate.' : ''}
- **signals**: ${(fc.signals || []).slice(0, 8).join('; ') || 'none'}

## Instructions for THIS field type (follow strictly — do not use assessment-summary style for a subjective-only box or vice versa)
- **Role**: ${strat.role}
- **Task**: ${strat.task}
- **Length**: ${strat.sentences}
- **Constraints**: ${strat.constraints}

## Global rules
- **PRIMARY_FOCUS_FIELD** + **field_purpose** / **section_trail** / **table_context** define the box — match abbreviations and shorthand when consistent (e.g. B=bilateral, LE=lower extremity, AD=assistive device).
- **FIELD_INTELLIGENCE** mirrors the same classification — stay consistent with it.
- **Rest_of_chart_note** + **Visible_headings**: do not contradict; use only as supporting context.
- **Clinician_taught_preferences**: honor tone and vocabulary when they fit the facts.
- Professional clinical tone; past tense for visit findings where appropriate unless the field is purely patient-reported subjective wording.
- Do not invent measurements, vitals, MMT grades, or tests not in context.
- No patient name, full address, phone, or MRN; use "the patient" if needed.
- No bullet points; no title line; plain prose only.
${rulesBlock}
Structured context:
---
${structuredText}
---`;

  if (mode === 'improve') {
    return `${baseRules}

Prior draft (revise; keep the SAME field type (${fc.fieldType}) and length guidance above):
---
${String(priorDraft || '').trim()}
---

Clinician request: ${String(improveHint || 'Tighten wording and improve clinical clarity without adding unsupported facts.')}

Output ONLY the revised text for this field.`;
  }

  if (mode === 'regenerate') {
    const hintExtra =
      improveHint && String(improveHint).trim()
        ? `\n\nClinician preferences for this run (from teach box):\n${String(improveHint).trim()}\n`
        : '';
    return `${baseRules}${hintExtra}

Produce an alternative wording clearly different from typical boilerplate while staying within the field type (${fc.fieldType}) and length guidance.

Output ONLY the narrative.`;
  }

  const runHint =
    improveHint && String(improveHint).trim()
      ? `\n\nOptional preferences (abbreviations, tone — from teach box; use only if consistent with chart facts):\n${String(improveHint).trim()}\n`
      : '';
  return `${baseRules}${runHint}

Output ONLY the text for this field.`;
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {object} opts.snapshot
 * @param {'generate'|'regenerate'|'improve'} opts.mode
 * @param {string} [opts.priorDraft]
 * @param {string} [opts.improveHint]
 * @param {Array<{ snippet?: string, weight?: number }>} [opts.learnedRows]
 */
function maxTokensForFieldType(fieldType) {
  switch (fieldType) {
    case FIELD_TYPES.VITALS:
    case FIELD_TYPES.PLAN:
    case FIELD_TYPES.EDUCATION:
    case FIELD_TYPES.CAREGIVER_TRAINING:
    case FIELD_TYPES.PAIN:
      return 750;
    case FIELD_TYPES.INTERVENTIONS:
    case FIELD_TYPES.GAIT:
    case FIELD_TYPES.TRANSFERS:
    case FIELD_TYPES.BALANCE:
      return 820;
    default:
      return 900;
  }
}

const ONE_LINE_CTX_BUDGET = 6200;

/**
 * Compact context for a single contextual suggestion line (not full SOAP builder).
 * @param {object} snapshot
 * @param {string[]} memoryPhraseHints — prior saves; model must not copy verbatim
 * @param {boolean} [preferAverageStyle] — many saved lines: bias toward typical length/tone
 */
/**
 * Detect assist levels from captured fields (bed mobility, gait, transfers, balance).
 * Returns structured object with domain → { task → level } mappings.
 */
function extractAssistLevels(fields) {
  if (!Array.isArray(fields) || !fields.length) return null;
  const ASSIST_RE = /\b(indep(?:endent)?|mod(?:ified)?\s*i(?:ndep)?|sup(?:ervision)?|sba|cga|min(?:imal)?\s*a(?:ssist)?|mod(?:erate)?\s*a(?:ssist)?|max(?:imal|imum)?\s*a(?:ssist)?|dep(?:endent)?|contact guard|stand[- ]?by)\b/i;
  const DOMAIN_PATTERNS = [
    { domain: 'Bed Mobility', keywords: /bed mobility|rolling|supine|sit\s*-?\s*supine/i },
    { domain: 'Gait', keywords: /gait|ambulation|walking|level surface|uneven|stairs/i },
    { domain: 'Transfers', keywords: /transfer|sit\s*-?\s*stand|bed\s*.*wheelchair|toilet/i },
    { domain: 'Balance', keywords: /balance|standing balance|dynamic balance|static balance/i },
  ];
  const results = {};
  for (const f of fields) {
    const lab = String(f.label || f.name || f.id || '').trim();
    const val = String(f.value || '').trim();
    if (!val) continue;
    const assistMatch = val.match(ASSIST_RE);
    if (!assistMatch) continue;
    const level = assistMatch[1].trim();
    for (const dp of DOMAIN_PATTERNS) {
      if (dp.keywords.test(lab)) {
        if (!results[dp.domain]) results[dp.domain] = [];
        results[dp.domain].push({ task: lab.slice(0, 60), level });
        break;
      }
    }
  }
  if (!Object.keys(results).length) return null;
  return results;
}

/**
 * Extract pain location from snapshot fields and map to clinical context.
 * Returns { location, region, increasedBy, relievedBy, interferesWith } or null.
 */
function extractPainContext(fields, focusedField) {
  if (!Array.isArray(fields)) return null;
  const ff = focusedField || {};
  const ffPurpose = String(ff.fieldPurpose || '').toLowerCase();
  const ffLabel = String(ff.label || '').toLowerCase();
  // Only activate for pain-related fields
  const isPainField = /pain|increased by|relieved by|interferes with|aggravat/i.test(ffPurpose + ' ' + ffLabel);
  if (!isPainField) return null;

  // Find pain location from fields
  let location = '';
  let intensity = '';
  for (const f of fields) {
    const lab = String(f.label || f.name || '').toLowerCase();
    const val = String(f.value || '').trim();
    if (!val) continue;
    if (/location/i.test(lab) && val.length > 1 && val.length < 60) {
      if (!location) location = val;
      else location += ', ' + val;
    }
    if (/intensity|pre.?therapy|pain.*scale/i.test(lab) && /\d/.test(val)) {
      if (!intensity) intensity = val;
    }
  }
  // Also check row peer values
  const peers = Array.isArray(ff.rowPeerValues) ? ff.rowPeerValues : [];
  for (const p of peers) {
    const col = String(p.column || '').toLowerCase();
    const val = String(p.value || '').trim();
    if (/location/i.test(col) && val.length > 1) {
      if (!location) location = val;
    }
  }
  if (!location) return null;

  const loc = location.toLowerCase();
  const REGION_MAP = {
    knee: {
      region: 'knee',
      increasedBy: 'ambulation, transfers, stair climbing, squatting, prolonged standing, weight-bearing activities, bending',
      relievedBy: 'rest, ice, elevation, non-weight-bearing position, sitting',
      interferesWith: 'functional mobility, ambulation, transfers, stair negotiation, lower extremity exercises',
    },
    hip: {
      region: 'hip',
      increasedBy: 'ambulation, sit-to-stand transfers, stair climbing, weight bearing, hip flexion/extension, prolonged sitting',
      relievedBy: 'rest, repositioning, ice, supported sitting, non-weight-bearing',
      interferesWith: 'functional mobility, bed mobility, transfers, ambulation, lower body dressing',
    },
    shoulder: {
      region: 'shoulder',
      increasedBy: 'overhead reaching, lifting, pushing/pulling, dressing, grooming, shoulder flexion/abduction',
      relievedBy: 'rest, ice, supported arm position, avoiding overhead activity',
      interferesWith: 'upper extremity ADLs, dressing, grooming, bathing, reaching, functional mobility with AD',
    },
    ankle: {
      region: 'ankle',
      increasedBy: 'ambulation, weight bearing, stair climbing, standing, uneven surfaces, dorsiflexion',
      relievedBy: 'rest, elevation, ice, non-weight-bearing position',
      interferesWith: 'ambulation, balance, transfers, stair negotiation, community mobility',
    },
    foot: {
      region: 'foot',
      increasedBy: 'ambulation, prolonged standing, weight bearing, walking on hard surfaces',
      relievedBy: 'rest, elevation, ice, appropriate footwear, non-weight-bearing',
      interferesWith: 'ambulation, standing tolerance, balance, transfers, community mobility',
    },
    back: {
      region: 'lower back/lumbar',
      increasedBy: 'bending, lifting, prolonged sitting/standing, transitional movements, bed mobility',
      relievedBy: 'rest, repositioning, supported sitting, lumbar support, ice/heat',
      interferesWith: 'bed mobility, transfers, ambulation, bending activities, ADLs, sitting tolerance',
    },
    lumbar: {
      region: 'lumbar spine',
      increasedBy: 'bending, lifting, prolonged sitting/standing, transitional movements, bed mobility',
      relievedBy: 'rest, repositioning, supported sitting, lumbar support, ice/heat',
      interferesWith: 'bed mobility, transfers, ambulation, bending activities, ADLs, sitting tolerance',
    },
    neck: {
      region: 'cervical',
      increasedBy: 'head turning, looking up/down, prolonged static posture, reaching overhead',
      relievedBy: 'rest, supported head position, gentle ROM, ice/heat',
      interferesWith: 'functional mobility, driving, ADLs requiring head movement, balance',
    },
    wrist: {
      region: 'wrist/hand',
      increasedBy: 'gripping, weight bearing through hands, twisting motions, fine motor tasks',
      relievedBy: 'rest, splinting, ice, avoiding gripping',
      interferesWith: 'ADLs, grooming, dressing, meal preparation, assistive device use',
    },
    hand: {
      region: 'hand',
      increasedBy: 'gripping, fine motor tasks, weight bearing through hands, twisting',
      relievedBy: 'rest, splinting, ice, avoiding repetitive gripping',
      interferesWith: 'ADLs, grooming, dressing, feeding, assistive device use, writing',
    },
    elbow: {
      region: 'elbow',
      increasedBy: 'lifting, pushing/pulling, gripping, repetitive forearm rotation, weight bearing',
      relievedBy: 'rest, ice, avoiding aggravating activities, supported position',
      interferesWith: 'ADLs, lifting, carrying, dressing, grooming, assistive device use',
    },
  };

  let matched = null;
  for (const [key, mapping] of Object.entries(REGION_MAP)) {
    if (loc.includes(key)) {
      matched = mapping;
      break;
    }
  }
  // Generic fallback
  if (!matched) {
    matched = {
      region: 'general',
      increasedBy: 'activity, movement, weight bearing, functional tasks',
      relievedBy: 'rest, positioning, ice/heat application',
      interferesWith: 'functional mobility, ADLs, exercise tolerance',
    };
  }

  return {
    location,
    intensity,
    ...matched,
  };
}

function buildOneLineSuggestContext(snapshot, memoryPhraseHints, preferAverageStyle) {
  const s = snapshot || {};
  const classification = classifyKinnserField(snapshot);
  const ff = s.focusedField || {};
  const lines = [];
  const prefer = !!preferAverageStyle;
  lines.push(`INFERRED_FIELD_ROLE: ${classification.fieldType}`);
  lines.push(
    `FOCUSED_FIELD_PURPOSE: ${String(ff.fieldPurpose || s.activeFieldPurpose || '').slice(0, 450)}`
  );
  if (ff.label) lines.push(`FOCUSED_LABEL: ${String(ff.label).slice(0, 200)}`);
  if (ff.tableRow) lines.push(`TABLE_ROW: ${String(ff.tableRow).slice(0, 160)}`);
  if (ff.tableColumn) lines.push(`TABLE_COLUMN: ${String(ff.tableColumn).slice(0, 120)}`);
  // Row peer values — sibling cells in the same table row (assist level, device, checkboxes)
  const peers = Array.isArray(ff.rowPeerValues) ? ff.rowPeerValues : [];
  if (peers.length) {
    const peerStr = peers.map((p) => {
      const col = String(p.column || '').trim();
      const val = String(p.value || '').trim();
      return col ? `${col}=${val}` : val;
    }).filter(Boolean).join(', ');
    if (peerStr) lines.push(`ROW_PEER_VALUES (other cells in this row): ${peerStr}`);
  }
  // Nearby section table data — for response/impact fields that sit below a training table
  const nearbyData = Array.isArray(ff.nearbySectionData) ? ff.nearbySectionData : [];
  const nearbySectionName = String(ff.nearbySectionName || '').trim();
  if (nearbyData.length) {
    const sectionLabel = nearbySectionName || 'the section above';
    lines.push(`SECTION_NAME: ${sectionLabel}`);
    lines.push(`NEARBY_SECTION_TABLE (training rows from "${sectionLabel}" ONLY — write about ONLY these tasks, NOT tasks from other sections):`);
    for (let ni = 0; ni < nearbyData.length && ni < 15; ni++) {
      const row = nearbyData[ni];
      const parts = Object.entries(row).map(([k, v]) => `${k}: ${String(v).slice(0, 100)}`);
      if (parts.length) lines.push(`  Row ${ni + 1}: ${parts.join(' | ')}`);
    }
  }
  // Vitals context — actual vital sign readings from the page
  const vitals = ff.vitalsContext || {};
  const vParts = [];
  if (vitals.bpSystolic || vitals.bpDiastolic) vParts.push(`BP: ${vitals.bpSystolic || '?'}/${vitals.bpDiastolic || '?'}`);
  if (vitals.heartRate) vParts.push(`HR: ${vitals.heartRate}`);
  if (vitals.respirations) vParts.push(`Resp: ${vitals.respirations}`);
  if (vitals.temperature) vParts.push(`Temp: ${vitals.temperature}`);
  if (vitals.o2Sat) vParts.push(`O2 Sat: ${vitals.o2Sat}`);
  if (vitals.pain) vParts.push(`Pain: ${vitals.pain}`);
  if (vParts.length) {
    lines.push(`VITALS_ON_PAGE (actual readings — use these for clinical reasoning): ${vParts.join(', ')}`);
    // Add clinical flags
    const sys = Number(vitals.bpSystolic) || 0;
    const dia = Number(vitals.bpDiastolic) || 0;
    const hr = Number(vitals.heartRate) || 0;
    const temp = Number(vitals.temperature) || 0;
    const flags = [];
    if (sys >= 180 || dia >= 120) flags.push('HYPERTENSIVE CRISIS (BP >= 180/120) — must note elevated BP, MD notification');
    else if (sys >= 140 || dia >= 90) flags.push('ELEVATED BP (>= 140/90) — note hypertension, monitor');
    else if (sys > 0 && sys < 90) flags.push('HYPOTENSION (systolic < 90) — note low BP');
    if (hr > 100) flags.push('TACHYCARDIA (HR > 100)');
    else if (hr > 0 && hr < 60) flags.push('BRADYCARDIA (HR < 60)');
    if (temp >= 100.4) flags.push('FEVER (temp >= 100.4)');
    else if (temp > 0 && temp < 96) flags.push('HYPOTHERMIA (temp < 96)');
    if (flags.length) {
      lines.push(`CLINICAL_FLAGS (IMPORTANT — address these in your response): ${flags.join('; ')}`);
    }
  }
  if (ff.value) lines.push(`TEXT_ALREADY_IN_BOX: ${String(ff.value).replace(/\s+/g, ' ').trim().slice(0, 700)}`);
  const heads = Array.isArray(s.headings) ? s.headings.filter(Boolean).slice(0, 12) : [];
  if (heads.length) lines.push(`PAGE_HEADINGS: ${heads.map((h) => String(h).slice(0, 120)).join(' | ')}`);
  const hints = Array.isArray(memoryPhraseHints) ? memoryPhraseHints : [];
  const maxHints = prefer ? 18 : 8;
  if (hints.length) {
    lines.push(
      prefer && hints.length >= 4
        ? 'PHRASES_CLINICIAN_SAVED_FOR_THIS_FIELD (many examples — infer typical LENGTH, sentence opener pattern, abbreviation density, and clinical TONE as a conceptual average of these lines; do NOT copy or stitch verbatim; write one fresh line grounded in the whole note):'
        : 'PHRASES_CLINICIAN_SAVED_FOR_THIS_FIELD (capture tone, abbreviations, and clinical intent only — do NOT quote or lightly reword; write a fresh line grounded in the whole note):'
    );
    hints.slice(0, maxHints).forEach((h, i) => {
      lines.push(`${i + 1}. ${String(h).replace(/\s+/g, ' ').trim().slice(0, 220)}`);
    });
  }
  const fields = Array.isArray(s.fields) ? s.fields : [];
  const fid = ff.id ? String(ff.id) : '';
  const fnm = ff.name ? String(ff.name) : '';
  for (const f of fields.slice(0, 36)) {
    if (!f) continue;
    if (f.role === 'textarea' && fid && String(f.id || '') === fid) continue;
    if (f.role === 'textarea' && fnm && String(f.name || '') === fnm) continue;
    const lab = String(f.label || f.name || f.id || '').slice(0, 90);
    const val = String(f.value || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!val) continue;
    lines.push(`[${f.role}] ${lab}: ${val}`);
  }
  // Extract and append structured assist levels
  const assistLevels = extractAssistLevels(fields);
  if (assistLevels) {
    const parts = [];
    for (const [domain, tasks] of Object.entries(assistLevels)) {
      const taskStr = tasks.map((t) => `${t.task}=${t.level}`).join(', ');
      parts.push(`${domain}: ${taskStr}`);
    }
    lines.push(`ASSIST_LEVELS_DETECTED: ${parts.join(' | ')}`);
  }
  // Extract pain context for pain-related fields
  const painCtx = extractPainContext(fields, ff);
  if (painCtx) {
    const painParts = [`PAIN_LOCATION: ${painCtx.location}`, `PAIN_REGION: ${painCtx.region}`];
    if (painCtx.intensity) painParts.push(`PAIN_INTENSITY: ${painCtx.intensity}`);
    painParts.push(`CLINICAL_INCREASED_BY: ${painCtx.increasedBy}`);
    painParts.push(`CLINICAL_RELIEVED_BY: ${painCtx.relievedBy}`);
    painParts.push(`CLINICAL_INTERFERES_WITH: ${painCtx.interferesWith}`);
    lines.push(painParts.join('\n'));
  }
  let text = lines.join('\n');
  if (text.length > ONE_LINE_CTX_BUDGET) text = text.slice(0, ONE_LINE_CTX_BUDGET) + '\n…[truncated]';
  return { text, classification };
}

/**
 * One short line synthesized from the whole chart + saved hints (non-verbatim).
 */
async function generateOneLineSuggestion(opts) {
  const { apiKey, snapshot, memoryPhraseHints, avoidPhraseHints, preferAverageStyle, fieldRules, goldenExampleBlock } = opts;
  if (!apiKey) throw new Error('API key not configured');
  const { text, classification } = buildOneLineSuggestContext(
    snapshot,
    memoryPhraseHints,
    preferAverageStyle
  );
  const hints = Array.isArray(memoryPhraseHints) ? memoryPhraseHints : [];
  const avoids = Array.isArray(avoidPhraseHints) ? avoidPhraseHints : [];
  const rules = Array.isArray(fieldRules) ? fieldRules.filter(Boolean).slice(0, 10) : [];
  const avgMode = !!preferAverageStyle && hints.length >= 4;
  const longFormTypes = new Set([
    FIELD_TYPES.SUBJECTIVE,
    FIELD_TYPES.ASSESSMENT,
    FIELD_TYPES.NOTE_SUMMARY,
    FIELD_TYPES.RESPONSE_TO_TREATMENT,
    FIELD_TYPES.GOALS,
    FIELD_TYPES.OBJECTIVE,
  ]);
  const longForm = longFormTypes.has(classification.fieldType);
  const assistDomainTypes = new Set([
    FIELD_TYPES.BED_MOBILITY, FIELD_TYPES.GAIT, FIELD_TYPES.TRANSFERS,
    FIELD_TYPES.BALANCE, FIELD_TYPES.RESPONSE_TO_TREATMENT,
    FIELD_TYPES.INTERVENTIONS, FIELD_TYPES.ASSESSMENT,
    FIELD_TYPES.NOTE_SUMMARY, FIELD_TYPES.OBJECTIVE,
    FIELD_TYPES.FUNCTIONAL_STATUS,
  ]);
  const includeAssistGuidance = assistDomainTypes.has(classification.fieldType) && (text.includes('ASSIST_LEVELS_DETECTED') || text.includes('ROW_PEER_VALUES'));
  const assistGuidance = includeAssistGuidance ? `
- **ASSIST LEVEL CLINICAL MAPPING — match your documentation to the detected levels:**
  Indep = performs safely without help or cues.
  Mod I (Modified Independent) = uses device or extra time, no physical help.
  SUP (Supervision) = standby only, verbal/visual cues, no physical contact.
  SBA (Stand-By Assist) = therapist within arm's reach for safety, minimal cueing.
  CGA (Contact Guard Assist) = therapist maintains contact for safety, no lifting.
  Min A (Minimal Assist) = patient does 75%+, therapist provides ≤25% effort.
  Mod A (Moderate Assist) = patient does 50–74%, therapist provides 25–50% effort.
  Max A (Maximum Assist) = patient does 25–49%, therapist provides 50–75% effort.
  Dep (Dependent) = patient does <25%, therapist provides 75%+ effort.
  Use ASSIST_LEVELS_DETECTED and ROW_PEER_VALUES in context to pick the correct language — document the patient's performance, cueing needs, and physical assistance consistent with the actual assist level recorded for THIS specific row. Do NOT describe independence if the level is Min A, and do NOT describe heavy dependence if the level is SBA.` : '';
  const hasRowContext = text.includes('TABLE_ROW') || text.includes('ROW_PEER_VALUES');
  const rowGuidance = hasRowContext ? `
- **ROW-SPECIFIC:** This field is in a table. TABLE_ROW tells you which task (e.g. Rolling, Supine-Sit). ROW_PEER_VALUES shows the assist level and other data for THIS specific row. Your suggestion must be specific to THIS row's task and assist level — not generic across all rows.` : '';
  const hasNearbySection = text.includes('NEARBY_SECTION_TABLE');
  const sectionNameMatch = text.match(/SECTION_NAME:\s*(.+)/);
  const detectedSection = sectionNameMatch ? sectionNameMatch[1].trim() : '';
  const nearbySectionGuidance = hasNearbySection ? `
- **SECTION-SPECIFIC RESPONSE (${detectedSection || 'this section'}):** This impact/response field belongs to "${detectedSection || 'the section above'}". NEARBY_SECTION_TABLE shows ONLY the rows from that section.
  - Write ONLY about the tasks listed in NEARBY_SECTION_TABLE. Do NOT mention tasks from other sections.
  - Example: If the section is "Bed Mobility Training" with rows Rolling, Supine-Sit, Sit-Supine — write ONLY about rolling, supine-to-sit, sit-to-supine. Do NOT mention sit-to-stand, transfers, gait, stairs, or any other activity.
  - Example: If the section is "Transfer Training" with rows Sit-Stand, Stand-Sit, Bed-Wheelchair — write ONLY about those transfers. Do NOT mention rolling, supine-to-sit, gait, or balance.
  - Reference the specific assist levels, devices, and interventions from NEARBY_SECTION_TABLE rows.
  - This is critical: ONLY the tasks in the table above this field. Nothing else.` : '';
  const hasVitals = text.includes('VITALS_ON_PAGE');
  const hasFlags = text.includes('CLINICAL_FLAGS');
  const vitalsGuidance = hasVitals ? `
- **VITALS AWARENESS:** VITALS_ON_PAGE shows actual vital sign readings. Your suggestion MUST reference the specific values.${hasFlags ? ' CLINICAL_FLAGS indicates abnormal readings that MUST be addressed — do NOT say "stable vitals" or "within normal limits" when flags are present. Instead, note the specific abnormal values (e.g. "Elevated BP at 180/81 — MD and agency notified") and clinical implications.' : ' If all vitals are within normal limits, note stable vitals and clearance to continue.'}` : '';
  const hasPainCtx = text.includes('PAIN_LOCATION');
  const painGuidance = hasPainCtx ? `
- **PAIN ASSESSMENT INTELLIGENCE:** PAIN_LOCATION, PAIN_REGION, and CLINICAL_* lines in context show the detected pain site and clinically appropriate aggravating/relieving/interfering activities for that body region.
  - For "Increased by" fields: list specific functional activities that aggravate pain at THIS location (from CLINICAL_INCREASED_BY). Use concise, comma-separated format matching clinical documentation style.
  - For "Relieved by" fields: list interventions/positions that relieve pain at THIS location (from CLINICAL_RELIEVED_BY). Concise, comma-separated.
  - For "Interferes with" fields: list functional activities impacted by pain at THIS location (from CLINICAL_INTERFERES_WITH). Concise, comma-separated.
  - Output as a SHORT comma-separated list (not sentences) matching the field style — e.g. "Walking, transfers, standing, stair climbing" not "The patient reports increased pain with walking and transfers."` : '';

  const prompt = `You document home health physical therapy in Kinnser EMR.

Chart context (may be incomplete):
---
${text}
---

Write a field-appropriate suggestion for the focused field (role: ${classification.fieldType}).
- Read the ENTIRE context — other boxes, headings, and themes — so the line fits this visit, not only the current empty box.
- If PHRASES_CLINICIAN_SAVED appear, match abbreviations and clinical style but write **new** wording; do **not** copy or paraphrase those sentences closely.
${avgMode ? '- **Typical-style mode:** multiple saved examples are listed — your line should read like their **usual** documentation for this field: similar character length to a median example, same opener pattern (e.g., "Pt reports...", "Patient demonstrates..."), same abbreviation density and tone, while grounded in facts visible in context today.' : ''}
- Avoid reusing wording patterns that were previously marked as incorrect:
${avoids.length ? avoids.slice(0, 8).map((x, i) => `${i + 1}. ${String(x).replace(/\s+/g, ' ').trim().slice(0, 260)}`).join('\n') : 'none'}
${rules.length ? `- **MANDATORY RULES for this field (the clinician set these — follow them strictly):**\n${rules.map((r, i) => `  ${i + 1}. ${String(r).slice(0, 300)}`).join('\n')}` : ''}
- ${longForm ? 'For summary/assessment/progress-style boxes, output ONE complete paragraph (about 4-6 sentences, up to ~1200 chars).' : 'For short comment/cell boxes, output ONE concise line (up to ~220 chars).'}
- Output ONLY the suggestion text, nothing else.`;

  // Build cacheable system prompt (static clinical instructions — same across fields in a visit)
  const systemPrompt = `You are an expert home health physical therapy documentation assistant for Kinnser/WellSky EMR. You write concise, clinically accurate field suggestions.

KEY INSTRUCTIONS:
- Stay consistent with facts in context; do not invent vitals, scores, or tests not present.
- Match the clinician's documentation style when saved examples are provided.
- Follow all MANDATORY RULES strictly — they override general guidance.${assistGuidance}${rowGuidance}${nearbySectionGuidance}${vitalsGuidance}${painGuidance}`;

  const finalPrompt = goldenExampleBlock ? prompt + goldenExampleBlock : prompt;
  const res = await callAnthropicMessages(apiKey, finalPrompt, longForm ? 520 : 160, undefined, systemPrompt);
  let line = String(res.text || '').replace(/\r\n/g, '\n').trim();
  if (!longForm) {
    line = line
      .split('\n')[0]
      .replace(/\s+/g, ' ')
      .trim();
    line = line.replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (line.length > 800) line = line.slice(0, 800).trim();
  } else {
    line = line.replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (line.length > 1400) line = line.slice(0, 1397) + '…';
  }
  // Hard guard: if output strongly repeats a rejected snippet, force a safer rewrite hint.
  if (avoids.length) {
    const low = line.toLowerCase();
    for (const bad of avoids.slice(0, 8)) {
      const b = String(bad || '').toLowerCase().trim();
      if (!b) continue;
      if (b.length > 20 && (low.includes(b.slice(0, 28)) || low.includes(b.slice(-28)))) {
        line = line.replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }
  return {
    line,
    usage: res.usage,
    fieldType: classification.fieldType,
    fieldConfidence: classification.confidence,
  };
}

async function generateAssessmentDraft(opts) {
  const { apiKey, snapshot, mode, priorDraft, improveHint, learnedRows, fieldRules } = opts;
  if (!apiKey) throw new Error('API key not configured');
  const classification = classifyKinnserField(snapshot);
  const { structuredText, sections, truncated } = buildStructuredNoteContext(snapshot, learnedRows, classification);
  if (!structuredText || structuredText.length < 20) {
    throw new Error('Not enough page context — open a chart note and use Capture context');
  }
  const rules = Array.isArray(fieldRules) ? fieldRules.filter(Boolean).slice(0, 10) : [];
  const prompt = buildGeneratePrompt(structuredText, mode || 'generate', priorDraft, improveHint, classification, rules);
  const maxTok = maxTokensForFieldType(classification.fieldType);

  // Cacheable system prompt — static clinical documentation instructions
  const genSystemPrompt = `You are an expert home health physical therapy documentation assistant for Kinnser/WellSky EMR.
You produce clinically accurate, professionally toned documentation text for specific chart fields.
- Use past tense for visit findings. Professional clinical tone.
- Do not invent measurements, vitals, MMT grades, or tests not present in the provided context.
- No patient name, full address, phone, or MRN; use "the patient" if needed.
- No bullet points; no title line; plain prose only.
- Match the clinician's taught abbreviations and documentation style when saved examples are provided.
- Follow all MANDATORY RULES strictly — they override general guidance.`;

  const res = await callAnthropicMessages(apiKey, prompt, maxTok, undefined, genSystemPrompt);
  const draft = String(res.text || '')
    .replace(/^\s*#+\s*/gm, '')
    .trim();
  return {
    draft,
    structuredPreview: structuredText.slice(0, 3500),
    sectionsSummary: sections.map((x) => ({ title: x.title, lineCount: x.lines.length })),
    truncated,
    fingerprint: fingerprintContext(snapshot),
    usage: res.usage,
    fieldType: classification.fieldType,
    fieldConfidence: classification.confidence,
    fieldSignals: classification.signals,
  };
}

/**
 * Agent chat — processes user commands with full page context.
 * Returns { reply, fills[], draft }.
 */
async function agentChat(opts) {
  const { apiKey, message, snapshot, fieldRules, fieldPurpose, fieldKey, learnedExamples, trainingPattern, trainingSnapshotCount } = opts;
  if (!apiKey) throw new Error('API key not configured');

  const s = snapshot || {};
  const fields = Array.isArray(s.fields) ? s.fields : [];
  const ff = s.focusedField || {};
  const classification = classifyKinnserField(snapshot);

  // Build compact field inventory for the AI
  // Build compact field inventory — include ALL fields using a compact format to fit in context
  const fieldInventory = fields.map((f) => {
    const lab = String(f.label || f.name || f.id || '').slice(0, 60);
    const id = String(f.id || '').slice(0, 50);
    const name = String(f.name || '').slice(0, 50);
    const type = String(f.type || f.role || 'input').toLowerCase();
    if (type === 'checkbox') {
      return { l: lab, id, n: name, r: 'cb', c: !!f.checked };
    }
    if (type === 'radio') {
      return { l: lab, id, n: name, r: 'rd', c: !!f.checked, v: String(f.value || '').slice(0, 30), g: String(f.radioGroup || f.name || '').slice(0, 40) };
    }
    if (type === 'select' || type === 'select-one') {
      const val = String(f.value || '').slice(0, 40);
      const opts = Array.isArray(f.options) ? f.options.slice(0, 6).map(o => {
        const t = String(o.text || '').slice(0, 30);
        const v = String(o.value || '').slice(0, 30);
        return t === v || !v ? t : `${t}=${v}`;
      }) : [];
      return { l: lab, id, n: name, r: 'sel', v: val, o: opts.join('|') };
    }
    const val = String(f.value || '').replace(/\s+/g, ' ').trim();
    // For "fill all" efficiency: mark empty fields so AI prioritizes them
    const isEmpty = !val;
    return { l: lab, id, n: name, r: type === 'textarea' ? 'ta' : 'in', v: isEmpty ? '' : val.slice(0, 80), empty: isEmpty };
  });

  // Extract assist levels and pain context
  const assistLevels = extractAssistLevels(fields);
  const painCtx = extractPainContext(fields, ff);
  const rules = Array.isArray(fieldRules) ? fieldRules.filter(Boolean).slice(0, 10) : [];

  const heads = Array.isArray(s.headings) ? s.headings.filter(Boolean).slice(0, 15) : [];

  // Build learned examples block
  const examples = Array.isArray(learnedExamples) ? learnedExamples : [];
  let learnedBlock = '';
  if (examples.length) {
    learnedBlock = `\n## LEARNED STYLE EXAMPLES (from clinician's previous notes — mimic this tone, length, abbreviations, and phrasing)
${examples.slice(0, 40).map((e, i) => `${i + 1}. ${String(e.snippet).slice(0, 300)}`).join('\n')}
IMPORTANT: Write NEW content grounded in TODAY's visit context, but match the writing style, sentence structure, abbreviation patterns, and clinical tone from these examples. Do NOT copy them verbatim — adapt them to the current patient data.\n`;
  }

  // Build training pattern block (checkbox/select/radio preferences)
  const tp = trainingPattern || {};
  let patternBlock = '';
  const cbList = Array.isArray(tp.checkboxes) ? tp.checkboxes : [];
  const selList = Array.isArray(tp.selects) ? tp.selects : [];
  const rdList = Array.isArray(tp.radios) ? tp.radios : [];
  if (cbList.length || selList.length || rdList.length) {
    const parts = [];
    if (cbList.length) {
      parts.push('Checkboxes the clinician typically checks:\n' +
        cbList.map((c) => `  - "${c.label}" (id=${c.id || ''} name=${c.name || ''})`).join('\n'));
    }
    if (selList.length) {
      parts.push('Dropdown selections the clinician typically uses:\n' +
        selList.map((s) => `  - "${s.label}": "${s.selectedText || s.value}"`).join('\n'));
    }
    if (rdList.length) {
      parts.push('Radio buttons the clinician typically selects:\n' +
        rdList.map((r) => `  - "${r.label}" value="${r.value}" (group=${r.group || ''})`).join('\n'));
    }
    patternBlock = `\n## LEARNED PREFERENCES (from clinician's training captures)\n${parts.join('\n')}\nWhen filling fields, replicate these checkbox/dropdown/radio patterns where the same fields appear on the current page.\n`;
  }

  const snapCount = Number(trainingSnapshotCount) || 0;

  const prompt = `You are an AI clinical documentation agent for home health physical therapy in Kinnser EMR. The clinician is chatting with you to automate their note.
${snapCount ? `\nTraining status: ${snapCount} completed note(s) learned. Use the learned style examples and preferences below to match this clinician's documentation patterns.\n` : '\nTraining status: No training data yet. Write standard clinical PT documentation.\n'}
## Current page context
Page headings: ${heads.join(' | ') || 'none'}
Focused field: ${String(ff.label || fieldPurpose || 'none').slice(0, 200)}
Field type: ${classification.fieldType} (confidence: ${classification.confidence})
${assistLevels ? 'Assist levels: ' + JSON.stringify(assistLevels) : ''}
${painCtx ? 'Pain: ' + painCtx.location + ' (' + painCtx.region + ')' : ''}
${rules.length ? 'Active rules: ' + rules.join('; ') : ''}
${learnedBlock}${patternBlock}
## Available fields on page (compact: r=role cb/rd/sel/in/ta, l=label, id, n=name, c=checked, v=value, o=options, g=radioGroup)
${fieldInventory.map((f) => {
    if (f.r === 'cb') return `[cb] id="${f.id}" n="${f.n}" l="${f.l}" c=${f.c}`;
    if (f.r === 'rd') return `[rd] id="${f.id}" n="${f.n}" l="${f.l}" v="${f.v}" g="${f.g}" c=${f.c}`;
    if (f.r === 'sel') return `[sel] id="${f.id}" n="${f.n}" l="${f.l}" v="${f.v}"${f.o ? ' o=[' + f.o + ']' : ''}`;
    return `[${f.r}] id="${f.id}" n="${f.n}" l="${f.l}"${f.empty ? ' EMPTY' : ` v="${f.v}"`}`;
  }).join('\n')}

## Clinician message
${String(message).slice(0, 2000)}

## Instructions
Respond with a JSON object (and NOTHING else — no markdown fences, no preamble):
{
  "reply": "Your conversational response to the clinician (always include this)",
  "fills": [
    {"id": "field_id", "name": "field_name", "value": "text to fill"},
    ...
  ],
  "draft": "If the user wants a full summary/assessment, put the draft text here. Otherwise empty string."
}

Rules for fills:
- Only include fills for fields that exist in the field inventory above
- Use the exact id or name from the inventory
- **For checkboxes:** use {"id": "...", "name": "...", "checked": true} or {"checked": false}. Also include "label" so the field can be found by label text if id lookup fails.
- **For radio buttons:** use {"id": "...", "name": "...", "value": "option_value", "checked": true}. The "name" is the radio group name and "value" is the specific radio option value to select. Also include "label".
- **For selects/dropdowns:** use {"id": "...", "name": "...", "value": "option_value"}. Try to use the exact option value from the inventory. If unsure, use the option text — the system will fuzzy-match.
- **For text inputs and textareas:** use {"id": "...", "name": "...", "value": "text to fill"}
- For textareas (narrative boxes), write clinically appropriate PT documentation MATCHING the learned style examples above
- For short input fields, write concise values
- Match assist levels to the correct clinical language
- Honor all active rules
- Replicate learned checkbox/dropdown/radio patterns where the same fields appear
- For "fill my entire note" or "do my notes" type commands: fill ALL empty fields (textareas, inputs, checkboxes, selects) with appropriate content based on page context + learned patterns
- For "check patient identity" or similar checkbox commands: find the checkbox by label and set checked=true
- For "check no pain" or "no pain reported" commands: include a fill with the pain checkbox's id/name and checked=true
- For "select X" or "set X to Y" dropdown commands: include a fill with the dropdown's id/name and the value to set
- For "pre-therapy: 2" or similar pain intensity commands: include fills with the dropdown's id/name and the value
- CRITICAL: When the user asks you to check a box, select a radio, or set a dropdown, you MUST include the corresponding fill object in the fills array. Do NOT just describe the action in your reply — the fill object is what actually executes the action on the page. A reply without a fill does nothing.
- For specific commands like "fill bed mobility", only fill fields in that section
- For questions, just reply with helpful information and no fills

Rules for draft:
- Only populate draft if the user asks for a summary, assessment, or overall visit performance text
- Write 5-7 sentences covering functional status, skilled PT need, response to treatment, safety, and medical necessity
- Match the learned style examples in tone and structure

Be efficient. Fill as many relevant empty fields as you can in one response.`;

  // Cacheable system prompt for agent chat
  const agentSystemPrompt = `You are an AI clinical documentation agent for home health physical therapy in Kinnser EMR.
You help clinicians automate their documentation by filling fields, answering clinical questions, and drafting summaries.
Always respond with valid JSON. Match the clinician's learned documentation style. Follow all rules strictly.
For "fill my entire note" commands, fill ALL empty fields. For section-specific commands, only fill relevant fields.
For questions, reply with helpful clinical information and no fills.`;

  // Use higher max_tokens for "fill all" commands to generate fills for many fields
  const isFillAll = /fill (my |the )?(entire|whole|all|everything|full)/i.test(message) || /do (my |the )?(note|notes|entire)/i.test(message) || /make it up|fill out all/i.test(message);
  const maxTokens = isFillAll ? 4000 : 2000;
  const res = await callAnthropicMessages(apiKey, prompt, maxTokens, FAST_MODEL, agentSystemPrompt);
  let text = String(res.text || '').trim();

  // Parse JSON response
  let parsed = { reply: '', fills: [], draft: '' };
  try {
    // Strip markdown fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(text);
  } catch {
    // If JSON parse fails, treat entire response as a reply
    parsed = { reply: text, fills: [], draft: '' };
  }

  return {
    reply: String(parsed.reply || '').trim(),
    fills: Array.isArray(parsed.fills) ? parsed.fills.filter((f) => f && (f.id || f.name || f.label) && (f.value != null || f.checked != null)) : [],
    draft: String(parsed.draft || '').trim(),
    usage: res.usage,
  };
}

module.exports = {
  buildStructuredNoteContext,
  fingerprintContext,
  generateAssessmentDraft,
  generateOneLineSuggestion,
  agentChat,
  MODEL,
  FAST_MODEL,
  classifyKinnserField,
  FIELD_TYPES,
};
