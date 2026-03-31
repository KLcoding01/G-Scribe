import { useRef, useEffect, useCallback } from 'react';
import {
  getKinnserSummaryCaptureCode,
  getKinnserSummaryApplyHostPayloadCode,
  getKinnserSummaryDrainBridgeCode,
  getKinnserSummaryDrainSignalsCode,
  getKinnserSummarySetFloatEnabledCode,
  getKinnserSummaryClearDismissalsCode,
  getKinnserSummaryReplaceActiveFieldCode,
  getKinnserSummaryUndoReplaceCode,
} from '../lib/kinnserSummaryCopilotScript.js';
import {
  kinnserSummaryGenerate,
  kinnserSummaryFeedback,
  kinnserSummaryRecordActivity,
  kinnserSummaryFieldMemory,
  kinnserSummarySuggestLine,
  hasKinnserSummaryCopilot,
} from '../lib/kinnserSummaryClient.js';
import { RDL_AGENT, IW_AGENT } from '../lib/kinnserAgents.js';

/** After this many saved lines per field, auto-show the suggest pill (focus + after Learn). */
const AUTO_SUGGEST_MIN_SNIPPETS = 10;
/** Avoid re-calling the model on every focus of the same field. */
const AUTO_SUGGEST_FOCUS_COOLDOWN_MS = 90 * 1000;
const RDL_MAX_HEADINGS = 60;
const RDL_MAX_FIELDS = 180;
const RDL_MAX_RECENT_PURPOSES = 24;

/**
 * Polls injected page bridge: AI draft + feedback + clipboard. Updates in-page float via applyHostPayload.
 */
export function useKinnserSummaryFloatBridge({
  site,
  siteKinnserName,
  kinnserSummaryReady,
  exec,
  hasApiKey,
  addLog,
  showToast,
  summaryFloatEnabled,
  autoSuggestEnabled = true,
  autoApplyMinConfidence = 0.9,
  copilotRules = [],
  onAddQuickRule,
}) {
  const confThreshold = Math.min(0.98, Math.max(0.5, Number(autoApplyMinConfidence) || 0.9));
  const lastDraftRef = useRef('');
  const fingerprintRef = useRef('');
  const ticking = useRef(false);
  const prevSummaryFloatOn = useRef(null);
  const lastSuggestCooldownRef = useRef({});
  const suggestionCacheRef = useRef({});
  const rdlContextRef = useRef({});

  const pushPayload = useCallback(
    async (obj) => {
      if (!exec) return;
      await exec(getKinnserSummaryApplyHostPayloadCode(obj));
    },
    [exec]
  );

  const absorbSnapshot = useCallback((snapshot) => {
    const s = snapshot || {};
    const pathKey = String(s.path || '__unknown__');
    const bucket = rdlContextRef.current[pathKey] || {
      headings: [],
      fields: [],
      fieldIndex: {},
      updatedAt: 0,
    };
    const incomingHeads = Array.isArray(s.headings) ? s.headings : [];
    for (const h of incomingHeads) {
      const t = String(h || '').trim();
      if (!t) continue;
      if (!bucket.headings.includes(t)) bucket.headings.push(t);
      if (bucket.headings.length > RDL_MAX_HEADINGS) bucket.headings.shift();
    }
    const incomingFields = Array.isArray(s.fields) ? s.fields : [];
    for (const f of incomingFields) {
      if (!f) continue;
      const k = `${String(f.role || '')}|${String(f.id || '')}|${String(f.name || '')}|${String(f.label || '')}`;
      const row = {
        role: String(f.role || ''),
        id: String(f.id || ''),
        name: String(f.name || ''),
        label: String(f.label || ''),
        value: String(f.value || ''),
      };
      const at = bucket.fieldIndex[k];
      if (typeof at === 'number' && at >= 0 && at < bucket.fields.length) {
        bucket.fields[at] = row;
      } else {
        bucket.fields.push(row);
        bucket.fieldIndex[k] = bucket.fields.length - 1;
      }
      if (bucket.fields.length > RDL_MAX_FIELDS) {
        const removed = bucket.fields.shift();
        const rk = `${String(removed.role || '')}|${String(removed.id || '')}|${String(removed.name || '')}|${String(removed.label || '')}`;
        delete bucket.fieldIndex[rk];
        bucket.fields.forEach((ff, ix) => {
          const kk = `${String(ff.role || '')}|${String(ff.id || '')}|${String(ff.name || '')}|${String(ff.label || '')}`;
          bucket.fieldIndex[kk] = ix;
        });
      }
    }
    bucket.updatedAt = Date.now();
    rdlContextRef.current[pathKey] = bucket;
  }, []);

  const mergeWithRdlContext = useCallback((snapshot) => {
    const s = snapshot || {};
    const pathKey = String(s.path || '__unknown__');
    const bucket = rdlContextRef.current[pathKey];
    if (!bucket) return s;
    const out = { ...s };
    const mergedHeads = [];
    const seenH = new Set();
    const pushHead = (h) => {
      const t = String(h || '').trim();
      if (!t || seenH.has(t)) return;
      seenH.add(t);
      mergedHeads.push(t);
    };
    (Array.isArray(s.headings) ? s.headings : []).forEach(pushHead);
    (Array.isArray(bucket.headings) ? bucket.headings : []).forEach(pushHead);
    out.headings = mergedHeads.slice(0, RDL_MAX_HEADINGS);

    const mergedFields = [];
    const seenF = new Set();
    const pushField = (f) => {
      if (!f) return;
      const key = `${String(f.role || '')}|${String(f.id || '')}|${String(f.name || '')}|${String(f.label || '')}`;
      if (seenF.has(key)) return;
      seenF.add(key);
      mergedFields.push(f);
    };
    (Array.isArray(s.fields) ? s.fields : []).forEach(pushField);
    (Array.isArray(bucket.fields) ? bucket.fields : []).forEach(pushField);
    out.fields = mergedFields.slice(0, RDL_MAX_FIELDS);

    const recent = Array.isArray(rdlContextRef.current.__recentPurposes)
      ? rdlContextRef.current.__recentPurposes
      : [];
    if (recent.length) out.rdlRecentFieldPurposes = recent.slice(-RDL_MAX_RECENT_PURPOSES);
    return out;
  }, []);

  const extractVitalsCtx = useCallback((snapshot) => {
    const out = { bpSystolic: null, bpDiastolic: null, heartRate: null, respirations: null, o2Sat: null, temperature: null };
    const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
    const asNum = (v) => {
      const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    for (const f of fields) {
      if (!f) continue;
      const lab = `${f.label || ''} ${f.name || ''} ${f.id || ''}`.toLowerCase();
      const val = String(f.value || '').trim();
      if (!val) continue;
      if (out.heartRate == null && /heart\s*rate|pulse/.test(lab)) out.heartRate = asNum(val);
      if (out.respirations == null && /respir/.test(lab)) out.respirations = asNum(val);
      if (out.o2Sat == null && /o2|oxygen|sat/.test(lab)) out.o2Sat = asNum(val);
      if (out.temperature == null && /temp/.test(lab)) out.temperature = asNum(val);
      if (out.bpSystolic == null || out.bpDiastolic == null) {
        if (/blood pressure|\bbp\b/.test(lab) || /^\d+\s*\/\s*\d+$/.test(val)) {
          const m = val.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) {
            out.bpSystolic = Number(m[1]);
            out.bpDiastolic = Number(m[2]);
          }
        }
      }
    }
    // Fallback: first slash pair from any field text.
    if (out.bpSystolic == null || out.bpDiastolic == null) {
      const blob = fields.map((f) => String(f?.value || '')).join(' ');
      const m = blob.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
      if (m) {
        out.bpSystolic = Number(m[1]);
        out.bpDiastolic = Number(m[2]);
      }
    }
    return out;
  }, []);

  const applyUserRulesToSuggestion = useCallback((text, ctxInput) => {
    let out = String(text || '').trim();
    if (!out) return { text: out, appliedRules: [] };
    const rules = Array.isArray(copilotRules) ? copilotRules : [];
    if (!rules.length) return { text: out, appliedRules: [] };
    const applied = [];
    for (const r0 of rules) {
      if (!r0 || r0.enabled === false) continue;
      if (String(r0.mode || '') !== 'no_patient_starter') continue;
      const scopedFieldKey = String(r0.fieldKey || '').trim();
      const activeFieldKey = String(ctxInput?.fieldKey || '').trim();
      if (!scopedFieldKey || !activeFieldKey || scopedFieldKey !== activeFieldKey) continue;
      const before = out;
      out = out
        .replace(/^\s*patient\s+demonstrates\s+/i, '')
        .replace(/^\s*patient\s+reports\s+/i, '')
        .replace(/^\s*patient\s+(?:is|was)\s+/i, '')
        .replace(/^\s*patient\s+/i, '');
      out = out.replace(/^\s*pt\s+demonstrates\s+/i, '').replace(/^\s*pt\s+reports\s+/i, '').replace(/^\s*pt\s+/i, '');
      out = out.replace(/^\s+/, '');
      out = out.replace(/^([a-z])/, function(_m, c1) { return String(c1 || '').toUpperCase(); });
      if (before !== out) applied.push(r0.id || 'rule_no_patient_starter');
    }
    for (const r1 of rules) {
      if (!r1 || r1.enabled === false) continue;
      if (String(r1.mode || '') !== 'instruction') continue;
      const scopedFieldKey = String(r1.fieldKey || '').trim();
      const activeFieldKey = String(ctxInput?.fieldKey || '').trim();
      if (!scopedFieldKey || !activeFieldKey || scopedFieldKey !== activeFieldKey) continue;
      const ins = String(r1.instruction || '').trim();
      if (!ins) continue;
      const insLow = ins.toLowerCase();
      const before = out;

      // Generic "don't start with X" / "do not start with X"
      const startMatch = insLow.match(/(?:don'?t|do\s*not|never|avoid)\s+start(?:ing)?\s+with\s+(.+)/i);
      if (startMatch) {
        const words = startMatch[1].replace(/[.!,]+$/, '').split(/\s+(?:or|and|,)\s*/i).map(function(w) { return w.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean);
        for (var wi = 0; wi < words.length; wi++) {
          var wd = words[wi];
          if (!wd) continue;
          var wdEsc = wd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          var re = new RegExp('^\\s*' + wdEsc + '\\b[\\s,]*', 'i');
          out = out.replace(re, '');
        }
        out = out.replace(/^\s+/, '');
        out = out.replace(/^([a-z])/, function(_m, c1) { return String(c1 || '').toUpperCase(); });
      }

      // Generic "don't include X" / "don't use X" / "don't mention X"
      var includeMatch = insLow.match(/(?:don'?t|do\s*not|never|avoid)\s+(?:include|use|mention|say|write|put|add)\s+(?:the\s+(?:word|phrase|term)\s+)?(.+)/i);
      if (includeMatch) {
        var terms = includeMatch[1].replace(/[.!,]+$/, '').split(/\s+(?:or|and|,)\s*/i).map(function(w) { return w.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean);
        for (var ti = 0; ti < terms.length; ti++) {
          var tm = terms[ti];
          if (!tm) continue;
          var tmEsc = tm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          var reInc = new RegExp('\\b' + tmEsc + '\\b', 'gi');
          out = out.replace(reInc, '');
        }
        out = out.replace(/\s{2,}/g, ' ').replace(/^\s+/, '').replace(/\s+$/, '');
        out = out.replace(/^([a-z])/, function(_m, c1) { return String(c1 || '').toUpperCase(); });
      }

      if (before !== out) applied.push(r1.id || 'rule_instruction');
    }
    const ctx = {
      ...(ctxInput || {}),
      text: out,
      fieldPurpose: String(ctxInput?.fieldPurpose || ''),
      fieldType: String(ctxInput?.fieldType || ''),
      fieldKey: String(ctxInput?.fieldKey || ''),
      vitals: ctxInput?.vitals || {},
    };
    const fpLower = String(ctx.fieldPurpose || '').toLowerCase();
    for (const r of rules) {
      if (!r || r.enabled === false) continue;
      const scopedFieldKey = String(r.fieldKey || '').trim();
      if (scopedFieldKey && ctx.fieldKey && scopedFieldKey !== ctx.fieldKey) continue;
      const match = String(r.fieldMatch || '').trim().toLowerCase();
      if (match && !fpLower.includes(match)) continue;
      const cond = String(r.condition || '').trim();
      const app = String(r.appendText || '').trim();
      if (!cond || !app) continue;
      let ok = false;
      try {
        // Local advanced rule expression with ctx only.
        ok = !!new Function('ctx', `return (${cond});`)(ctx);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      if (!out.includes(app)) {
        out = `${out} ${app}`.replace(/\s+/g, ' ').trim();
      }
      applied.push(r.id || 'rule');
    }
    return { text: out, appliedRules: applied };
  }, [copilotRules]);

  useEffect(() => {
    if (site !== siteKinnserName || !kinnserSummaryReady || !exec) return;
    exec(getKinnserSummarySetFloatEnabledCode(summaryFloatEnabled));
    if (prevSummaryFloatOn.current !== null && summaryFloatEnabled && prevSummaryFloatOn.current === false) {
      exec(getKinnserSummaryClearDismissalsCode());
    }
    prevSummaryFloatOn.current = summaryFloatEnabled;
  }, [site, siteKinnserName, kinnserSummaryReady, exec, summaryFloatEnabled]);

  useEffect(() => {
    if (site !== siteKinnserName || !kinnserSummaryReady || !exec) return;
    const rules = (Array.isArray(copilotRules) ? copilotRules : []).map((r) => {
      const mode = String(r?.mode || '');
      const fieldMatch = String(r?.fieldMatch || '').trim();
      const name =
        mode === 'no_patient_starter'
          ? `Don't start with Patient/Pt${String(r?.fieldKey || '').trim() ? ' (this field)' : ''}`
          : mode === 'instruction'
            ? String(r?.instruction || 'Instruction rule')
          : fieldMatch
            ? `field contains "${fieldMatch}"`
            : 'General rule';
      return {
        id: String(r?.id || ''),
        mode,
        fieldMatch,
        fieldKey: String(r?.fieldKey || '').trim(),
        instruction: String(r?.instruction || '').slice(0, 300),
        enabled: r?.enabled !== false,
        name,
      };
    });
    pushPayload({ rulesPreview: rules });
  }, [site, siteKinnserName, kinnserSummaryReady, exec, copilotRules, pushPayload]);

  const runSuggestLine = useCallback(
    async (
      fieldPurpose,
      { preferAverageStyle = false, skipCooldown = false, autoApply = false, fieldKey = '' } = {}
    ) => {
      const fp = String(fieldPurpose || '').trim();
      if (!fp) return;
      const cacheKey = `${fp}::${String(fieldKey || '').trim()}`;
      if (!hasApiKey) {
        await pushPayload({
          loading: false,
          status: 'Set API key in toolbar Settings for smart Suggest',
          suggestChipHide: true,
        });
        showToast?.('API key required for smart Suggest', 'error');
        return;
      }
      if (!skipCooldown) {
        const last = lastSuggestCooldownRef.current[cacheKey] || 0;
        const cached = suggestionCacheRef.current[cacheKey];
        const cachedLine = String(cached?.line || '').trim();
        if (cachedLine) {
          const isLong = cachedLine.length > 260;
          await pushPayload({
            loading: true,
            status: 'Using recent style while refreshing…',
            suggestChipText: isLong ? '' : cachedLine,
            draft: isLong ? cachedLine : undefined,
            suggestChipHide: isLong,
            panelMinimized: autoApply ? true : undefined,
          });
        }
        if (Date.now() - last < AUTO_SUGGEST_FOCUS_COOLDOWN_MS) {
          if (cachedLine) {
            const isLong = cachedLine.length > 260;
            await pushPayload({
              loading: false,
              status: 'Recent suggestion restored — press Space or tap pill to insert',
              suggestChipText: isLong ? '' : cachedLine,
              draft: isLong ? cachedLine : undefined,
              suggestChipHide: isLong,
              panelMinimized: autoApply ? true : undefined,
            });
          }
          return;
        }
      }
      await pushPayload({
        loading: true,
        status: preferAverageStyle ? 'Matching your usual style…' : 'Thinking one line…',
        suggestChipHide: true,
      });
      const cap = await exec(getKinnserSummaryCaptureCode());
      if (!cap?.ok) {
        await pushPayload({ loading: false, status: cap?.error || 'Capture failed', suggestChipHide: true });
        return;
      }
      absorbSnapshot(cap.snapshot);
      if (fp && cap.snapshot) {
        cap.snapshot.focusedField = cap.snapshot.focusedField || {};
        if (!String(cap.snapshot.focusedField.fieldPurpose || '').trim()) {
          cap.snapshot.focusedField.fieldPurpose = fp.slice(0, 500);
        }
      }
      const fullCtx = mergeWithRdlContext(cap.snapshot);
      // Build instruction strings from active rules for this field
      const activeRuleInstructions = (Array.isArray(copilotRules) ? copilotRules : [])
        .filter((r) => {
          if (!r || r.enabled === false) return false;
          const scopedKey = String(r.fieldKey || '').trim();
          const activeKey = String(fieldKey || '').trim();
          // Only apply rules that match this specific field
          if (!scopedKey || !activeKey) return false;
          return scopedKey === activeKey;
        })
        .map((r) => {
          if (String(r.mode || '') === 'no_patient_starter') return "Do not start with 'Patient' or 'Pt'.";
          if (String(r.mode || '') === 'instruction') return String(r.instruction || '').trim();
          return '';
        })
        .filter(Boolean)
        .slice(0, 10);
      const res = await kinnserSummarySuggestLine({ snapshot: fullCtx, preferAverageStyle, fieldRules: activeRuleInstructions });
      if (!res?.ok) {
        await pushPayload({
          loading: false,
          status:
            res?.error === 'no_api_key'
              ? 'Set API key in Settings'
              : String(res?.error || 'Suggest failed'),
          suggestChipHide: true,
        });
        return;
      }
      let line = String(res.line || '').trim();
      if (!line) {
        await pushPayload({
          loading: false,
          status: 'No suggestion — add more chart context or use Learn',
          suggestChipHide: true,
        });
        return;
      }
      const rr = applyUserRulesToSuggestion(line, {
        fieldPurpose: fp,
        fieldType: String(res.fieldType || ''),
        fieldKey: String(fieldKey || ''),
        vitals: extractVitalsCtx(fullCtx),
      });
      line = rr.text;
      lastSuggestCooldownRef.current[cacheKey] = Date.now();
      suggestionCacheRef.current[cacheKey] = {
        line,
        confidence: typeof res.fieldConfidence === 'number' ? res.fieldConfidence : null,
        at: Date.now(),
      };
      const conf = typeof res.fieldConfidence === 'number' ? res.fieldConfidence : null;
      if (autoApply && conf != null && conf >= confThreshold) {
        const rep = await exec(getKinnserSummaryReplaceActiveFieldCode(line));
        if (rep?.ok) {
          await pushPayload({
            loading: false,
            status:
              'Auto-applied update from learned pattern (' +
              Math.round(conf * 100) +
              '%) — click Undo if needed',
            suggestChipHide: true,
            panelMinimized: true,
          });
          showToast?.('Auto-updated field (Undo available)', 'success');
          addLog?.(`${IW_AGENT.displayName}: auto-applied one-line suggest`);
          return;
        }
      }
      await pushPayload({
        loading: false,
        status: preferAverageStyle
          ? conf != null && autoApply
            ? 'Auto-suggest (' +
              Math.round(conf * 100) +
              '% < ' +
              Math.round(confThreshold * 100) +
              '% threshold) — tap pill to insert'
            : 'Auto-suggest (trained on your lines) — tap pill to insert'
          : 'Tap the pill under the chart to insert',
        suggestChipText: line.length > 260 ? '' : line,
        draft: line.length > 260 ? line : undefined,
        suggestChipHide: line.length > 260,
        panelMinimized: autoApply ? true : undefined,
      });
      if (rr.appliedRules.length) {
        showToast?.(`Rule applied (${rr.appliedRules.length})`, 'success');
      }
      addLog?.(`${IW_AGENT.displayName}: one-line suggest ok`);
    },
    [exec, hasApiKey, pushPayload, addLog, showToast, confThreshold, copilotRules]
  );

  const handlePending = useCallback(
    async (p) => {
      if (!p || typeof p !== 'object' || !hasKinnserSummaryCopilot()) return;
      if (p.action === 'agent_chat') {
        if (!hasApiKey) {
          await pushPayload({ chatReply: 'API key required. Set it in toolbar Settings.', loading: false });
          return;
        }
        const cap = await exec(getKinnserSummaryCaptureCode());
        if (!cap?.ok) {
          await pushPayload({ chatReply: 'Could not capture page context.', loading: false });
          return;
        }
        absorbSnapshot(cap.snapshot);
        const fullCtx = mergeWithRdlContext(cap.snapshot);
        // Build active rules
        const activeRules = (Array.isArray(copilotRules) ? copilotRules : [])
          .filter((r) => r && r.enabled !== false)
          .map((r) => {
            if (String(r.mode || '') === 'no_patient_starter') return "Do not start with 'Patient' or 'Pt'.";
            if (String(r.mode || '') === 'instruction') return String(r.instruction || '').trim();
            return '';
          })
          .filter(Boolean)
          .slice(0, 10);
        try {
          const res = await kinnserSummaryFieldMemory({
            op: 'agent_chat',
            message: String(p.message || ''),
            snapshot: fullCtx,
            fieldRules: activeRules,
            fieldPurpose: String(p.fieldPurpose || ''),
            fieldKey: String(p.fieldKey || ''),
          });
          if (res?.ok) {
            console.log('[AgentChat] Response:', JSON.stringify({ reply: (res.reply || '').slice(0, 100), fillsCount: res.fills?.length || 0, fills: res.fills || [] }).slice(0, 800));
            const payload = { loading: false };
            if (res.reply) payload.chatReply = res.reply;
            if (Array.isArray(res.fills) && res.fills.length) payload.agentFills = res.fills;
            if (res.draft) {
              payload.draft = res.draft;
              lastDraftRef.current = res.draft;
            }
            await pushPayload(payload);
            if (res.fills?.length) showToast?.(`Agent filled ${res.fills.length} field(s)`, 'success');
          } else {
            await pushPayload({ chatReply: res?.error || 'Agent error', loading: false });
          }
        } catch (e) {
          await pushPayload({ chatReply: 'Error: ' + String(e.message || e).slice(0, 200), loading: false });
        }
        return;
      }
      if (p.action === 'draft') {
        if (!hasApiKey) {
          await pushPayload({ status: 'Set API key in toolbar Settings', loading: false });
          showToast?.('API key required for AI draft', 'error');
          return;
        }
        await pushPayload({ loading: true, status: 'Capturing page…' });
        const cap = await exec(getKinnserSummaryCaptureCode());
        if (!cap?.ok) {
          await pushPayload({ loading: false, status: cap?.error || 'Capture failed' });
          return;
        }
        absorbSnapshot(cap.snapshot);
        const fpTeach = String(p.fieldPurpose || '').trim();
        if (fpTeach && cap.snapshot) {
          cap.snapshot.focusedField = cap.snapshot.focusedField || {};
          if (!String(cap.snapshot.focusedField.fieldPurpose || '').trim()) {
            cap.snapshot.focusedField.fieldPurpose = fpTeach.slice(0, 500);
          }
        }
        const fullCtx = mergeWithRdlContext(cap.snapshot);
        const mode = p.mode === 'regenerate' || p.mode === 'improve' ? p.mode : 'generate';
        const teach = String(p.improveHint || '').trim();
        // Build rule instructions for this field
        const activeFieldKey = String(p.fieldKey || '').trim();
        const genRuleInstructions = (Array.isArray(copilotRules) ? copilotRules : [])
          .filter((r) => {
            if (!r || r.enabled === false) return false;
            const scopedKey = String(r.fieldKey || '').trim();
            // Only apply rules that match this specific field
            if (!scopedKey || !activeFieldKey) return false;
            return scopedKey === activeFieldKey;
          })
          .map((r) => {
            if (String(r.mode || '') === 'no_patient_starter') return "Do not start with 'Patient' or 'Pt'.";
            if (String(r.mode || '') === 'instruction') return String(r.instruction || '').trim();
            return '';
          })
          .filter(Boolean)
          .slice(0, 10);
        await pushPayload({ loading: true, status: 'Drafting…' });
        const res = await kinnserSummaryGenerate({
          snapshot: fullCtx,
          mode,
          priorDraft: mode === 'improve' ? lastDraftRef.current : undefined,
          improveHint:
            mode === 'improve' ? teach : mode === 'generate' || mode === 'regenerate' ? teach || undefined : undefined,
          fieldRules: genRuleInstructions,
        });
        if (!res.ok) {
          await pushPayload({ loading: false, status: res.error || 'Generate failed' });
          await kinnserSummaryFeedback({
            action: 'generate_error',
            contextFingerprint: fingerprintRef.current,
            detail: { mode },
          });
          return;
        }
        lastDraftRef.current = res.draft || '';
        fingerprintRef.current = res.fingerprint || '';
        const roleHint =
          res.fieldType && typeof res.fieldConfidence === 'number'
            ? ' · ' + String(res.fieldType).replace(/_/g, ' ') + ' (' + Math.round(res.fieldConfidence * 100) + '%)'
            : res.fieldType
              ? ' · ' + String(res.fieldType).replace(/_/g, ' ')
              : '';
        await pushPayload({
          loading: false,
          status: 'Ready (' + (res.durationMs || '?') + ' ms)' + roleHint,
          draft: res.draft || '',
          fingerprint: res.fingerprint || '',
        });
        addLog?.(`${IW_AGENT.displayName}: assessment draft (${mode}) ok`);
        return;
      }
      if (p.action === 'learn_field_text') {
        const r = await kinnserSummaryFieldMemory({
          op: 'learn',
          text: p.text,
          fieldPurpose: String(p.fieldPurpose || ''),
          fieldKey: String(p.fieldKey || ''),
        });
        if (r?.ok) {
          showToast?.('Saved for this field', 'success');
          addLog?.(`${RDL_AGENT.displayName}: learned line for this field`);
          const n = Number(r.snippetCount) || 0;
          if (autoSuggestEnabled && n === AUTO_SUGGEST_MIN_SNIPPETS && hasApiKey) {
            await runSuggestLine(String(p.fieldPurpose || ''), {
              preferAverageStyle: true,
              skipCooldown: true,
              autoApply: true,
              fieldKey: String(p.fieldKey || ''),
            });
          } else {
            await pushPayload({
              loading: false,
              status:
                !autoSuggestEnabled
                  ? `Learned (${n}) — auto suggest is off`
                  :
                !hasApiKey && n >= AUTO_SUGGEST_MIN_SNIPPETS
                  ? 'Learned — set API key in Settings for auto-suggest'
                  : n < AUTO_SUGGEST_MIN_SNIPPETS
                    ? `Learned (${n}/${AUTO_SUGGEST_MIN_SNIPPETS} saved for auto-suggest) — keep teaching or tap Suggest`
                    : 'Learned — tap Suggest for a smart line',
            });
          }
        } else {
          await pushPayload({
            status: r?.error === 'text_too_short' ? 'Type more in the chart first' : 'Learn failed',
            loading: false,
          });
        }
        return;
      }
      if (p.action === 'bulk_learn_field_text') {
        const lines = Array.isArray(p.lines) ? p.lines : [];
        if (!lines.length) {
          await pushPayload({ loading: false, status: 'No valid lines to save' });
          return;
        }
        const fp = String(p.fieldPurpose || '');
        const fk = String(p.fieldKey || '');
        let saved = 0;
        let lastCount = 0;
        for (const line of lines) {
          const text = String(line || '').trim();
          if (text.length < 4) continue;
          try {
            const r = await kinnserSummaryFieldMemory({
              op: 'learn',
              text: text.slice(0, 2000),
              fieldPurpose: fp,
              fieldKey: fk,
            });
            if (r?.ok) {
              saved++;
              lastCount = Number(r.snippetCount) || saved;
            }
          } catch {}
        }
        showToast?.(`Saved ${saved} line${saved === 1 ? '' : 's'} for this field`, 'success');
        addLog?.(`${RDL_AGENT.displayName}: bulk learned ${saved} lines`);
        await pushPayload({
          loading: false,
          status: `Bulk learned ${saved} line${saved === 1 ? '' : 's'} (${lastCount} total saved)`,
        });
        return;
      }
      if (p.action === 'auto_suggest_if_ready') {
        if (!autoSuggestEnabled) return;
        const fp = String(p.fieldPurpose || '').trim();
        if (!fp) return;
        const cr = await kinnserSummaryFieldMemory({
          op: 'count',
          fieldPurpose: fp,
          fieldKey: String(p.fieldKey || ''),
        });
        const cnt = cr?.ok ? Number(cr.count) || 0 : 0;
        if (cnt < AUTO_SUGGEST_MIN_SNIPPETS) return;
        await runSuggestLine(fp, {
          preferAverageStyle: true,
          skipCooldown: false,
          autoApply: true,
          fieldKey: String(p.fieldKey || ''),
        });
        return;
      }
      if (p.action === 'suggest_contextual') {
        await runSuggestLine(String(p.fieldPurpose || ''), {
          preferAverageStyle: false,
          skipCooldown: true,
          fieldKey: String(p.fieldKey || ''),
        });
        return;
      }
      if (p.action === 'suggest_next') {
        await runSuggestLine(String(p.fieldPurpose || ''), {
          preferAverageStyle: true,
          skipCooldown: true,
          fieldKey: String(p.fieldKey || ''),
        });
        return;
      }
      if (p.action === 'add_quick_rule_no_patient_starter') {
        const fk = String(p.fieldKey || '').trim();
        const id = `rule_no_patient_starter::${fk || 'generic'}`;
        // #region agent log
        fetch('http://127.0.0.1:7444/ingest/9f1a5f2d-97a0-4685-b04b-06f3a38c8908',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1182f5'},body:JSON.stringify({sessionId:'1182f5',runId:'rule-click',hypothesisId:'H4',location:'useKinnserSummaryFloatBridge.js:add-quick-rule-entry',message:'Entered add_quick_rule_no_patient_starter',data:{fieldKey:fk.slice(0,180),fieldPurpose:String(p.fieldPurpose||'').slice(0,120)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        try {
          await kinnserSummaryFieldMemory({
            op: 'rule_add',
            id,
            mode: 'no_patient_starter',
            fieldPurpose: String(p.fieldPurpose || ''),
            fieldKey: fk,
            condition: 'true',
            appendText: '',
            instruction: "Don't start with Patient/Pt",
            enabled: true,
          });
          // #region agent log
          fetch('http://127.0.0.1:7444/ingest/9f1a5f2d-97a0-4685-b04b-06f3a38c8908',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1182f5'},body:JSON.stringify({sessionId:'1182f5',runId:'rule-click',hypothesisId:'H4',location:'useKinnserSummaryFloatBridge.js:add-quick-rule-db-ok',message:'Field memory rule_add resolved',data:{id:id.slice(0,220)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
        } catch {}
        const added = await onAddQuickRule?.({
          id,
          mode: 'no_patient_starter',
          fieldKey: fk,
          fieldMatch: '',
          condition: 'true',
          appendText: '',
          enabled: true,
        });
        await pushPayload({
          loading: false,
          status: added === false ? 'Rule already exists' : 'Rule active: avoid "Patient..." starter',
        });
        showToast?.(added === false ? 'Rule already exists' : 'Rule added: no "Patient..." starter', 'success');
        return;
      }
      if (p.action === 'add_field_instruction_rule') {
        const fk = String(p.fieldKey || '').trim();
        const ins = String(p.instruction || '').trim();
        if (!ins) {
          await pushPayload({ loading: false, status: 'Rule text is empty' });
          return;
        }
        const rid = `rule_instruction::${fk || 'generic'}::${Date.now()}`;
        try {
          await kinnserSummaryFieldMemory({
            op: 'rule_add',
            id: rid,
            mode: 'instruction',
            fieldPurpose: String(p.fieldPurpose || ''),
            fieldKey: fk,
            condition: 'true',
            appendText: '',
            instruction: ins.slice(0, 500),
            enabled: true,
          });
        } catch {}
        await onAddQuickRule?.({
          id: rid,
          mode: 'instruction',
          fieldKey: fk,
          fieldMatch: '',
          condition: 'true',
          appendText: '',
          instruction: ins.slice(0, 500),
          enabled: true,
        });
        await pushPayload({ loading: false, status: 'Rule saved for this field' });
        showToast?.('Rule added for this field', 'success');
        return;
      }
      if (p.action === 'delete_field_rule') {
        const rid = String(p.ruleId || '').trim();
        if (!rid) {
          await pushPayload({ loading: false, status: 'No rule to delete' });
          return;
        }
        try {
          await kinnserSummaryFieldMemory({ op: 'rule_delete', id: rid });
        } catch {}
        // Remove from local copilotRules state
        onAddQuickRule?.({ id: rid, _delete: true });
        await pushPayload({ loading: false, status: 'Rule removed' });
        showToast?.('Rule removed', 'success');
        return;
      }
      if (p.action === 'undo_auto_replace') {
        const ur = await exec(getKinnserSummaryUndoReplaceCode());
        if (ur?.ok) {
          await pushPayload({ loading: false, status: 'Undo complete' });
          showToast?.('Reverted last auto-update', 'success');
        } else {
          await pushPayload({
            loading: false,
            status: ur?.error === 'value_changed' ? 'Cannot undo: value changed after auto-update' : 'Nothing to undo',
          });
        }
        return;
      }
      if (p.action === 'list_saved_phrases' || p.action === 'suggest_local') {
        const r = await kinnserSummaryFieldMemory({
          op: 'list',
          fieldPurpose: String(p.fieldPurpose || ''),
          fieldKey: String(p.fieldKey || ''),
        });
        if (r?.ok) {
          const sn = r.snippets || [];
          await pushPayload({
            localSuggestions: sn,
            loading: false,
            status: sn.length
              ? `${sn.length} saved example${sn.length === 1 ? '' : 's'} — tap to insert · × delete · ⎘ duplicate`
              : 'No saved examples for this field yet',
          });
        } else {
          await pushPayload({ localSuggestions: [], status: 'Could not load saved lines', loading: false });
        }
        return;
      }
      if (p.action === 'clear_field_memory') {
        const r = await kinnserSummaryFieldMemory({
          op: 'clear',
          fieldPurpose: String(p.fieldPurpose || ''),
          fieldKey: String(p.fieldKey || ''),
        });
        if (r?.ok) {
          showToast?.('Cleared ' + (r.removed || 0) + ' saved line(s)', 'success');
          await pushPayload({
            localSuggestions: [],
            status: 'Memory cleared for this field',
            loading: false,
            suggestChipHide: true,
          });
        } else {
          await pushPayload({
            status:
              r?.error === 'no_field_scope'
                ? 'Could not match this field — click the chart box again, then Clear'
                : 'Clear failed',
            loading: false,
          });
        }
        return;
      }
      if (p.action === 'delete_snippet') {
        const fp = String(p.fieldPurpose || '');
        const fk = String(p.fieldKey || '');
        const r = await kinnserSummaryFieldMemory({ op: 'delete_one', text: p.text, fieldPurpose: fp, fieldKey: fk });
        const r2 = await kinnserSummaryFieldMemory({ op: 'list', fieldPurpose: fp, fieldKey: fk });
        const didRemove = Number(r?.removed) > 0;
        if (didRemove) showToast?.('Deleted saved line', 'success');
        await pushPayload({
          localSuggestions: r2?.snippets || [],
          loading: false,
          status: didRemove ? 'Deleted' : 'Could not delete (refresh Show saved)',
        });
        return;
      }
      if (p.action === 'duplicate_snippet') {
        const fp = String(p.fieldPurpose || '');
        const fk = String(p.fieldKey || '');
        const r = await kinnserSummaryFieldMemory({ op: 'duplicate_one', text: p.text, fieldPurpose: fp, fieldKey: fk });
        const r2 = await kinnserSummaryFieldMemory({ op: 'list', fieldPurpose: fp, fieldKey: fk });
        if (r?.ok) showToast?.('Duplicate saved', 'success');
        await pushPayload({
          localSuggestions: r2?.snippets || [],
          loading: false,
          status: r?.ok ? 'Duplicate ends with “ (copy)” — edit after insert if needed' : (r?.error || 'Duplicate failed'),
        });
        return;
      }
      if (p.action === 'insert_result') {
        await kinnserSummaryFeedback({
          action: p.ok ? 'insert_ok' : 'insert_fail',
          contextFingerprint: p.fingerprint || fingerprintRef.current,
          detail: {},
        });
        if (p.ok) showToast?.('Inserted at cursor', 'success');
        return;
      }
      if (p.action === 'clipboard_copy') {
        const text = String(p.text || '');
        try {
          if (window.desktop?.clipboard?.writeText) await window.desktop.clipboard.writeText(text);
          else await navigator.clipboard.writeText(text);
          await pushPayload({ loading: false, status: 'Copied' });
          showToast?.('Copied', 'success');
          await kinnserSummaryFeedback({
            action: 'copy',
            contextFingerprint: p.fingerprint || fingerprintRef.current,
            detail: { chars: text.length },
          });
        } catch {
          await pushPayload({ loading: false, status: 'Copy failed' });
        }
        return;
      }
      if (p.action === 'feedback') {
        const up = p.kind === 'thumbs_up';
        const teachHint = String(p.teachHintSnapshot || '').trim();
        const fieldPurpose = String(p.fieldPurpose || '').trim();
        const detail = {};
        if (fieldPurpose) detail.fieldPurpose = fieldPurpose.slice(0, 500);
        if (p.fieldKey) detail.fieldKey = String(p.fieldKey).slice(0, 400);
        if (up && teachHint) detail.teachHint = teachHint;
        if (!up && p.rejectedText) detail.rejectedText = String(p.rejectedText).slice(0, 1800);
        await kinnserSummaryFeedback({
          action: up ? 'thumbs_up' : 'thumbs_down',
          contextFingerprint: p.fingerprint || fingerprintRef.current,
          detail,
        });
        await pushPayload({
          loading: false,
          status: up && teachHint ? 'Saved style hint + thanks' : 'Logged — thanks',
        });
        showToast?.(up ? 'Feedback saved: appropriate' : 'Feedback saved: incorrect', 'success');
        return;
      }
      if (p.action === 'section_template_save') {
        const r = await kinnserSummaryFieldMemory({
          op: 'section_template_save',
          id: p.id || undefined,
          sectionType: String(p.sectionType || ''),
          name: String(p.name || ''),
          data: p.data || {},
        });
        if (r?.ok) {
          showToast?.('Template saved: ' + String(p.name || '').slice(0, 40), 'success');
          // Send updated list back
          const lr = await kinnserSummaryFieldMemory({ op: 'section_template_list', sectionType: String(p.sectionType || '') });
          await pushPayload({ sectionTemplates: lr?.templates || [], loading: false, status: 'Template saved' });
        } else {
          await pushPayload({ loading: false, status: 'Save failed: ' + String(r?.error || '') });
        }
        return;
      }
      if (p.action === 'section_template_list') {
        const r = await kinnserSummaryFieldMemory({ op: 'section_template_list', sectionType: String(p.sectionType || '') });
        await pushPayload({ sectionTemplates: r?.templates || [], loading: false });
        return;
      }
      if (p.action === 'section_template_delete') {
        await kinnserSummaryFieldMemory({ op: 'section_template_delete', id: String(p.id || '') });
        showToast?.('Template deleted', 'success');
        const lr = await kinnserSummaryFieldMemory({ op: 'section_template_list', sectionType: String(p.sectionType || '') });
        await pushPayload({ sectionTemplates: lr?.templates || [], loading: false, status: 'Template deleted' });
        return;
      }
      if (p.action === 'section_template_load') {
        // Data is sent back to the webview to fill
        await pushPayload({ sectionTemplateLoad: p.data || {}, loading: false, status: 'Filling template: ' + String(p.name || '').slice(0, 40) });
        showToast?.('Loading template: ' + String(p.name || '').slice(0, 40), 'success');
        return;
      }
      if (p.action === 'field_learn') {
        const fp = String(p.fieldPurpose || '').trim();
        if (fp) {
          const recent = Array.isArray(rdlContextRef.current.__recentPurposes)
            ? rdlContextRef.current.__recentPurposes
            : [];
          recent.push(fp.slice(0, 500));
          rdlContextRef.current.__recentPurposes = recent.slice(-RDL_MAX_RECENT_PURPOSES);
        }
        await kinnserSummaryRecordActivity({
          fieldKey: String(p.fieldKey || ''),
          path: String(p.path || ''),
          durationMs: p.durationMs,
          inputEvents: p.inputEvents,
          charLen: p.charLen,
        });
        return;
      }
    },
    [exec, hasApiKey, pushPayload, addLog, showToast, runSuggestLine, autoSuggestEnabled, onAddQuickRule]
  );

  const autoGenFiredRef = useRef('');
  const AUTO_GEN_RE = /summary.*overall.*performance|summary.*patient.*overall|assessment.*visit|visit.*summary|summary.*visit/i;

  useEffect(() => {
    if (site !== siteKinnserName || !kinnserSummaryReady || !exec || !hasKinnserSummaryCopilot()) return undefined;
    const id = setInterval(async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        const signals = await exec(getKinnserSummaryDrainSignalsCode());
        const arr = Array.isArray(signals) ? signals : [];
        const focusSignal = arr.find((x) => x && x.type === 'summary_focus');
        if (focusSignal) {
          const cap = await exec(getKinnserSummaryCaptureCode());
          if (cap?.ok && cap.snapshot) {
            absorbSnapshot(cap.snapshot);
            const fp = String(cap.snapshot?.focusedField?.fieldPurpose || '').trim();
            if (fp) {
              const recent = Array.isArray(rdlContextRef.current.__recentPurposes)
                ? rdlContextRef.current.__recentPurposes
                : [];
              recent.push(fp.slice(0, 500));
              rdlContextRef.current.__recentPurposes = recent.slice(-RDL_MAX_RECENT_PURPOSES);
            }
            // Auto-generate for summary/assessment fields when empty
            const fieldVal = String(cap.snapshot?.focusedField?.value || '').trim();
            const fieldKey = String(focusSignal.id || focusSignal.name || '').trim();
            if (hasApiKey && AUTO_GEN_RE.test(fp) && fieldVal.length < 10 && autoGenFiredRef.current !== fieldKey) {
              autoGenFiredRef.current = fieldKey;
              await pushPayload({ loading: true, status: 'Auto-generating summary...' });
              await handlePending({
                action: 'draft',
                mode: 'generate',
                improveHint: '',
                fieldPurpose: fp,
                fieldKey: fieldKey,
                t: Date.now(),
              });
              ticking.current = false;
              return;
            }
          }
        }
        const pending = await exec(getKinnserSummaryDrainBridgeCode());
        if (pending) await handlePending(pending);
      } finally {
        ticking.current = false;
      }
    }, 120);
    return () => clearInterval(id);
  }, [site, siteKinnserName, kinnserSummaryReady, exec, handlePending, hasApiKey, pushPayload]);
}
