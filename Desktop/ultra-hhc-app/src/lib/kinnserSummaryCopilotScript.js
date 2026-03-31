/**
 * Kinnser Summary Copilot — non-intrusive EMR float: focus-only, stable anchor, dismiss/reopen.
 * Kinnser: primary Live Copilot UI (field label, Learn / Suggest / Clear, optional AI).
 */
export function getKinnserSummaryCopilotBootstrapCode() {
  return `
(function() {
  if (window.__KINNSER_SUMMARY_COPILOT__) return 'SUMMARY_COPILOT_ALREADY';
  var SIGNAL_BUF = [];
  var lastSummaryEl = null;
  var floatUserEnabled = true;
  var scrollDebounce = null;
  var repositionDebounce = null;
  var fieldSessionStart = 0;
  var fieldInputCount = 0;
  var dismissedKeys = {};
  var currentFieldKey = '';
  var REOPEN = null;
  var aiLoading = false;
  var chipManualPos = null;
  var chipDragState = null;
  var panelManualPos = null;
  var panelDragState = null;
  var panelTheme = 'dark';
  var autoSuggestFocusTimer = null;
  var panelMinimized = false;
  var panelPinnedOpen = false;

  var BRIDGE = {
    pending: null,
    pendingAutoSuggest: null,
    lastDraft: '',
    fingerprint: '',
    improveHint: '',
    lastFieldPurpose: '',
    snipList: [],
    suggestChipFullText: '',
    rulesPreview: [],
  };
  var lastAutoReplace = null;

  var SUMMARY_RE = /summary|assessment|narrative|clinical|subjective|objective|evaluation|plan|goal|discharge|justification|comment|note|reason|skilled|performance|this\\s*visit|visit|coordination|transfer|mobility|gait|balance|intervention|poc|care\\s*plan|skilled\\s*care|care\\s*need/i;
  /** Single-line vitals / measures — Kinnser often uses <input>, not <textarea>. */
  var VITALS_RE = /vital|temp|temperature|bp|blood\\s*pressure|sys|dia|heart\\s*rate|pulse|respir|respiration|o2|sat|saturation|oxygen|weight|height|pain|glucose|bs|bmi|lying|standing|kneeling|sitting|prone|supine|position|route|during|post|pre|measure|reading/i;
  /** Kinnser-style opaque field names still map to typed chart cells. */
  var EMR_TEXTINPUT_RE = /writefrm|varchar|spwrite|_frm|frmvarchar/i;

  function trunc(s, n) {
    s = String(s || '').replace(/\\s+/g, ' ').trim();
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
  }

  function textFromId(id) {
    if (!id) return '';
    try {
      var ref = document.getElementById(id.replace(/^#/, ''));
      return ref ? trunc(ref.textContent || ref.innerText || '', 200) : '';
    } catch (e) { return ''; }
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function labelFor(el) {
    if (!el || el.nodeType !== 1) return '';
    var ar = el.getAttribute('aria-label');
    if (ar) return trunc(ar, 200);
    var al = el.getAttribute('aria-labelledby');
    if (al) {
      var ids = al.split(/\\s+/);
      var parts = [];
      for (var i = 0; i < ids.length; i++) {
        var t = textFromId(ids[i]);
        if (t) parts.push(t);
      }
      if (parts.length) return parts.join(' ').slice(0, 200);
    }
    if (el.title) return trunc(el.title, 200);
    if (el.placeholder) return trunc(el.placeholder, 200);
    if (el.name) return trunc(el.name.replace(/[_\\[\\]]+/g, ' '), 120);
    if (el.id) return trunc(el.id.replace(/[_-]+/g, ' '), 120);
    try {
      if (el.labels && el.labels.length) {
        var lb = el.labels[0];
        if (lb) return trunc(lb.textContent || lb.innerText || '', 200);
      }
    } catch (e) {}
    var p = el.parentElement;
    for (var depth = 0; p && depth < 6; depth++, p = p.parentElement) {
      var prev = p.previousElementSibling;
      if (prev) {
        var tag = (prev.tagName || '').toUpperCase();
        if (tag === 'LABEL') return trunc(prev.textContent || prev.innerText || '', 200);
        if (tag === 'TH' || tag === 'TD') return trunc(prev.textContent || prev.innerText || '', 160);
      }
      if ((p.tagName || '').toUpperCase() === 'FIELDSET') {
        var leg = p.querySelector('legend');
        if (leg) return trunc(leg.textContent || '', 200);
      }
    }
    return '';
  }

  /** Walk up DOM: headings, legends, table captions, sibling section bars. */
  function collectSectionTrail(el) {
    var out = [];
    var seen = {};
    var p = el;
    for (var depth = 0; p && depth < 24; depth++) {
      p = p.parentElement;
      if (!p || p === document.body) break;
      var tag = (p.tagName || '').toUpperCase();
      if (tag === 'FIELDSET') {
        var leg = p.querySelector(':scope > legend');
        if (leg) {
          var lt = trunc(leg.textContent || leg.innerText || '', 180);
          if (lt && !seen[lt]) { seen[lt] = 1; out.push(lt); }
        }
      }
      if (tag === 'TABLE' && p.caption) {
        var ct = trunc(p.caption.textContent || '', 180);
        if (ct && !seen[ct]) { seen[ct] = 1; out.unshift(ct); }
      }
      var ps = p.previousElementSibling;
      for (var k = 0; k < 3 && ps; k++) {
        if (!ps || ps.nodeType !== 1) break;
        var ctg = (ps.tagName || '').toUpperCase();
        if (/^H[1-6]$/.test(ctg) || ps.getAttribute('role') === 'heading') {
          var hx = trunc(ps.textContent || ps.innerText || '', 180);
          if (hx && hx.length > 1 && !seen[hx]) { seen[hx] = 1; out.push(hx); }
        }
        ps = ps.previousElementSibling;
      }
    }
    return out.slice(0, 10);
  }

  /** If inside a table cell: caption, row label (first cell), column header. */
  function tableGridContext(el) {
    if (!el || !el.closest) return null;
    var cell = el.closest('td, th');
    if (!cell || (cell.tagName || '').toUpperCase() !== 'TD') return null;
    var tr = cell.parentElement;
    if (!tr || (tr.tagName || '').toUpperCase() !== 'TR') return null;
    var table = tr.closest('table');
    if (!table) return null;
    var colIdx = cell.cellIndex;
    if (colIdx < 0) colIdx = 0;
    var columnLabel = '';
    var thead = table.querySelector('thead tr');
    if (thead) {
      var hc = thead.cells[colIdx];
      if (hc) columnLabel = trunc(hc.textContent || '', 120);
    } else if (table.rows.length > 0 && table.rows[0] !== tr) {
      var fr = table.rows[0];
      if (fr && fr.cells[colIdx]) columnLabel = trunc(fr.cells[colIdx].textContent || '', 120);
    }
    var rowLabel = '';
    if (tr.cells && tr.cells.length) {
      var first = tr.cells[0];
      if (first && first !== cell) rowLabel = trunc(first.textContent || '', 160);
      else if (tr.cells.length > colIdx + 1) rowLabel = trunc(tr.cells[colIdx + 1].textContent || '', 160);
    }
    var cap = table.querySelector('caption');
    var tableCaption = cap ? trunc(cap.textContent || '', 160) : '';
    // Capture sibling cell values from the same row (assist levels, devices, etc.)
    var rowPeerValues = [];
    try {
      for (var ci = 0; ci < tr.cells.length; ci++) {
        var peerCell = tr.cells[ci];
        if (peerCell === cell) continue;
        var peerInputs = peerCell.querySelectorAll('input, select, textarea');
        for (var pi = 0; pi < peerInputs.length; pi++) {
          var pv = '';
          if (peerInputs[pi].tagName === 'SELECT') {
            pv = (peerInputs[pi].selectedOptions && peerInputs[pi].selectedOptions[0]) ? peerInputs[pi].selectedOptions[0].text : peerInputs[pi].value;
          } else {
            pv = peerInputs[pi].value || '';
          }
          pv = String(pv).trim();
          if (!pv) continue;
          var peerColLabel = '';
          if (thead && thead.cells[ci]) peerColLabel = trunc(thead.cells[ci].textContent || '', 80);
          else if (table.rows.length > 0 && table.rows[0] !== tr && table.rows[0].cells[ci]) peerColLabel = trunc(table.rows[0].cells[ci].textContent || '', 80);
          rowPeerValues.push({ column: peerColLabel, value: trunc(pv, 80) });
        }
        // Also capture plain text in cells that have no inputs (e.g. checkboxes with labels)
        if (!peerInputs.length) {
          var ct = trunc(peerCell.textContent || '', 80);
          if (ct && ct !== rowLabel) {
            var cbxs = peerCell.querySelectorAll('input[type="checkbox"]');
            if (cbxs.length) {
              var checkedLabels = [];
              for (var cbi = 0; cbi < cbxs.length; cbi++) {
                if (cbxs[cbi].checked) {
                  var cblabel = cbxs[cbi].nextSibling ? trunc(String(cbxs[cbi].nextSibling.textContent || ''), 30) : '';
                  checkedLabels.push(cblabel || 'checked');
                }
              }
              if (checkedLabels.length) {
                var peerCColLabel = '';
                if (thead && thead.cells[ci]) peerCColLabel = trunc(thead.cells[ci].textContent || '', 80);
                rowPeerValues.push({ column: peerCColLabel, value: checkedLabels.join(', ') });
              }
            }
          }
        }
      }
    } catch (ep) {}
    return { tableCaption: tableCaption, rowLabel: rowLabel, columnLabel: columnLabel, rowPeerValues: rowPeerValues };
  }

  /** Human-readable "what this box is for" — drives prompts + scoped style memory. */
  function fieldSemantics(el) {
    if (!el || el.nodeType !== 1) {
      return { nearLabel: '', sectionTrail: [], tableCaption: '', tableRow: '', tableColumn: '', fieldPurpose: '' };
    }
    var near = labelFor(el);
    var sections = collectSectionTrail(el);
    var tbl = tableGridContext(el);
    var parts = [];
    if (tbl && tbl.tableCaption) parts.push(tbl.tableCaption);
    for (var s = 0; s < sections.length; s++) parts.push(sections[s]);
    if (tbl && tbl.rowLabel) parts.push('Row: ' + tbl.rowLabel);
    if (tbl && tbl.columnLabel) parts.push('Column: ' + tbl.columnLabel);
    if (near) parts.push(near);
    var purpose = parts.join(' \\u203a ').replace(/\\s+/g, ' ').trim();
    if (!purpose) purpose = trunc(near || (el.name || '') || (el.id || '') || 'field', 400);
    var nearbyResult = tbl ? { rows: [], sectionName: '' } : collectNearbySectionData(el);
    return {
      nearLabel: near,
      sectionTrail: sections,
      tableCaption: tbl ? tbl.tableCaption : '',
      tableRow: tbl ? tbl.rowLabel : '',
      tableColumn: tbl ? tbl.columnLabel : '',
      rowPeerValues: tbl ? (tbl.rowPeerValues || []) : [],
      nearbySectionData: nearbyResult.rows || [],
      nearbySectionName: nearbyResult.sectionName || '',
      fieldPurpose: trunc(purpose, 500),
    };
  }

  /** For fields NOT inside a table: scan upward to find the nearest training table and extract all row data. */
  function collectNearbySectionData(el) {

  /** Scan the page for vital sign values — BP, HR, Resp, Temp, O2 Sat, Pain, Weight. */
  function collectVitalsContext() {
    var vitals = {};
    try {
      // Strategy: find all visible inputs/selects near vital-related labels
      var allInputs = document.querySelectorAll('input[type="text"], input:not([type]), select');
      for (var i = 0; i < allInputs.length; i++) {
        var inp = allInputs[i];
        if (!visible(inp)) continue;
        var val = (inp.value || '').trim();
        if (!val) continue;
        var blob = ((inp.name || '') + ' ' + (inp.id || '') + ' ' + labelFor(inp)).toLowerCase();
        // Temperature
        if (/temperature|temp/i.test(blob) && /^\d{2,3}(\.\d)?$/.test(val)) {
          vitals.temperature = val;
        }
        // BP systolic/diastolic — look for paired fields
        if (/systolic|bp.*sys|blood.*pressure/i.test(blob) || (/bp/i.test(blob) && /prior|pre|before/i.test(blob))) {
          if (/^\d{2,3}$/.test(val)) vitals.bpSystolic = val;
        }
        if (/diastolic|bp.*dia/i.test(blob)) {
          if (/^\d{2,3}$/.test(val)) vitals.bpDiastolic = val;
        }
        // Heart rate
        if (/heart.*rate|pulse|hr/i.test(blob) && !/chair/i.test(blob)) {
          if (/^\d{2,3}$/.test(val)) vitals.heartRate = val;
        }
        // Respirations
        if (/respir|resp.*rate/i.test(blob)) {
          if (/^\d{1,2}$/.test(val)) vitals.respirations = val;
        }
        // O2 Sat
        if (/o2.*sat|spo2|oxygen.*sat|sat.*o2/i.test(blob)) {
          if (/^\d{2,3}%?$/.test(val)) vitals.o2Sat = val;
        }
        // Pain
        if (/pain.*level|pain.*scale|pain.*rating|pain.*score/i.test(blob)) {
          vitals.pain = val;
        }
      }
      // Also try to find BP by looking for two adjacent number inputs in BP row
      if (!vitals.bpSystolic) {
        var bpLabel = null;
        var labels = document.querySelectorAll('td, th, label, span, div');
        for (var li = 0; li < labels.length; li++) {
          var lt = (labels[li].textContent || '').trim();
          if (/^BP:?\s*$/i.test(lt) || /Blood\s*Pressure/i.test(lt)) { bpLabel = labels[li]; break; }
        }
        if (bpLabel) {
          var row = bpLabel.closest ? bpLabel.closest('tr') : null;
          if (!row) row = bpLabel.parentElement;
          if (row) {
            var numInputs = row.querySelectorAll('input');
            var nums = [];
            for (var ni = 0; ni < numInputs.length; ni++) {
              var nv = (numInputs[ni].value || '').trim();
              if (/^\d{2,3}$/.test(nv) && Number(nv) > 30 && Number(nv) < 300) nums.push(nv);
            }
            if (nums.length >= 2) {
              // First is systolic (higher), second is diastolic (lower) - or just take as ordered
              vitals.bpSystolic = nums[0];
              vitals.bpDiastolic = nums[1];
            }
          }
        }
      }
      // Find HR/Resp the same way if not found
      if (!vitals.heartRate || !vitals.respirations) {
        var hrLabel = null, respLabel = null;
        var allCells = document.querySelectorAll('td, th');
        for (var ci = 0; ci < allCells.length; ci++) {
          var ct = (allCells[ci].textContent || '').trim();
          if (/^Heart\s*Rate:?\s*$/i.test(ct)) hrLabel = allCells[ci];
          if (/^Respir/i.test(ct)) respLabel = allCells[ci];
        }
        if (hrLabel && !vitals.heartRate) {
          var hrRow = hrLabel.closest ? hrLabel.closest('tr') : null;
          if (hrRow) {
            var hrInps = hrRow.querySelectorAll('input');
            for (var hi = 0; hi < hrInps.length; hi++) {
              var hv = (hrInps[hi].value || '').trim();
              if (/^\d{2,3}$/.test(hv) && Number(hv) > 30 && Number(hv) < 220) { vitals.heartRate = hv; break; }
            }
          }
        }
        if (respLabel && !vitals.respirations) {
          var respRow = respLabel.closest ? respLabel.closest('tr') : null;
          if (respRow) {
            var respInps = respRow.querySelectorAll('input');
            for (var ri = 0; ri < respInps.length; ri++) {
              var rv = (respInps[ri].value || '').trim();
              if (/^\d{1,2}$/.test(rv) && Number(rv) >= 8 && Number(rv) <= 40) { vitals.respirations = rv; break; }
            }
          }
        }
      }
    } catch (e) {}
    return vitals;
  }
    if (!el) return [];
    var result = [];
    var sectionName = '';
    try {
      // Section heading patterns — stop walking when we hit one of these
      var SECTION_HEAD_RE = /^(Bed\s*Mobility|Transfer|Gait|Balance|Therapeutic\s*Exercise|Training\s*Exercise|Stair|Wheelchair|Pain|ROM|Strength|Endurance|Coordination|Safety|Education|Home\s*Exercise|Current\s*Treatment|Vital)/i;

      // Walk previous siblings and parent's previous siblings to find a table
      var node = el;
      var maxSteps = 15;
      while (node && maxSteps-- > 0) {
        // Check previous siblings
        var prev = node.previousElementSibling;
        while (prev && maxSteps-- > 0) {
          // Check if this sibling is or contains a section heading — if so, record name and stop after getting its table
          var headingText = '';
          var hEls = [];
          if (prev.tagName && /^(TD|TH|TR|TABLE|DIV|SPAN|P|H[1-6]|FONT|B|STRONG)$/i.test(prev.tagName)) {
            headingText = (prev.textContent || '').trim().slice(0, 100);
          }
          // Also check for heading-style children (bold, colored, etc.)
          if (!headingText && prev.querySelector) {
            var hc = prev.querySelector('td.bg3, td[class*="bg"], th, b, strong, h1, h2, h3, h4');
            if (hc) headingText = (hc.textContent || '').trim().slice(0, 100);
          }
          // If this is a section heading that doesn't belong to our table, STOP
          if (headingText && SECTION_HEAD_RE.test(headingText) && result.length > 0) {
            // We already have table data — this heading is from a DIFFERENT section above. Stop.
            return { rows: result, sectionName: sectionName };
          }
          // Record section name if we find one
          if (headingText && SECTION_HEAD_RE.test(headingText) && !sectionName) {
            sectionName = headingText.replace(/\s*Training\s*/i, ' Training').trim();
          }

          var tbl = null;
          if ((prev.tagName || '').toUpperCase() === 'TABLE') tbl = prev;
          else tbl = prev.querySelector && prev.querySelector('table');
          if (tbl) {
            var rows = tbl.querySelectorAll('tr');
            // Check if this table's heading tells us the section name
            if (!sectionName) {
              var firstCell = tbl.querySelector('td.bg3, td[class*="bg"], th');
              if (firstCell) {
                var fcText = (firstCell.textContent || '').trim();
                if (SECTION_HEAD_RE.test(fcText)) sectionName = fcText;
              }
            }
            // Get header row for column labels
            var headerCells = [];
            if (rows.length > 0) {
              var hcs = rows[0].querySelectorAll('th, td');
              for (var hi = 0; hi < hcs.length; hi++) {
                headerCells.push(trunc((hcs[hi].textContent || '').trim(), 60));
              }
            }
            // Extract data rows
            for (var ri = 1; ri < rows.length && ri < 20; ri++) {
              var cells = rows[ri].querySelectorAll('td, th');
              var rowData = {};
              var hasValue = false;
              for (var ci = 0; ci < cells.length; ci++) {
                var colName = headerCells[ci] || ('col' + ci);
                var cellInputs = cells[ci].querySelectorAll('input, select, textarea');
                if (cellInputs.length) {
                  for (var ii = 0; ii < cellInputs.length; ii++) {
                    var inp = cellInputs[ii];
                    var val = '';
                    if (inp.tagName === 'SELECT') {
                      val = (inp.selectedOptions && inp.selectedOptions[0]) ? inp.selectedOptions[0].text : inp.value;
                    } else if (inp.type === 'checkbox') {
                      if (inp.checked) val = 'checked';
                    } else {
                      val = inp.value || '';
                    }
                    if (val) { rowData[colName] = (rowData[colName] ? rowData[colName] + ', ' : '') + trunc(val, 120); hasValue = true; }
                  }
                } else {
                  var txt = trunc((cells[ci].textContent || '').trim(), 80);
                  if (txt) rowData[colName] = txt;
                }
              }
              if (hasValue) result.push(rowData);
            }
            if (result.length) return { rows: result, sectionName: sectionName };
          }
          prev = prev.previousElementSibling;
        }
        node = node.parentElement;
      }
    } catch (e) {}
    return { rows: result, sectionName: sectionName };
  }

  function fieldBlob(el) {
    if (!el) return '';
    return (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.className || '') + ' ' + labelFor(el);
  }

  function isTextLikeInput(el) {
    if (!el || (el.tagName || '').toUpperCase() !== 'INPUT') return false;
    var ty = (el.type || '').toLowerCase();
    return ty === 'text' || ty === 'search' || ty === 'number' || ty === '' || ty === 'tel';
  }

  /**
   * Float + Learn/Suggest target: narrative-sized textareas, or text/number inputs that look like
   * free-text, vitals, or EMR-named fields. Select / checkbox / radio are excluded (isMinorControl).
   */
  function isLikelySummaryBox(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = (el.tagName || '').toUpperCase();
    var blob = fieldBlob(el);
    if (tag === 'TEXTAREA') {
      if (SUMMARY_RE.test(blob)) return true;
      var rows = parseInt(el.getAttribute('rows') || '0', 10) || 0;
      var h = el.offsetHeight || 0;
      if (rows >= 3 || h >= 56) return true;
      return false;
    }
    if (tag === 'INPUT' && isTextLikeInput(el)) {
      if (SUMMARY_RE.test(blob) || VITALS_RE.test(blob) || EMR_TEXTINPUT_RE.test(blob)) return true;
      return false;
    }
    return false;
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.offsetParent === null && (el.tagName || '').toUpperCase() !== 'BODY') {
      try {
        var st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      } catch (e) { return false; }
    }
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function fieldKey(el) {
    if (!el) return '';
    try {
      var path = location.pathname || '';
      var sem = fieldSemantics(el);
      return path + '::' + (el.id || '') + '::' + (el.name || '') + '::' + trunc(sem.fieldPurpose || labelFor(el), 200);
    } catch (e) { return ''; }
  }

  /** Short title for the float header (never show internal "unspecified" wording). */
  function displayFieldTitle(el) {
    if (!el) return 'Chart field';
    function looksInternalToken(s) {
      var t = String(s || '').trim();
      if (!t) return false;
      if (t.indexOf('|') >= 0) return true;
      return /(spwrite|writefrm|varchar|max\d+|^frm|^pa[a-z0-9_]+$|[a-z]+[A-Z][a-z]+[A-Z])/i.test(t);
    }
    var raw = labelFor(el);
    if (looksInternalToken(raw)) raw = '';
    if (!raw || raw.length < 2) {
      var sem = fieldSemantics(el);
      raw = looksInternalToken(sem.nearLabel) ? '' : (sem.nearLabel || '');
      if (!raw) {
        if (sem.tableColumn || sem.tableRow) {
          raw = [sem.tableColumn, sem.tableRow].filter(Boolean).join(' · ');
        } else if (Array.isArray(sem.sectionTrail) && sem.sectionTrail.length) {
          raw = sem.sectionTrail[sem.sectionTrail.length - 1] + ' field';
        } else {
          var fp = sem.fieldPurpose || '';
          var segs = fp.split(/\\s*[\\u203a>]\\s*/);
          raw = (segs.length ? segs[segs.length - 1] : fp).trim();
          if (looksInternalToken(raw)) raw = '';
        }
      }
    }
    raw = String(raw).replace(/\\s+/g, ' ').trim();
    raw = raw.replace(/unspecified/gi, '').replace(/\\s+/g, ' ').trim();
    if (!raw) raw = 'Clinical note field';
    return trunc(raw, 64);
  }

  /** Select/checkbox: no large panel (future: minimal hint when host has a suggestion). */
  function isMinorControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = (el.tagName || '').toUpperCase();
    if (t === 'SELECT') return true;
    if (t === 'INPUT') {
      var ty = (el.type || '').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return true;
    }
    return false;
  }

  var ROOT, elStatus, elDraft, elDraftEditor, elHint, elCard, elDraftWrap, elFieldTitle, elLocalSnips;
  var SUGGEST_CHIP, elChipBtn, elChipInput, elChipEdit, elChipSave, elChipRule, elChipNext, elChipUp, elChipDn, elChipX, elChipRulesPanel;
  var chipEditing = false;
  var chipRulesOpen = false;

  /** Stable anchor: align panel to active field box — no caret/cursor tracking. */
  function positionFloatStable() {
    if (!ROOT) return;
    if (panelManualPos && typeof panelManualPos.left === 'number' && typeof panelManualPos.top === 'number') {
      var rw0 = Math.min(ROOT.offsetWidth || 300, window.innerWidth - 12);
      var rh0 = Math.min(ROOT.offsetHeight || 120, window.innerHeight - 8);
      var ml = clamp(panelManualPos.left, 6, window.innerWidth - rw0 - 6);
      var mt = clamp(panelManualPos.top, 6, window.innerHeight - rh0 - 6);
      panelManualPos.left = ml;
      panelManualPos.top = mt;
      ROOT.style.left = ml + 'px';
      ROOT.style.top = mt + 'px';
      return;
    }
    var ta = lastSummaryEl;
    if (!ta) return;
    var r = ta.getBoundingClientRect();
    var rw = Math.min(ROOT.offsetWidth || 300, window.innerWidth - 12);
    var rh = Math.min(ROOT.offsetHeight || 120, window.innerHeight * 0.5);
    var left = r.right - rw - 8;
    var top = r.bottom + 8;
    if (left < 8) left = r.left + 8;
    if (left + rw > window.innerWidth - 8) left = window.innerWidth - rw - 8;
    if (top + rh > window.innerHeight - 8) {
      top = r.top - rh - 8;
      if (top < 8) top = 8;
    }
    left = clamp(left, 6, window.innerWidth - rw - 6);
    top = clamp(top, 6, window.innerHeight - rh - 6);
    ROOT.style.left = left + 'px';
    ROOT.style.top = top + 'px';
  }

  /** Reposition float + floating suggest chip after layout changes. */
  function scheduleReposition() {
    clearTimeout(repositionDebounce);
    repositionDebounce = setTimeout(function() {
      repositionDebounce = null;
      if (panelDragState) return;
      try {
        if (ROOT && ROOT.style.display !== 'none' && !ROOT.contains(document.activeElement)) {
          positionFloatStable();
        }
      } catch (e2) {}
      positionSuggestChip();
    }, 100);
  }

  function persistChipManualPos() {
    if (!chipManualPos) {
      try { localStorage.removeItem('orbit_ksc_chip_manual'); } catch (e1) {}
      return;
    }
    try {
      localStorage.setItem('orbit_ksc_chip_manual', JSON.stringify(chipManualPos));
    } catch (e2) {}
  }

  function resetSuggestChipAnchor() {
    chipManualPos = null;
    persistChipManualPos();
    positionSuggestChip();
  }

  function positionSuggestChip() {
    if (!SUGGEST_CHIP || SUGGEST_CHIP.style.display === 'none') return;
    var chipW = 280;
    var chipH = 38;
    try {
      var cr = SUGGEST_CHIP.getBoundingClientRect();
      if (cr.width > 12) chipW = cr.width;
      if (cr.height > 12) chipH = cr.height;
    } catch (e0) {}
    if (chipManualPos && typeof chipManualPos.left === 'number' && typeof chipManualPos.top === 'number') {
      var ml = clamp(chipManualPos.left, 4, window.innerWidth - chipW - 4);
      var mt = clamp(chipManualPos.top, 4, window.innerHeight - chipH - 4);
      chipManualPos.left = ml;
      chipManualPos.top = mt;
      SUGGEST_CHIP.style.left = ml + 'px';
      SUGGEST_CHIP.style.top = mt + 'px';
      return;
    }
    var ta = lastSummaryEl;
    if (!ta) return;
    var r = ta.getBoundingClientRect();
    var w = Math.min(440, Math.max(240, r.width), window.innerWidth - 16);
    var left = r.left + (r.width - w) / 2;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    var h = 40;
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    SUGGEST_CHIP.style.left = left + 'px';
    SUGGEST_CHIP.style.top = top + 'px';
    SUGGEST_CHIP.style.width = w + 'px';
  }

  function onChipDragMove(ev) {
    if (!chipDragState || !SUGGEST_CHIP) return;
    var dx = ev.clientX - chipDragState.startX;
    var dy = ev.clientY - chipDragState.startY;
    var nl = chipDragState.origLeft + dx;
    var nt = chipDragState.origTop + dy;
    var r2 = SUGGEST_CHIP.getBoundingClientRect();
    var cw = r2.width || 280;
    var ch = r2.height || 36;
    nl = clamp(nl, 4, window.innerWidth - cw - 4);
    nt = clamp(nt, 4, window.innerHeight - ch - 4);
    SUGGEST_CHIP.style.left = nl + 'px';
    SUGGEST_CHIP.style.top = nt + 'px';
    chipManualPos = { left: nl, top: nt };
  }

  function onChipDragUp() {
    if (chipDragState) {
      chipDragState = null;
      persistChipManualPos();
    }
    try {
      document.removeEventListener('mousemove', onChipDragMove, true);
      document.removeEventListener('mouseup', onChipDragUp, true);
    } catch (e3) {}
  }

  function hideSuggestChip() {
    if (SUGGEST_CHIP) SUGGEST_CHIP.style.display = 'none';
    BRIDGE.suggestChipFullText = '';
    chipEditing = false;
    if (elChipInput) elChipInput.style.display = 'none';
    if (elChipBtn) elChipBtn.style.display = 'block';
    if (elChipSave) elChipSave.style.display = 'none';
  }

  function showSuggestChip(text) {
    if (!SUGGEST_CHIP || !elChipBtn) return;
    var t = String(text || '').trim();
    if (!t) { hideSuggestChip(); return; }
    BRIDGE.suggestChipFullText = t;
    elChipBtn.textContent = t;
    elChipBtn.title = t;
    chipEditing = false;
    if (elChipInput) {
      elChipInput.value = t;
      elChipInput.style.display = 'none';
    }
    if (elChipBtn) elChipBtn.style.display = 'block';
    if (elChipSave) elChipSave.style.display = 'none';
    SUGGEST_CHIP.style.display = 'flex';
    if (elChipRulesPanel && !chipRulesOpen) elChipRulesPanel.style.display = 'none';
    positionSuggestChip();
  }

  /** Prevent mousedown from stealing focus away from the chart field (same role as chipMouseDownKeepChartFocus but available at outer scope). */
  function preventFocusLoss(ev) { try { ev.preventDefault(); } catch (e0) {} }

  function renderChipRulesPanel() {
    if (!elChipRulesPanel) return;
    elChipRulesPanel.innerHTML = '';

    // ── Input row ──
    var inputRow = document.createElement('div');
    inputRow.className = 'ksc-rule-input-row';

    var inp = document.createElement('textarea');
    inp.className = 'ksc-rule-input';
    inp.rows = 1;
    inp.placeholder = "e.g. Don't include the word patient";
    inp.addEventListener('mousedown', function(e) { e.stopPropagation(); }, true);
    inp.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); closeRulesPanel(); }
    }, true);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ksc-rule-save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('mousedown', preventFocusLoss, true);
    saveBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var instruction = String(inp.value || '').trim();
      if (!instruction) { inp.focus(); return; }
      var fp = String(BRIDGE.lastFieldPurpose || '').trim();
      BRIDGE.pending = {
        action: 'add_field_instruction_rule',
        fieldPurpose: fp,
        fieldKey: currentFieldKey || '',
        instruction: instruction.slice(0, 500),
        t: Date.now(),
      };
      if (elStatus) elStatus.textContent = 'Saving rule\u2026';
      inp.value = '';
      closeRulesPanel();
    }, true);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ksc-rule-cancel-btn';
    cancelBtn.textContent = '\u00D7';
    cancelBtn.title = 'Close';
    cancelBtn.addEventListener('mousedown', preventFocusLoss, true);
    cancelBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      closeRulesPanel();
    }, true);

    inputRow.appendChild(inp);
    inputRow.appendChild(saveBtn);
    inputRow.appendChild(cancelBtn);
    elChipRulesPanel.appendChild(inputRow);

    // ── Existing rules list (filtered to current field) ──
    var allRules = Array.isArray(BRIDGE.rulesPreview) ? BRIDGE.rulesPreview : [];
    var fk = String(currentFieldKey || '').trim();
    var rules = [];
    for (var fi = 0; fi < allRules.length; fi++) {
      var ruleFieldKey = String(allRules[fi].fieldKey || '').trim();
      // Only show rules that match this specific field
      if (fk && ruleFieldKey === fk) rules.push(allRules[fi]);
    }
    if (rules.length) {
      var listDiv = document.createElement('div');
      listDiv.className = 'ksc-rule-list';
      for (var ri = 0; ri < rules.length; ri++) {
        (function(rule) {
          var item = document.createElement('div');
          item.className = 'ksc-rule-item';
          var dot = document.createElement('span');
          dot.className = 'ksc-rule-dot';
          var txt = document.createElement('span');
          txt.className = 'ksc-rule-text';
          txt.textContent = String(rule.name || rule.instruction || rule.mode || 'Rule').slice(0, 120);
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'ksc-rule-del';
          del.textContent = '\u00D7';
          del.title = 'Remove rule';
          del.addEventListener('mousedown', preventFocusLoss, true);
          del.addEventListener('click', function(ev) {
            ev.stopPropagation();
            BRIDGE.pending = {
              action: 'delete_field_rule',
              ruleId: String(rule.id || ''),
              fieldPurpose: String(BRIDGE.lastFieldPurpose || ''),
              fieldKey: currentFieldKey || '',
              t: Date.now(),
            };
            if (elStatus) elStatus.textContent = 'Removing rule\u2026';
            item.remove();
          }, true);
          item.appendChild(dot);
          item.appendChild(txt);
          item.appendChild(del);
          listDiv.appendChild(item);
        })(rules[ri]);
      }
      elChipRulesPanel.appendChild(listDiv);
    }

    // ── Hint ──
    var hint = document.createElement('div');
    hint.className = 'ksc-rule-hint';
    hint.textContent = rules.length
      ? 'Rules apply to future suggestions for this field.'
      : 'Add a rule for how suggestions should be written for this field.';
    elChipRulesPanel.appendChild(hint);

    // Auto-focus the input
    setTimeout(function() { try { inp.focus(); } catch(e) {} }, 40);
  }

  function closeRulesPanel() {
    chipRulesOpen = false;
    if (elChipRulesPanel) elChipRulesPanel.style.display = 'none';
    positionSuggestChip();
  }

  /** Append a message to the chat log. */
  function appendChatMsg(role, text) {
    if (!ROOT) return;
    var log = ROOT.querySelector('#orbit-ksc-chat-log');
    if (!log) return;
    // If last message is agent "Working...", replace it
    if (role === 'agent') {
      var last = log.lastElementChild;
      if (last && last.getAttribute('data-role') === 'agent' && last.textContent === 'Working...') {
        last.remove();
      }
    }
    var div = document.createElement('div');
    div.setAttribute('data-role', role);
    div.style.cssText = role === 'user'
      ? 'margin:4px 0;padding:5px 8px;border-radius:8px;background:#EFF6FF;color:#1E293B;text-align:right;word-break:break-word;'
      : 'margin:4px 0;padding:5px 8px;border-radius:8px;background:#F1F5F9;color:#475569;word-break:break-word;white-space:pre-wrap;';
    div.textContent = String(text || '');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function setupChatInput() {
    if (!ROOT) return;
    var chatInput = ROOT.querySelector('#orbit-ksc-chat-input');
    if (!chatInput || chatInput._kscBound) return;
    chatInput._kscBound = true;
    chatInput.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var sendBtn = ROOT.querySelector('[data-ksc="chat_send"]');
        if (sendBtn) sendBtn.click();
      }
    });
    chatInput.addEventListener('input', function() {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(80, chatInput.scrollHeight) + 'px';
    });
  }

  /** Render the rules panel inside the main copilot panel (not the chip). */
  function renderPanelRulesSection(container) {
    if (!container) return;
    container.innerHTML = '';
    container.style.cssText = 'display:block;padding:10px 14px;border-bottom:1px solid #F1F5F9;';

    // Input row
    var inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:4px;align-items:flex-start;';
    var inp = document.createElement('textarea');
    inp.rows = 1;
    inp.placeholder = "e.g. Don't include the word patient";
    inp.style.cssText = 'flex:1;background:#F8FAFC;border:1px solid #E2E8F0;color:#1E293B;font-size:11px;border-radius:6px;padding:5px 7px;line-height:1.3;min-height:1.8em;resize:none;box-sizing:border-box;font-family:inherit;';
    inp.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
    });
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'flex-shrink:0;padding:4px 10px;border-radius:8px;border:1px solid #A7F3D0;background:#ECFDF5;color:#059669;cursor:pointer;font-size:11px;font-weight:700;line-height:1.2;font-family:inherit;';
    saveBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var instruction = String(inp.value || '').trim();
      if (!instruction) { inp.focus(); return; }
      BRIDGE.pending = {
        action: 'add_field_instruction_rule',
        fieldPurpose: String(BRIDGE.lastFieldPurpose || '').trim(),
        fieldKey: currentFieldKey || '',
        instruction: instruction.slice(0, 500),
        t: Date.now(),
      };
      if (elStatus) elStatus.textContent = 'Saving rule\\u2026';
      inp.value = '';
      setTimeout(function() { renderPanelRulesSection(container); }, 800);
    });
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '\\u00D7';
    closeBtn.title = 'Close rules';
    closeBtn.style.cssText = 'flex-shrink:0;padding:4px 8px;border-radius:8px;border:1px solid #E2E8F0;background:#F1F5F9;color:#64748B;cursor:pointer;font-size:11px;font-weight:700;line-height:1.2;font-family:inherit;';
    closeBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      container.style.display = 'none';
    });
    inputRow.appendChild(inp);
    inputRow.appendChild(saveBtn);
    inputRow.appendChild(closeBtn);
    container.appendChild(inputRow);

    // Existing rules for this field only
    var allRules = Array.isArray(BRIDGE.rulesPreview) ? BRIDGE.rulesPreview : [];
    var fk = String(currentFieldKey || '').trim();
    var rules = [];
    for (var fi = 0; fi < allRules.length; fi++) {
      var ruleFieldKey = String(allRules[fi].fieldKey || '').trim();
      // Only show rules that match this specific field
      if (fk && ruleFieldKey === fk) rules.push(allRules[fi]);
    }
    if (rules.length) {
      var listDiv = document.createElement('div');
      listDiv.style.cssText = 'margin-top:6px;max-height:120px;overflow-y:auto;';
      for (var ri = 0; ri < rules.length; ri++) {
        (function(rule) {
          var item = document.createElement('div');
          item.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 0;font-size:10px;color:#94a3b8;line-height:1.3;';
          var dot = document.createElement('span');
          dot.style.cssText = 'flex-shrink:0;width:5px;height:5px;border-radius:50%;background:#3B82F6;';
          var txt = document.createElement('span');
          txt.style.cssText = 'flex:1;word-break:break-word;';
          txt.textContent = String(rule.name || rule.instruction || rule.mode || 'Rule').slice(0, 120);
          var del = document.createElement('button');
          del.type = 'button';
          del.textContent = '\\u00D7';
          del.title = 'Remove rule';
          del.style.cssText = 'flex-shrink:0;background:none;border:none;color:#64748b;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;';
          del.addEventListener('click', function(ev) {
            ev.stopPropagation();
            BRIDGE.pending = {
              action: 'delete_field_rule',
              ruleId: String(rule.id || ''),
              fieldPurpose: String(BRIDGE.lastFieldPurpose || ''),
              fieldKey: currentFieldKey || '',
              t: Date.now(),
            };
            if (elStatus) elStatus.textContent = 'Removing rule\\u2026';
            item.remove();
          });
          item.appendChild(dot);
          item.appendChild(txt);
          item.appendChild(del);
          listDiv.appendChild(item);
        })(rules[ri]);
      }
      container.appendChild(listDiv);
    }

    var hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#64748b;margin-top:4px;';
    hint.textContent = rules.length
      ? 'Rules apply to AI suggestions and Generate for this field.'
      : 'Add a rule for how AI suggestions should be written.';
    container.appendChild(hint);
    setTimeout(function() { try { inp.focus(); } catch(e) {} }, 40);
  }

  function resizeChipEditorToContent() {
    if (!elChipInput) return;
    try {
      elChipInput.style.height = 'auto';
      var maxH = Math.max(160, Math.floor((window.innerHeight || 900) * 0.62));
      var nextH = Math.min(maxH, Math.max(90, (elChipInput.scrollHeight || 0) + 2));
      elChipInput.style.maxHeight = maxH + 'px';
      elChipInput.style.height = nextH + 'px';
      elChipInput.style.overflowY = (elChipInput.scrollHeight || 0) > nextH + 1 ? 'auto' : 'hidden';
    } catch (e0) {}
    positionSuggestChip();
  }

  function persistPanelTheme() {
    try { localStorage.setItem('orbit_ksc_panel_theme', panelTheme); } catch (e0) {}
  }

  function applyPanelTheme() {
    if (!ROOT) return;
    ROOT.setAttribute('data-theme', panelTheme);
    if (elCard) {
      if (panelTheme === 'light') elCard.style.filter = 'invert(1) hue-rotate(180deg)';
      else elCard.style.filter = '';
    }
    var tb = ROOT.querySelector('[data-ksc="theme"]');
    if (tb) tb.textContent = panelTheme === 'light' ? '🌙' : '☀';
  }

  function togglePanelTheme() {
    panelTheme = panelTheme === 'light' ? 'dark' : 'light';
    applyPanelTheme();
    persistPanelTheme();
  }

  function hideMainPanel() {
    if (ROOT) ROOT.style.display = 'none';
    hideSuggestChip();
  }

  function setPanelMinimized(on, force) {
    // If panel is pinned open by user clicking "Live Copilot", don't allow auto-minimize
    // Only explicit user action (minimize button) passes force=true
    if (!!on && panelPinnedOpen && !force) return;
    panelMinimized = !!on;
    if (panelMinimized) panelPinnedOpen = false;
    if (!ROOT) return;
    if (panelMinimized) {
      ROOT.style.display = 'none';
      showReopenChip(true);
      return;
    }
    if (panelPinnedOpen && floatUserEnabled) {
      showReopenChip(false);
      ROOT.style.display = 'block';
      positionFloatStable();
      syncDraftChrome();
      refreshFieldTitle();
      return;
    }
    if (lastSummaryEl && document.activeElement === lastSummaryEl && floatUserEnabled) {
      showReopenChip(false);
      ROOT.style.display = 'block';
      positionFloatStable();
      syncDraftChrome();
      refreshFieldTitle();
    } else {
      // Keep reopen visible if user un-minimizes while not focused in a chart field.
      showReopenChip(true);
    }
  }

  function syncDraftChrome() {
    if (!elDraft || !elDraftWrap) return;
    var has = !!(BRIDGE.lastDraft && String(BRIDGE.lastDraft).trim()) || aiLoading;
    elDraftWrap.style.display = has ? 'block' : 'none';
  }

  function setDraftEditMode(on) {
    var show = !!on;
    if (elDraft) elDraft.style.display = show ? 'none' : 'block';
    if (elDraftEditor) elDraftEditor.style.display = show ? 'block' : 'none';
    var bSave = ROOT && ROOT.querySelector('[data-ksc="edit_save"]');
    var bCancel = ROOT && ROOT.querySelector('[data-ksc="edit_cancel"]');
    if (bSave) bSave.style.display = show ? 'inline-flex' : 'none';
    if (bCancel) bCancel.style.display = show ? 'inline-flex' : 'none';
  }

  function showReopenChip(show) {
    if (!REOPEN) return;
    REOPEN.style.display = show ? 'block' : 'none';
  }

  function refreshFieldTitle() {
    if (!elFieldTitle) return;
    if (lastSummaryEl) elFieldTitle.textContent = displayFieldTitle(lastSummaryEl);
    else elFieldTitle.textContent = 'Chart field';
  }

  function renderSnipButtons(list) {
    if (!elLocalSnips) return;
    elLocalSnips.innerHTML = '';
    BRIDGE.snipList = Array.isArray(list) ? list : [];
    if (!BRIDGE.snipList.length) {
      elLocalSnips.innerHTML = '<div style="font-size:11px;color:#64748b;line-height:1.4;">No saved examples yet. Type in this field and click Learn.</div>';
      return;
    }
    var count = document.createElement('div');
    count.style.cssText = 'font-size:11px;color:#3B82F6;font-weight:700;padding:2px 2px 4px;';
    count.textContent = BRIDGE.snipList.length + ' saved example' + (BRIDGE.snipList.length === 1 ? '' : 's');
    elLocalSnips.appendChild(count);
    for (var i = 0; i < BRIDGE.snipList.length; i++) {
      var row = document.createElement('div');
      row.className = 'orbit-ksc-sniprow';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'orbit-ksc-btn orbit-ksc-snip';
      b.setAttribute('data-idx', String(i));
      var sn = BRIDGE.snipList[i];
      b.textContent = trunc(sn, 84) + (sn.length > 84 ? '…' : '');
      var dup = document.createElement('button');
      dup.type = 'button';
      dup.className = 'orbit-ksc-snippet-dup';
      dup.setAttribute('data-dup-idx', String(i));
      dup.title = 'Duplicate — saves a copy for this field';
      dup.textContent = '⎘';
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'orbit-ksc-snippet-del';
      del.setAttribute('data-del-idx', String(i));
      del.title = 'Delete this saved line';
      del.textContent = '×';
      row.appendChild(b);
      row.appendChild(dup);
      row.appendChild(del);
      elLocalSnips.appendChild(row);
    }
  }

  function presentForField(el) {
    if (!floatUserEnabled || !el) return;
    var dis = dismissedKeys[currentFieldKey];
    if (dis) {
      hideMainPanel();
      showReopenChip(true);
      return;
    }
    if (panelMinimized) {
      showReopenChip(true);
      return;
    }
    if (panelPinnedOpen) {
      showReopenChip(false);
      if (ROOT) {
        ROOT.style.display = 'block';
        positionFloatStable();
        syncDraftChrome();
        refreshFieldTitle();
      }
      return;
    }
    showReopenChip(false);
    if (ROOT) {
      ROOT.style.display = 'block';
      positionFloatStable();
      syncDraftChrome();
      refreshFieldTitle();
    }
  }

  /** After enough saved lines (host checks count), auto-offers a one-line pill; debounced on focus. */
  var AUTO_GEN_HINT = /summary.*overall.*performance|summary.*patient.*overall|assessment.*visit|visit.*summary|summary.*visit/i;
  var autoGenFiredForKey = '';
  function scheduleAutoSuggestAfterFocus(el, fieldPurpose) {
    if (!floatUserEnabled || !el) return;
    clearTimeout(autoSuggestFocusTimer);
    autoSuggestFocusTimer = setTimeout(function() {
      autoSuggestFocusTimer = null;
      try {
        // Use lastSummaryEl instead of activeElement - panel may have stolen focus
        if (lastSummaryEl !== el) return;
        if (BRIDGE.pending) return;
        var fp = String(fieldPurpose || '').trim();
        if (fp.length < 4) return;
        // Auto-generate for summary/assessment fields (large empty boxes)
        var val = String(el.value || '').trim();
        var fk = fieldKey(el);
        if (AUTO_GEN_HINT.test(fp) && val.length < 10 && autoGenFiredForKey !== fk) {
          autoGenFiredForKey = fk;
          BRIDGE.pending = {
            action: 'draft',
            mode: 'generate',
            improveHint: '',
            fieldPurpose: fp,
            fieldKey: fk,
            t: Date.now(),
          };
          if (elStatus) elStatus.textContent = 'Auto-generating summary...';
          return;
        }
        BRIDGE.pendingAutoSuggest = {
          action: 'auto_suggest_if_ready',
          fieldPurpose: fp,
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
      } catch (e0) {}
    }, 400);
  }

  function onDocFocusIn(ev) {
    var el = ev.target;
    if (ROOT && ROOT.contains(el)) return;
    if (SUGGEST_CHIP && SUGGEST_CHIP.contains(el)) return;
    if (isMinorControl(el)) return;
    if (!isLikelySummaryBox(el)) return;
    var nk = fieldKey(el);
    if (currentFieldKey && nk !== currentFieldKey) {
      panelManualPos = null;
      hideSuggestChip();
      BRIDGE.lastDraft = '';
      aiLoading = false;
      if (elDraft) elDraft.textContent = '';
      if (elStatus) elStatus.textContent = '';
      syncDraftChrome();
    }
    currentFieldKey = nk;
    lastSummaryEl = el;
    var sem0 = fieldSemantics(el);
    BRIDGE.lastFieldPurpose = sem0.fieldPurpose || '';
    fieldSessionStart = Date.now();
    fieldInputCount = 0;
    SIGNAL_BUF.push({
      t: Date.now(),
      type: 'summary_focus',
      tag: (el.tagName || '').toUpperCase(),
      label: trunc(labelFor(el), 160),
      fieldPurpose: trunc(sem0.fieldPurpose, 240),
      id: trunc(el.id || '', 80),
      name: trunc(el.name || '', 80),
    });
    if (SIGNAL_BUF.length > 30) SIGNAL_BUF.shift();
    presentForField(el);
    scheduleAutoSuggestAfterFocus(el, sem0.fieldPurpose || '');
    // Auto-fetch saved snippets for this field
    if (!BRIDGE.pending) {
      BRIDGE.pending = {
        action: 'list_saved_phrases',
        fieldPurpose: sem0.fieldPurpose || '',
        fieldKey: nk,
        t: Date.now(),
      };
    }
  }

  function onDocFocusOut(ev) {
    var t = ev.target;
    var fromNarrative = t && isLikelySummaryBox(t);
    var fromPanel = t && ROOT && ROOT.contains(t);
    if (!fromNarrative && !fromPanel) return;
    var narrEl = fromNarrative ? t : null;
    var tsStart = fromNarrative ? fieldSessionStart : 0;
    var inpC = fromNarrative ? fieldInputCount : 0;
    var fk = fromNarrative ? fieldKey(t) : '';
    var path = '';
    try { path = location.pathname || ''; } catch (e0) {}
    var charLen = narrEl ? String(narrEl.value || '').length : 0;
    setTimeout(function() {
      var ae = document.activeElement;
      if (narrEl && tsStart) {
        var switchedToOther = ae && isLikelySummaryBox(ae) && ae !== narrEl;
        var leftField = !ae || !isLikelySummaryBox(ae) || switchedToOther;
        var wentToPanel = ae && ROOT && ROOT.contains(ae);
        if (leftField && !wentToPanel && !BRIDGE.pending) {
          BRIDGE.pending = {
            action: 'field_learn',
            fieldKey: fk,
            path: path,
            durationMs: Math.min(86400000, Date.now() - tsStart),
            inputEvents: inpC,
            charLen: charLen,
            t: Date.now(),
          };
        }
      }
      if (ae && ROOT && ROOT.contains(ae)) return;
      if (ae && SUGGEST_CHIP && SUGGEST_CHIP.contains(ae)) return;
      if (chipEditing) return;
      if (chipRulesOpen) return;
      if (ae && isLikelySummaryBox(ae)) return;
      if (panelPinnedOpen) return;
      hideMainPanel();
      showReopenChip(panelMinimized);
    }, 0);
  }

  // ── Section Template Overlay ────────────────────────────────────
  var TEMPLATE_OVERLAY = null;
  var templateOverlayOpen = false;
  var templateSectionType = '';
  var templateSectionEl = null;
  var templateHeadingEl = null;
  var templateList = [];

  /** Find the nearest section table/container from a heading element. */
  function findSectionContainer(headingEl) {
    if (!headingEl) return null;

    // Strategy: find the table the heading lives in, plus any sibling tables immediately after it
    // that are part of the same section (e.g. Exercise 1-4 table + Exercise 5-8 table)
    var headingCell = headingEl.closest ? headingEl.closest('td, th') : null;
    var headingRow = headingCell ? headingCell.closest('tr') : null;
    var headingTable = headingRow ? headingRow.closest('table') : null;

    if (headingTable) {
      // Check for sibling tables right after this one (Kinnser often splits into multiple tables)
      var tables = [headingTable];
      var next = headingTable.nextElementSibling;
      var sectionHeadingRe = /^\\s*(bed\\s*mobility|transfer\\s*training|gait\\s*training|balance\\s*training|training\\s*exercise|therapeutic|stair)/i;
      while (next) {
        // Stop if we hit another section heading
        var nextText = (next.textContent || '').replace(/\\s+/g, ' ').trim();
        if (nextText.length < 80 && sectionHeadingRe.test(nextText)) break;
        if (next.tagName === 'TABLE') {
          tables.push(next);
        } else if (next.querySelector && next.querySelector('table')) {
          var innerTables = next.querySelectorAll('table');
          for (var ti = 0; ti < innerTables.length; ti++) tables.push(innerTables[ti]);
        }
        next = next.nextElementSibling;
      }

      if (tables.length === 1) return headingTable;

      // Multiple tables — create a wrapper element to hold references
      var wrapper = document.createElement('div');
      wrapper.style.display = 'none';
      wrapper._kscMultiTables = tables;
      return wrapper;
    }

    // Heading not in table — walk siblings
    var next2 = headingEl.nextElementSibling;
    while (next2) {
      if (next2.tagName === 'TABLE' || (next2.querySelector && next2.querySelector('table'))) {
        return next2.tagName === 'TABLE' ? next2 : next2.querySelector('table');
      }
      if (next2.tagName === 'DIV' && next2.querySelectorAll('input, select, textarea').length > 3) return next2;
      next2 = next2.nextElementSibling;
    }
    var parent = headingEl.parentElement;
    if (parent) {
      var tbl = parent.querySelector('table');
      if (tbl) return tbl;
    }
    return null;
  }

  /** Get all field elements from a container (supports multi-table wrappers). */
  function getSectionFields(container) {
    if (!container) return [];
    if (container._kscMultiTables) {
      var all = [];
      for (var ti = 0; ti < container._kscMultiTables.length; ti++) {
        var els = container._kscMultiTables[ti].querySelectorAll('input, select, textarea');
        for (var ei = 0; ei < els.length; ei++) all.push(els[ei]);
      }
      return all;
    }
    var result = container.querySelectorAll('input, select, textarea');
    return Array.prototype.slice.call(result);
  }

  /** Collect ALL form fields between this heading and the next section heading.
   *  Uses bg3 cells as section dividers — gets all inputs between two bg3 cells. */
  function collectFieldsFromHeading(headingEl) {
    if (!headingEl) return [];
    var fields = [];
    try {
      // Step 1: Get ALL bg3 section heading cells on the page, in document order
      var allBg3 = [];
      var allCells = document.querySelectorAll('td, th');
      for (var ci = 0; ci < allCells.length; ci++) {
        var cell = allCells[ci];
        var cls = (cell.className || '').toLowerCase();
        // Kinnser uses bg3 class for section headers
        if (cls.indexOf('bg3') >= 0 || cls.indexOf('bg2') >= 0) {
          var ct = (cell.textContent || '').trim();
          if (ct.length > 2 && ct.length < 100) allBg3.push(cell);
        }
      }

      // Step 2: Find OUR heading's bg3 cell (headingEl itself or its parent)
      var ourBg3 = null;
      for (var bi = 0; bi < allBg3.length; bi++) {
        if (allBg3[bi] === headingEl || allBg3[bi].contains(headingEl) || headingEl.contains(allBg3[bi])) {
          ourBg3 = allBg3[bi];
          break;
        }
      }
      // If heading isn't a bg3 cell, use the heading itself as the start marker
      var startMarker = ourBg3 || headingEl;

      // Step 3: Find the NEXT bg3 cell after ours in document order
      var nextBg3 = null;
      for (var ni = 0; ni < allBg3.length; ni++) {
        var candidate = allBg3[ni];
        if (candidate === ourBg3) continue;
        if (candidate === headingEl) continue;
        if (candidate.contains(headingEl) || headingEl.contains(candidate)) continue;
        var pos = startMarker.compareDocumentPosition(candidate);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
          if (!nextBg3) {
            nextBg3 = candidate;
          } else {
            // Keep the closest one
            var posVsNext = candidate.compareDocumentPosition(nextBg3);
            if (posVsNext & Node.DOCUMENT_POSITION_FOLLOWING) {
              nextBg3 = candidate; // candidate comes before nextBg3, so it's closer
            }
          }
        }
      }

      // Step 4: Get ALL inputs on the page that are between startMarker and nextBg3
      var allInputs = document.querySelectorAll('input, select, textarea');
      for (var fi = 0; fi < allInputs.length; fi++) {
        var f = allInputs[fi];
        if (f.type === 'hidden') continue;
        // Skip overlay/panel fields
        if (TEMPLATE_OVERLAY && TEMPLATE_OVERLAY.contains(f)) continue;
        if (ROOT && ROOT.contains(f)) continue;
        // Must come AFTER our heading
        var cmpStart = startMarker.compareDocumentPosition(f);
        if (!(cmpStart & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        // Must come BEFORE the next section (if any)
        if (nextBg3) {
          var cmpEnd = nextBg3.compareDocumentPosition(f);
          if (!(cmpEnd & Node.DOCUMENT_POSITION_PRECEDING)) continue;
        }
        fields.push(f);
      }
      console.log('[Template] collectFieldsFromHeading: found ' + fields.length + ' fields between "' + (startMarker.textContent || '').trim().slice(0,40) + '" and "' + (nextBg3 ? (nextBg3.textContent || '').trim().slice(0,40) : 'END') + '". allBg3=' + allBg3.length);
    } catch (e) {}
    return fields;
  }

  /** Always get fresh fields from the stored heading. */
  function getFreshTemplateFields() {
    if (templateHeadingEl) {
      var fields = collectFieldsFromHeading(templateHeadingEl);
      if (fields.length > 0) return fields;
    }
    // Fallback to container-based approach
    var container = templateHeadingEl ? findSectionContainer(templateHeadingEl) : templateSectionEl;
    if (!container) container = templateSectionEl;
    return getSectionFields(container);
  }

  /** Capture all input/select/textarea values from a section container. */
  function captureSectionValues(container) {
    if (!container) return {};
    var data = {};
    var els = getSectionFields(container);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // Use positional index as key — field IDs are dynamic per visit in Kinnser
      var key = 'pos_' + i;
      if (el.tagName === 'SELECT') {
        data[key] = { type: 'select', value: el.value, text: el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value };
      } else if (el.type === 'checkbox') {
        data[key] = { type: 'checkbox', checked: el.checked };
      } else if (el.type === 'radio') {
        if (el.checked) data[key] = { type: 'radio', checked: true, value: el.value };
      } else {
        data[key] = { type: el.tagName === 'TEXTAREA' ? 'textarea' : 'input', value: el.value || '' };
      }
    }
    return data;
  }

  /** Fill section container from saved template data. */
  function fillSectionFromTemplate(container, data) {
    if (!container || !data) return 0;
    var els = getSectionFields(container);
    var filled = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = 'pos_' + i;
      var d = data[key];
      if (!d) continue;
      try {
        if (el.tagName === 'SELECT' && d.value != null) {
          el.value = d.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        } else if (el.type === 'checkbox' && d.checked != null) {
          if (el.checked !== d.checked) { el.click(); filled++; }
        } else if (el.type === 'radio' && d.checked) {
          if (!el.checked) { el.click(); filled++; }
        } else if (d.value != null) {
          el.value = d.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      } catch (ef) {}
    }
    return filled;
  }

  function createTemplateOverlay() {
    if (TEMPLATE_OVERLAY) return;
    var overlay = document.createElement('div');
    overlay.id = 'orbit-ksc-tpl-overlay';
    overlay.style.cssText = 'display:none;position:fixed;z-index:2147483647;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.55);font-family:system-ui,-apple-system,sans-serif;';
    overlay.innerHTML =
      '<div id="orbit-ksc-tpl-modal" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(460px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.10);padding:0;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid #E2E8F0;">' +
          '<div style="font-size:14px;font-weight:700;color:#1E293B;" id="orbit-ksc-tpl-title">Exercise Templates</div>' +
          '<button type="button" id="orbit-ksc-tpl-close" style="background:#F1F5F9;border:none;color:#64748B;font-size:16px;border-radius:6px;cursor:pointer;padding:0 4px;line-height:1;">\\u00D7</button>' +
        '</div>' +
        '<div style="padding:12px 16px;">' +
          '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
            '<input type="text" id="orbit-ksc-tpl-name" placeholder="Template name" style="flex:1;background:#F8FAFC;border:1px solid #E2E8F0;color:#1E293B;font-size:12px;border-radius:8px;padding:7px 10px;font-family:inherit;" />' +
            '<button type="button" id="orbit-ksc-tpl-save" style="flex-shrink:0;padding:7px 14px;border-radius:8px;border:1px solid #A7F3D0;background:#ECFDF5;color:#059669;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;">Save current</button>' +
          '</div>' +
          '<div id="orbit-ksc-tpl-list" style="max-height:50vh;overflow-y:auto;"></div>' +
          '<div id="orbit-ksc-tpl-empty" style="font-size:11px;color:#64748b;text-align:center;padding:16px 0;">No saved templates yet. Fill in exercises and click Save.</div>' +
        '</div>' +
      '</div>';
    document.documentElement.appendChild(overlay);
    TEMPLATE_OVERLAY = overlay;

    overlay.querySelector('#orbit-ksc-tpl-close').addEventListener('click', function() { closeTemplateOverlay(); });
    overlay.addEventListener('click', function(ev) { if (ev.target === overlay) closeTemplateOverlay(); });

    overlay.querySelector('#orbit-ksc-tpl-save').addEventListener('click', function(ev) {
      ev.stopPropagation();
      var nameInput = overlay.querySelector('#orbit-ksc-tpl-name');
      var name = String(nameInput ? nameInput.value : '').trim();
      if (!name) { if (nameInput) nameInput.focus(); return; }
      var data = {};
      var els = getFreshTemplateFields();
      console.log('[Template] Save: found ' + els.length + ' fields. headingEl=' + (templateHeadingEl ? (templateHeadingEl.textContent||'').trim().slice(0,30) : 'null'));
      if (elStatus) elStatus.textContent = 'Saving ' + els.length + ' fields...';
      if (!els.length) {
        if (elStatus) elStatus.textContent = 'ERROR: Found 0 fields — check heading element';
        return;
      }
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var key = 'pos_' + i;
        if (el.tagName === 'SELECT') {
          data[key] = { type: 'select', value: el.value, text: el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value };
        } else if (el.type === 'checkbox') {
          data[key] = { type: 'checkbox', checked: el.checked };
        } else if (el.type === 'radio') {
          if (el.checked) data[key] = { type: 'radio', checked: true, value: el.value };
        } else {
          data[key] = { type: el.tagName === 'TEXTAREA' ? 'textarea' : 'input', value: el.value || '' };
        }
      }
      BRIDGE.pending = {
        action: 'section_template_save',
        sectionType: templateSectionType,
        name: name,
        data: data,
        t: Date.now(),
      };
      if (nameInput) nameInput.value = '';
    });
  }

  function renderTemplateList() {
    if (!TEMPLATE_OVERLAY) return;
    var listDiv = TEMPLATE_OVERLAY.querySelector('#orbit-ksc-tpl-list');
    var emptyDiv = TEMPLATE_OVERLAY.querySelector('#orbit-ksc-tpl-empty');
    if (!listDiv) return;
    listDiv.innerHTML = '';
    var tpls = Array.isArray(templateList) ? templateList : [];
    if (emptyDiv) emptyDiv.style.display = tpls.length ? 'none' : 'block';

    // Drag state
    var dragIdx = -1;
    var dragOverIdx = -1;
    var rowEls = [];

    for (var ti = 0; ti < tpls.length; ti++) {
      (function(tpl, idx) {
        var row = document.createElement('div');
        row.setAttribute('data-tpl-idx', String(idx));
        row.draggable = true;
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid #F1F5F9;border-radius:6px;transition:background .12s;';

        // Drag handle
        var handle = document.createElement('div');
        handle.style.cssText = 'flex-shrink:0;cursor:grab;padding:2px 4px;color:#CBD5E1;font-size:14px;line-height:1;user-select:none;';
        handle.innerHTML = '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/><circle cx="3" cy="7" r="1.5"/><circle cx="7" cy="7" r="1.5"/><circle cx="3" cy="12" r="1.5"/><circle cx="7" cy="12" r="1.5"/></svg>';
        handle.title = 'Drag to reorder';

        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        var nameSpan = document.createElement('div');
        nameSpan.style.cssText = 'font-size:13px;font-weight:600;color:#1E293B;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameSpan.textContent = String(tpl.name || 'Untitled');
        var dateSpan = document.createElement('div');
        dateSpan.style.cssText = 'font-size:10px;color:#64748b;margin-top:2px;';
        var fieldCount = 0;
        try { fieldCount = Object.keys(tpl.data || {}).length; } catch (e) {}
        dateSpan.textContent = fieldCount + ' fields \\u00B7 ' + (tpl.ts ? new Date(tpl.ts).toLocaleDateString() : '');
        info.appendChild(nameSpan);
        info.appendChild(dateSpan);

        var loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.style.cssText = 'flex-shrink:0;padding:5px 12px;border-radius:8px;border:1px solid #BFDBFE;background:#EFF6FF;color:#3B82F6;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit;';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', function(ev) {
          ev.stopPropagation();
          closeTemplateOverlay();
          setTimeout(function() {
            var els = getFreshTemplateFields();
            var tplData = tpl.data || {};
            var dataKeys = Object.keys(tplData).length;
            console.log('[Template] Load: found ' + els.length + ' fields on page, template has ' + dataKeys + ' saved fields.');
            var filled = 0;
            for (var i = 0; i < els.length; i++) {
              var el = els[i];
              var key = 'pos_' + i;
              var d = tplData[key];
              if (!d) continue;
              try {
                if (el.tagName === 'SELECT' && d.value != null) {
                  el.value = d.value;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  filled++;
                } else if (el.type === 'checkbox' && d.checked != null) {
                  if (el.checked !== d.checked) { el.click(); filled++; }
                } else if (el.type === 'radio' && d.checked) {
                  if (!el.checked) { el.click(); filled++; }
                } else if (d.value != null) {
                  el.value = d.value;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  filled++;
                }
              } catch (ef) {}
            }
            if (elStatus) elStatus.textContent = 'Template loaded: ' + filled + '/' + dataKeys + ' fields filled';
          }, 100);
        });

        // Delete button — hidden by default, shown on hover of row
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.style.cssText = 'flex-shrink:0;padding:3px 6px;border-radius:6px;border:1px solid #FECACA;background:#FEE2E2;color:#EF4444;cursor:pointer;font-size:10px;font-weight:600;line-height:1;font-family:inherit;display:none;';
        delBtn.textContent = 'Delete';
        delBtn.title = 'Delete template';
        delBtn.addEventListener('click', function(ev) {
          ev.stopPropagation();
          if (!confirm('Delete template "' + String(tpl.name || '') + '"?')) return;
          BRIDGE.pending = {
            action: 'section_template_delete',
            id: String(tpl.id || ''),
            sectionType: templateSectionType,
            t: Date.now(),
          };
          row.remove();
        });

        // Show/hide delete on hover
        row.addEventListener('mouseenter', function() { delBtn.style.display = 'block'; });
        row.addEventListener('mouseleave', function() { delBtn.style.display = 'none'; });

        // Drag events for reordering
        row.addEventListener('dragstart', function(ev) {
          dragIdx = idx;
          row.style.opacity = '0.4';
          ev.dataTransfer.effectAllowed = 'move';
          try { ev.dataTransfer.setData('text/plain', String(idx)); } catch(e){}
        });
        row.addEventListener('dragend', function() {
          row.style.opacity = '1';
          dragIdx = -1;
          // Remove all drag-over highlights
          for (var ri = 0; ri < rowEls.length; ri++) {
            rowEls[ri].style.borderTop = 'none';
            rowEls[ri].style.borderBottom = '1px solid #F1F5F9';
          }
        });
        row.addEventListener('dragover', function(ev) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          // Highlight drop position
          for (var ri = 0; ri < rowEls.length; ri++) {
            rowEls[ri].style.borderTop = 'none';
          }
          row.style.borderTop = '2px solid #3B82F6';
        });
        row.addEventListener('dragleave', function() {
          row.style.borderTop = 'none';
        });
        row.addEventListener('drop', function(ev) {
          ev.preventDefault();
          row.style.borderTop = 'none';
          if (dragIdx < 0 || dragIdx === idx) return;
          // Reorder templateList
          var moved = templateList.splice(dragIdx, 1)[0];
          var insertAt = dragIdx < idx ? idx - 1 : idx;
          templateList.splice(insertAt, 0, moved);
          renderTemplateList();
        });

        row.appendChild(handle);
        row.appendChild(info);
        row.appendChild(loadBtn);
        row.appendChild(delBtn);
        listDiv.appendChild(row);
        rowEls.push(row);
      })(tpls[ti], ti);
    }
  }

  function openTemplateOverlay(sectionType, sectionContainer, headingEl) {
    createTemplateOverlay();
    templateSectionType = sectionType;
    templateSectionEl = sectionContainer;
    templateHeadingEl = headingEl || null;
    templateOverlayOpen = true;
    var titleEl = TEMPLATE_OVERLAY.querySelector('#orbit-ksc-tpl-title');
    if (titleEl) titleEl.textContent = String(sectionType || 'Section') + ' Templates';
    // Request template list from backend
    BRIDGE.pending = {
      action: 'section_template_list',
      sectionType: sectionType,
      t: Date.now(),
    };
    templateList = [];
    renderTemplateList();
    TEMPLATE_OVERLAY.style.display = 'block';
  }

  function closeTemplateOverlay() {
    templateOverlayOpen = false;
    if (TEMPLATE_OVERLAY) TEMPLATE_OVERLAY.style.display = 'none';
  }

  /** Detect clickable section headings and add template triggers. */
  function parseBulkLearnText(raw) {
    var lines = String(raw || '').split('\\n');
    var result = [];
    // Regex: header lines like "Min A", "SBA", "Supervision", "Mod A", "Max A", "Dep", "CGA", "Indep"
    var headerRe = /^\s*(Min\s*A|Mod\s*A|Max\s*A|SBA|CGA|SUP|Supervision|Mod\s*I(?:ndep)?|Indep(?:endent)?|Dep(?:endent)?)\s*$/i;
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i]).trim();
      if (!line) continue;
      if (headerRe.test(line)) continue;
      // Strip leading numbering like "1.", "2)", "10."
      line = line.replace(/^\s*\d+[\.\)\-]\s*/, '').trim();
      if (line.length < 4) continue;
      if (line.length > 2000) line = line.slice(0, 2000);
      result.push(line);
    }
    return result;
  }

  function setupBulkInputCounter() {
    if (!ROOT) return;
    var bulkInput = ROOT.querySelector('#orbit-ksc-bulk-input');
    var bulkCount = ROOT.querySelector('#orbit-ksc-bulk-count');
    if (!bulkInput || !bulkCount) return;
    if (bulkInput._kscCounterBound) return;
    bulkInput._kscCounterBound = true;
    bulkInput.addEventListener('input', function() {
      var parsed = parseBulkLearnText(bulkInput.value);
      bulkCount.textContent = parsed.length + ' line' + (parsed.length === 1 ? '' : 's') + ' detected';
    });
  }

  function attachSectionHeadingListeners() {
    var SECTION_KEYWORDS = [
      { pattern: /training exercises/i, type: 'Training Exercises' },
      { pattern: /bed mobility training/i, type: 'Bed Mobility Training' },
      { pattern: /transfer training/i, type: 'Transfer Training' },
      { pattern: /gait training/i, type: 'Gait Training' },
      { pattern: /balance training/i, type: 'Balance Training' },
    ];
    var candidates = document.querySelectorAll('td, th, div, span, b, strong, h1, h2, h3, h4, h5, h6, legend, caption, label');
    for (var ci = 0; ci < candidates.length; ci++) {
      var el = candidates[ci];
      if (el._kscTplBound) continue;
      var txt = String(el.textContent || '').trim();
      if (txt.length > 60 || txt.length < 4) continue;
      for (var si = 0; si < SECTION_KEYWORDS.length; si++) {
        if (SECTION_KEYWORDS[si].pattern.test(txt)) {
          (function(sectionType, headingEl) {
            headingEl._kscTplBound = true;
            headingEl.style.cursor = 'pointer';
            headingEl.style.textDecoration = 'underline';
            headingEl.style.textDecorationStyle = 'dotted';
            headingEl.style.textDecorationColor = '#BFDBFE';
            headingEl.title = 'Click to open ' + sectionType + ' templates';
            headingEl.addEventListener('click', function(ev) {
              ev.stopPropagation();
              ev.preventDefault();
              var container = findSectionContainer(headingEl);
              if (!container) {
                var parent = headingEl.closest('table') || headingEl.closest('div');
                if (parent) container = parent;
              }
              if (container) openTemplateOverlay(sectionType, container, headingEl);
            });
          })(SECTION_KEYWORDS[si].type, el);
          break;
        }
      }
    }
  }

  function mountFloat() {
    if (document.getElementById('orbit-ksc-root')) return;
    var st = document.createElement('style');
    st.textContent = '#orbit-ksc-root{position:fixed;z-index:2147483646;display:none;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
      '#orbit-ksc-card{pointer-events:auto;resize:both;min-width:300px;min-height:200px;width:min(380px,calc(100vw - 20px));max-width:min(680px,calc(100vw - 16px));max-height:min(85vh,920px);overflow:auto;display:flex;flex-direction:column;' +
      'background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.04);}' +
      '.orbit-ksc-head{align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #E2E8F0;background:#F8FAFC;}' +
      '.orbit-ksc-title{font-size:11px;font-weight:700;color:#3B82F6;letter-spacing:.04em;text-transform:uppercase;}' +
      'button.orbit-ksc-x{margin:0;padding:4px 8px;border-radius:6px;border:1px solid #E2E8F0;background:#F1F5F9;' +
      'color:#64748B;font-size:14px;line-height:1;cursor:pointer;}' +
      'button.orbit-ksc-x:hover{background:#E2E8F0;color:#1E293B;}' +
      '.orbit-ksc-row{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px;border-bottom:1px solid #F1F5F9;}' +
      '.orbit-ksc-row:last-child{border-bottom:none;}' +
      'button.orbit-ksc-btn{margin:0;padding:8px 14px;border-radius:10px;border:1px solid #E2E8F0;background:#FFFFFF;' +
      'color:#475569;font-size:12px;font-weight:600;cursor:pointer;transition:all .12s;}' +
      'button.orbit-ksc-btn:hover{background:#EFF6FF;border-color:#BFDBFE;color:#3B82F6;}' +
      'button.orbit-ksc-prim{background:#EFF6FF;border-color:#BFDBFE;color:#3B82F6;}' +
      'button.orbit-ksc-prim:hover{background:#DBEAFE;}' +
      '#orbit-ksc-status{font-size:11px;color:#475569;padding:8px 14px;min-height:16px;background:#F8FAFC;border-top:1px solid #F1F5F9;}' +
      '#orbit-ksc-draftwrap{border-top:1px solid #E2E8F0;}' +
      '#orbit-ksc-draft{font-size:12px;color:#1E293B;padding:10px 14px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;line-height:1.5;}' +
      '.orbit-ksc-fieldtitle{font-size:13px;font-weight:700;color:#1E293B;margin-top:4px;line-height:1.35;word-break:break-word;}' +
      '.orbit-ksc-local{display:flex;flex-direction:column;gap:7px;padding:10px 14px;border-bottom:1px solid #F1F5F9;max-height:260px;overflow:auto;}' +
      '.orbit-ksc-sniprow{display:flex;flex-direction:row;gap:4px;align-items:stretch;width:100%;}' +
      'button.orbit-ksc-snip{font-size:11px;font-weight:500;text-align:left;justify-content:flex-start;flex:1;min-width:0;white-space:normal;line-height:1.3;padding:8px 10px;color:#334155;}' +
      'button.orbit-ksc-snip:hover{background:#EFF6FF;border-color:#BFDBFE;}' +
      'button.orbit-ksc-snippet-del,button.orbit-ksc-snippet-dup{margin:0;padding:4px 7px;border-radius:6px;border:1px solid #E2E8F0;background:#FFFFFF;cursor:pointer;flex-shrink:0;font-size:13px;line-height:1;color:#94A3B8;font-weight:700;}' +
      'button.orbit-ksc-snippet-del{color:#EF4444;}' +
      'button.orbit-ksc-snippet-del:hover{background:#FEE2E2;}' +
      'button.orbit-ksc-snippet-dup{color:#3B82F6;font-size:15px;}' +
      'button.orbit-ksc-snippet-dup:hover{background:#EFF6FF;}' +
      '#orbit-ksc-ai details summary{cursor:pointer;font-size:11px;color:#64748B;padding:6px 14px;font-weight:600;}' +
      '#orbit-ksc-hint{width:calc(100% - 20px);margin:4px 10px 10px;padding:8px 10px;border-radius:8px;border:1px solid #E2E8F0;background:#F8FAFC;color:#1E293B;font-size:11px;resize:vertical;min-height:32px;box-sizing:border-box;}' +
      '#orbit-ksc-hint:focus{border-color:#BFDBFE;outline:none;}' +
      '#orbit-ksc-hintlab{font-size:10px;color:#64748B;padding:4px 14px 0;line-height:1.3;}' +
      '#orbit-ksc-reopen{display:none;position:fixed;z-index:2147483645;bottom:14px;right:14px;pointer-events:auto;}' +
      '#orbit-ksc-reopen button{padding:8px 14px;border-radius:999px;border:1px solid #BFDBFE;background:#FFFFFF;' +
      'color:#3B82F6;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.08);}' +
      '#orbit-ksc-reopen button:hover{background:#EFF6FF;}' +
      '#orbit-ksc-suggest-chip{position:fixed;z-index:2147483647;display:none;pointer-events:none;align-items:flex-start;gap:4px;padding:6px 10px;border-radius:14px;' +
      'background:#FFFFFF;border:1px solid #E2E8F0;box-shadow:0 8px 30px rgba(0,0,0,.08);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:min(620px,calc(100vw - 16px));overflow:visible;flex-wrap:wrap;}' +
      '#orbit-ksc-suggest-chip button{pointer-events:auto;margin:0;font-family:inherit;}' +
      '#orbit-ksc-chip-insert{flex:1;min-width:160px;background:transparent;border:none;color:#334155;font-size:11px;font-weight:500;text-align:left;cursor:pointer;padding:2px 4px;' +
      'white-space:normal;word-break:break-word;line-height:1.25;max-height:min(36vh,320px);overflow:auto;display:block;}' +
      '#orbit-ksc-chip-input{display:none;pointer-events:auto;flex:1;min-width:220px;background:#F8FAFC;border:1px solid #E2E8F0;color:#1E293B;font-size:11px;border-radius:8px;padding:6px 8px;line-height:1.3;' +
      'min-height:3.2em;max-height:62vh;overflow:auto;resize:vertical;box-sizing:border-box;}' +
      '#orbit-ksc-chip-input:focus{border-color:#BFDBFE;outline:none;}' +
      '#orbit-ksc-chip-edit,#orbit-ksc-chip-save,#orbit-ksc-chip-rule,#orbit-ksc-chip-next,#orbit-ksc-chip-up,#orbit-ksc-chip-dn{flex-shrink:0;padding:3px 8px;border-radius:8px;border:1px solid #E2E8F0;background:#FFFFFF;color:#475569;cursor:pointer;font-size:11px;font-weight:600;line-height:1.2;}' +
      '#orbit-ksc-chip-edit:hover,#orbit-ksc-chip-rule:hover,#orbit-ksc-chip-next:hover{background:#EFF6FF;border-color:#BFDBFE;}' +
      '#orbit-ksc-chip-save{display:none;background:#ECFDF5;border-color:#A7F3D0;color:#059669;}' +
      '#orbit-ksc-chip-rule{color:#3B82F6;}' +
      '#orbit-ksc-chip-next{color:#3B82F6;}' +
      '#orbit-ksc-chip-up{color:#059669;}' +
      '#orbit-ksc-chip-up:hover{background:#ECFDF5;border-color:#A7F3D0;}' +
      '#orbit-ksc-chip-dn{color:#EF4444;}' +
      '#orbit-ksc-chip-dn:hover{background:#FEE2E2;border-color:#FECACA;}' +
      '#orbit-ksc-chip-x{flex-shrink:0;padding:2px 8px;border-radius:8px;border:1px solid #E2E8F0;background:#F1F5F9;color:#64748B;cursor:pointer;font-size:14px;line-height:1;font-weight:700;}' +
      '#orbit-ksc-chip-x:hover{background:#E2E8F0;}' +
      '#orbit-ksc-chip-rules{display:none;pointer-events:auto;width:100%;box-sizing:border-box;padding:6px 0 2px;margin-top:4px;border-top:1px solid #E2E8F0;flex-basis:100%;}' +
      '#orbit-ksc-chip-rules .ksc-rule-input-row{display:flex;gap:4px;align-items:flex-start;}' +
      '#orbit-ksc-chip-rules .ksc-rule-input{flex:1;background:#F8FAFC;border:1px solid #E2E8F0;color:#1E293B;font-size:11px;border-radius:6px;padding:5px 7px;line-height:1.3;min-height:1.8em;resize:none;box-sizing:border-box;font-family:inherit;}' +
      '#orbit-ksc-chip-rules .ksc-rule-input:focus{outline:none;border-color:#BFDBFE;}' +
      '#orbit-ksc-chip-rules .ksc-rule-input::placeholder{color:#64748b;}' +
      '#orbit-ksc-chip-rules .ksc-rule-save-btn{flex-shrink:0;padding:4px 10px;border-radius:8px;border:1px solid #A7F3D0;background:#ECFDF5;color:#059669;cursor:pointer;font-size:11px;font-weight:700;line-height:1.2;font-family:inherit;}' +
      '#orbit-ksc-chip-rules .ksc-rule-save-btn:hover{background:#166534;}' +
      '#orbit-ksc-chip-rules .ksc-rule-cancel-btn{flex-shrink:0;padding:4px 8px;border-radius:8px;border:1px solid #E2E8F0;background:#F1F5F9;color:#64748B;cursor:pointer;font-size:11px;font-weight:700;line-height:1.2;font-family:inherit;}' +
      '#orbit-ksc-chip-rules .ksc-rule-cancel-btn:hover{background:#E2E8F0;}' +
      '#orbit-ksc-chip-rules .ksc-rule-list{margin-top:5px;max-height:120px;overflow-y:auto;}' +
      '#orbit-ksc-chip-rules .ksc-rule-item{display:flex;align-items:center;gap:4px;padding:2px 0;font-size:10px;color:#94a3b8;line-height:1.3;}' +
      '#orbit-ksc-chip-rules .ksc-rule-item .ksc-rule-dot{flex-shrink:0;width:5px;height:5px;border-radius:50%;background:#3B82F6;}' +
      '#orbit-ksc-chip-rules .ksc-rule-item .ksc-rule-text{flex:1;word-break:break-word;}' +
      '#orbit-ksc-chip-rules .ksc-rule-item .ksc-rule-del{flex-shrink:0;background:none;border:none;color:#64748b;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;}' +
      '#orbit-ksc-chip-rules .ksc-rule-item .ksc-rule-del:hover{color:#f87171;}' +
      '#orbit-ksc-chip-rules .ksc-rule-hint{font-size:10px;color:#64748b;margin-top:3px;}' +
      '.orbit-ksc-chip-drag{flex-shrink:0;width:14px;min-height:28px;cursor:grab;border-radius:6px 0 0 6px;margin:-4px 2px -4px -6px;padding:4px 0;' +
      'background:#DBEAFE;color:#3B82F6;font-size:10px;line-height:1.1;font-weight:800;display:flex;align-items:center;justify-content:center;user-select:none;pointer-events:auto;writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:1px;}' +
      '.orbit-ksc-chip-drag:active{cursor:grabbing;background:#BFDBFE;}';
    document.documentElement.appendChild(st);

    REOPEN = document.createElement('div');
    REOPEN.id = 'orbit-ksc-reopen';
    REOPEN.innerHTML = '<button type="button" id="orbit-ksc-reopen-btn">Live Copilot</button>';
    document.documentElement.appendChild(REOPEN);
    REOPEN.querySelector('#orbit-ksc-reopen-btn').addEventListener('click', function() {
      try { if (currentFieldKey) delete dismissedKeys[currentFieldKey]; } catch (e) {}
      panelPinnedOpen = true;
      setPanelMinimized(false);
      if (lastSummaryEl) {
        try { lastSummaryEl.focus(); } catch (e0) {}
        if (ROOT) ROOT.style.display = 'block';
        showReopenChip(false);
        positionFloatStable();
        syncDraftChrome();
      }
    });

    ROOT = document.createElement('div');
    ROOT.id = 'orbit-ksc-root';
    ROOT.innerHTML = '<div id="orbit-ksc-card" class="orbit-ksc-card">' +
      '<div class="orbit-ksc-row orbit-ksc-head">' +
      '<div style="flex:1;min-width:0">' +
      '<div class="orbit-ksc-title">Orbit Agent</div>' +
      '<div style="font-size:10px;font-weight:700;color:#64748B;letter-spacing:.02em;margin:2px 0 0">AI-powered clinical documentation assistant</div>' +
      '<div id="orbit-ksc-fieldtitle" class="orbit-ksc-fieldtitle">—</div>' +
      '</div>' +
      '<button type="button" class="orbit-ksc-x" data-ksc="min" title="Minimize">−</button>' +
      '<button type="button" class="orbit-ksc-x" data-ksc="theme" title="Toggle dark/light">☀</button>' +
      '<button type="button" class="orbit-ksc-x" data-ksc="close" title="Dismiss for this field">✕</button>' +
      '</div>' +
      '<div class="orbit-ksc-row">' +
      '<button type="button" class="orbit-ksc-btn orbit-ksc-prim" data-ksc="learn" title="Save current chart text for this field">Learn</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="sugg" title="One smart line from the whole note + your saved style (not verbatim)">Suggest</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="bulk_learn" title="Paste multiple lines to learn at once" style="color:#a78bfa;">Bulk</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="panel_rule" title="Add rules for this field" style="color:#a78bfa;">Rule</button>' +
      '</div>' +
      '<div id="orbit-ksc-panel-rules" style="display:none;padding:10px 14px;border-bottom:1px solid #F1F5F9;"></div>' +
      '<div id="orbit-ksc-bulk-panel" style="display:none;padding:10px 14px;border-bottom:1px solid #F1F5F9;">' +
      '<div style="font-size:11px;color:#64748B;margin-bottom:6px;">Paste multiple lines below. Numbered items and headers (e.g. "Min A", "SBA") are parsed automatically.</div>' +
      '<textarea id="orbit-ksc-bulk-input" style="width:100%;min-height:120px;max-height:40vh;background:#F8FAFC;border:1px solid #E2E8F0;color:#1E293B;font-size:11px;border-radius:8px;padding:8px;line-height:1.35;resize:vertical;box-sizing:border-box;font-family:inherit;" placeholder="1. Walking, transfers, standing&#10;2. Ambulation, weight bearing, stair climbing&#10;..."></textarea>' +
      '<div style="display:flex;gap:6px;margin-top:6px;align-items:center;">' +
      '<button type="button" class="orbit-ksc-btn orbit-ksc-prim" data-ksc="bulk_save" style="flex-shrink:0;">Save all</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="bulk_cancel" style="flex-shrink:0;">Cancel</button>' +
      '<span id="orbit-ksc-bulk-count" style="font-size:10px;color:#64748b;flex:1;text-align:right;">0 lines detected</span>' +
      '</div>' +
      '</div>' +
      '<details id="orbit-ksc-saved" open style="border-bottom:1px solid #F1F5F9;">' +
      '<summary style="cursor:pointer;font-size:11px;color:#94a3b8;padding:7px 14px;list-style:none;">Saved examples</summary>' +
      '<div class="orbit-ksc-row" style="display:none;">' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="listmv" title="Show saved examples for this field">Refresh list</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="clr" title="Remove saved lines for this field" style="display:none;">Clear all</button>' +
      '</div>' +
      '<div id="orbit-ksc-local" class="orbit-ksc-local"></div>' +
      '</details>' +
      '<div id="orbit-ksc-status"></div>' +
      '<div id="orbit-ksc-draftwrap"><div id="orbit-ksc-draft"></div><textarea id="orbit-ksc-draft-editor" style="display:none;width:calc(100% - 16px);margin:8px;border:1px solid #E2E8F0;border-radius:8px;background:#F8FAFC;color:#1E293B;font-size:12px;line-height:1.35;min-height:130px;resize:vertical;box-sizing:border-box;padding:8px;"></textarea></div>' +
      '<div class="orbit-ksc-row">' +
      '<button type="button" class="orbit-ksc-btn orbit-ksc-prim" data-ksc="ins">Insert</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="undo" title="Undo last auto-replace">Undo</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="cpy">Copy</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="edit" title="Load suggestion into editor">Edit response</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="edit_save" style="display:none">Save edit</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="edit_cancel" style="display:none">Cancel</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="up" title="Appropriate response">Appropriate</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="dn" title="Incorrect response">Incorrect</button>' +
      '</div>' +
      '<div id="orbit-ksc-ai"><details><summary>AI draft (optional)</summary>' +
      '<div class="orbit-ksc-row">' +
      '<button type="button" class="orbit-ksc-btn orbit-ksc-prim" data-ksc="gen">Generate</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="regen" title="Regenerate">↻</button>' +
      '<button type="button" class="orbit-ksc-btn" data-ksc="imp" title="Improve">Improve</button>' +
      '</div>' +
      '<div id="orbit-ksc-teach">' +
      '<div id="orbit-ksc-hintlab" class="orbit-ksc-hintlab">Style notes — saved with Improve or 👍</div>' +
      '<textarea id="orbit-ksc-hint" class="orbit-ksc-hint" placeholder="e.g. B=bilateral; short sentences."></textarea>' +
      '</div></details></div>' +
      '<div id="orbit-ksc-chat"><details><summary style="cursor:pointer;font-size:11px;color:#3B82F6;padding:7px 14px;list-style:none;font-weight:700;">Agent Chat</summary>' +
      '<div id="orbit-ksc-chat-log" style="max-height:220px;overflow-y:auto;padding:6px 12px;font-size:11px;line-height:1.4;"></div>' +
      '<div style="display:flex;gap:4px;padding:6px 12px 10px;">' +
      '<textarea id="orbit-ksc-chat-input" rows="1" placeholder="e.g. Fill out my entire note" style="flex:1;background:#F8FAFC;border:1px solid #E2E8F0;color:#1E293B;font-size:11px;border-radius:8px;padding:6px 8px;line-height:1.3;resize:none;box-sizing:border-box;font-family:inherit;min-height:1.8em;max-height:80px;"></textarea>' +
      '<button type="button" class="orbit-ksc-btn orbit-ksc-prim" data-ksc="chat_send" style="flex-shrink:0;padding:6px 12px;">Send</button>' +
      '</div>' +
      '</details></div>' +
      '</div>';
    document.documentElement.appendChild(ROOT);
    var headerEl = ROOT.querySelector('.orbit-ksc-head');
    if (headerEl) {
      headerEl.style.cursor = 'move';
      headerEl.addEventListener('mousedown', function(ev) {
        if (ev.button !== 0) return;
        var t = ev.target;
        if (t && t.closest && t.closest('button')) return;
        if (!ROOT) return;
        ev.preventDefault();
        ev.stopPropagation();
        var r0 = ROOT.getBoundingClientRect();
        panelDragState = { startX: ev.clientX, startY: ev.clientY, origLeft: r0.left, origTop: r0.top };
        document.addEventListener('mousemove', onPanelDragMove, true);
        document.addEventListener('mouseup', onPanelDragUp, true);
      }, true);
    }
    SUGGEST_CHIP = document.createElement('div');
    SUGGEST_CHIP.id = 'orbit-ksc-suggest-chip';
    SUGGEST_CHIP.style.display = 'none';
    SUGGEST_CHIP.innerHTML = '<span class="orbit-ksc-chip-drag" id="orbit-ksc-chip-drag" title="Drag to move · double-click to snap back under field">⋮</span>' +
      '<button type="button" id="orbit-ksc-chip-insert" class="orbit-ksc-chip-insert">…</button>' +
      '<textarea id="orbit-ksc-chip-input" class="orbit-ksc-chip-input" rows="3"></textarea>' +
      '<button type="button" id="orbit-ksc-chip-edit" class="orbit-ksc-chip-edit" title="Edit response">Edit</button>' +
      '<button type="button" id="orbit-ksc-chip-save" class="orbit-ksc-chip-save" title="Save edited response">Save</button>' +
      '<button type="button" id="orbit-ksc-chip-rule" class="orbit-ksc-chip-rule" title="Add rule for this field">Rule</button>' +
      '<button type="button" id="orbit-ksc-chip-next" class="orbit-ksc-chip-next" title="Get next suggestion">Next</button>' +
      '<button type="button" id="orbit-ksc-chip-up" class="orbit-ksc-chip-up" title="Appropriate response">👍</button>' +
      '<button type="button" id="orbit-ksc-chip-dn" class="orbit-ksc-chip-dn" title="Incorrect response">👎</button>' +
      '<button type="button" id="orbit-ksc-chip-x" class="orbit-ksc-chip-x" title="Dismiss">×</button>' +
      '<div id="orbit-ksc-chip-rules" class="orbit-ksc-chip-rules"></div>';
    document.documentElement.appendChild(SUGGEST_CHIP);
    try {
      var rawM = localStorage.getItem('orbit_ksc_chip_manual');
      if (rawM) {
        var pm = JSON.parse(rawM);
        if (pm && typeof pm.left === 'number' && typeof pm.top === 'number') chipManualPos = pm;
      }
    } catch (eM) {}
    elChipBtn = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-insert');
    elChipInput = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-input');
    elChipEdit = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-edit');
    elChipSave = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-save');
    elChipRule = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-rule');
    elChipNext = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-next');
    elChipUp = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-up');
    elChipDn = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-dn');
    elChipX = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-x');
    elChipRulesPanel = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-rules');
    var elChipDrag = SUGGEST_CHIP.querySelector('#orbit-ksc-chip-drag');
    function startChipDragFromEvent(ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!SUGGEST_CHIP) return;
      var r0 = SUGGEST_CHIP.getBoundingClientRect();
      chipDragState = { startX: ev.clientX, startY: ev.clientY, origLeft: r0.left, origTop: r0.top };
      document.addEventListener('mousemove', onChipDragMove, true);
      document.addEventListener('mouseup', onChipDragUp, true);
    }
    if (elChipDrag) {
      elChipDrag.addEventListener('mousedown', startChipDragFromEvent, true);
      elChipDrag.addEventListener('dblclick', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        resetSuggestChipAnchor();
      });
    }
    SUGGEST_CHIP.addEventListener('mousedown', function(ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('button') || t.closest('textarea') || t.closest('#orbit-ksc-chip-rules')) return;
      startChipDragFromEvent(ev);
    }, true);
    /** Keep focus on the chart textarea so focusout does not hide the chip before click inserts (see onDocFocusOut). */
    function chipMouseDownKeepChartFocus(ev) {
      try {
        ev.preventDefault();
      } catch (e0) {}
    }
    elChipBtn.addEventListener('mousedown', chipMouseDownKeepChartFocus, true);
    if (elChipRule) elChipRule.addEventListener('mousedown', chipMouseDownKeepChartFocus, true);
    if (elChipNext) elChipNext.addEventListener('mousedown', chipMouseDownKeepChartFocus, true);
    if (elChipUp) elChipUp.addEventListener('mousedown', chipMouseDownKeepChartFocus, true);
    if (elChipDn) elChipDn.addEventListener('mousedown', chipMouseDownKeepChartFocus, true);
    elChipX.addEventListener('mousedown', chipMouseDownKeepChartFocus, true);
    elChipBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var t = BRIDGE.suggestChipFullText || '';
      if (!t) return;
      var r = replaceActiveValueInternal(t);
      if (elStatus) elStatus.textContent = r.ok ? 'Replaced field with suggestion' : ('Replace failed: ' + (r.error || ''));
      if (r.ok) hideSuggestChip();
    });
    elChipX.addEventListener('click', function(ev) {
      ev.stopPropagation();
      hideSuggestChip();
    });
    if (elChipEdit) {
      elChipEdit.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (!elChipInput || !elChipBtn || !elChipSave) return;
        var base = String(BRIDGE.suggestChipFullText || '').trim();
        if (!base) return;
        chipEditing = true;
        elChipInput.value = base;
        elChipBtn.style.display = 'none';
        elChipInput.style.display = 'block';
        elChipSave.style.display = 'inline-block';
        resizeChipEditorToContent();
        try { elChipInput.focus(); elChipInput.select(); } catch (e0) {}
        if (elStatus) elStatus.textContent = 'Editing suggestion...';
      });
    }
    if (elChipNext) {
      elChipNext.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var fp = String(BRIDGE.lastFieldPurpose || '').trim();
        if (!fp) {
          if (elStatus) elStatus.textContent = 'Click a chart field first';
          return;
        }
        BRIDGE.pending = {
          action: 'suggest_next',
          fieldPurpose: fp,
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Getting next suggestion…';
      });
    }
    if (elChipRule) {
      elChipRule.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (chipRulesOpen) {
          closeRulesPanel();
          return;
        }
        chipRulesOpen = true;
        renderChipRulesPanel();
        if (elChipRulesPanel) elChipRulesPanel.style.display = 'block';
        positionSuggestChip();
      });
    }
    if (elChipSave) {
      elChipSave.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (!elChipInput || !elChipBtn) return;
        var nextText = String((elChipInput.value || '')).trim();
        if (!nextText) {
          if (elStatus) elStatus.textContent = 'Edited suggestion is empty';
          return;
        }
        BRIDGE.suggestChipFullText = nextText;
        BRIDGE.lastDraft = nextText;
        elChipBtn.textContent = nextText;
        elChipBtn.title = nextText;
        elChipInput.style.display = 'none';
        elChipBtn.style.display = 'block';
        elChipSave.style.display = 'none';
        chipEditing = false;
        if (nextText.length >= 6) {
          BRIDGE.pending = {
            action: 'learn_field_text',
            text: nextText.slice(0, 2000),
            fieldPurpose: BRIDGE.lastFieldPurpose || '',
            fieldKey: currentFieldKey || '',
            t: Date.now(),
          };
          if (elStatus) elStatus.textContent = 'Suggestion saved + learning style...';
        } else if (elStatus) {
          elStatus.textContent = 'Suggestion updated';
        }
      });
    }
    if (elChipInput) {
      elChipInput.addEventListener('input', function() {
        resizeChipEditorToContent();
      });
      elChipInput.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          ev.stopPropagation();
          if (elChipSave) elChipSave.click();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          chipEditing = false;
          elChipInput.style.display = 'none';
          if (elChipBtn) elChipBtn.style.display = 'block';
          if (elChipSave) elChipSave.style.display = 'none';
        }
      });
    }
    if (elChipUp) {
      elChipUp.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var msg = String(BRIDGE.suggestChipFullText || '').trim();
        if (!msg) return;
        BRIDGE.pending = {
          action: 'feedback',
          kind: 'thumbs_up',
          text: msg.slice(0, 1800),
          fingerprint: BRIDGE.fingerprint,
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Marked as appropriate';
        var oldUp = elChipUp.textContent;
        elChipUp.textContent = '✓';
        setTimeout(function() {
          try { if (elChipUp) elChipUp.textContent = oldUp || '👍'; } catch (e0) {}
        }, 700);
      });
    }
    if (elChipDn) {
      elChipDn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var bad = String(BRIDGE.suggestChipFullText || '').trim();
        if (!bad) return;
        BRIDGE.pending = {
          action: 'feedback',
          kind: 'thumbs_down',
          text: bad.slice(0, 1800),
          fingerprint: BRIDGE.fingerprint,
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          rejectedText: bad.slice(0, 1800),
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Marked as incorrect';
        var oldDn = elChipDn.textContent;
        elChipDn.textContent = '✓';
        setTimeout(function() {
          try { if (elChipDn) elChipDn.textContent = oldDn || '👎'; } catch (e0) {}
        }, 700);
      });
    }
    try {
      var rawTheme = localStorage.getItem('orbit_ksc_panel_theme');
      if (rawTheme === 'light' || rawTheme === 'dark') panelTheme = rawTheme;
    } catch (eTheme) {}
    elCard = ROOT.querySelector('#orbit-ksc-card');
    applyPanelTheme();
    elStatus = ROOT.querySelector('#orbit-ksc-status');
    elDraft = ROOT.querySelector('#orbit-ksc-draft');
    elDraftEditor = ROOT.querySelector('#orbit-ksc-draft-editor');
    elDraftWrap = ROOT.querySelector('#orbit-ksc-draftwrap');
    elHint = ROOT.querySelector('#orbit-ksc-hint');
    elFieldTitle = ROOT.querySelector('#orbit-ksc-fieldtitle');
    elLocalSnips = ROOT.querySelector('#orbit-ksc-local');
    renderSnipButtons([]);

    ROOT.addEventListener('click', function(ev) {
      var delB = ev.target && ev.target.closest && ev.target.closest('[data-del-idx]');
      if (delB) {
        ev.preventDefault();
        ev.stopPropagation();
        var di = parseInt(delB.getAttribute('data-del-idx') || '-1', 10);
        var arDel = BRIDGE.snipList || [];
        if (arDel[di] != null) {
          BRIDGE.pending = {
            action: 'delete_snippet',
            text: arDel[di],
            fieldPurpose: BRIDGE.lastFieldPurpose || '',
            fieldKey: currentFieldKey || '',
            t: Date.now(),
          };
          if (elStatus) elStatus.textContent = 'Deleting…';
        }
        return;
      }
      var dupB = ev.target && ev.target.closest && ev.target.closest('[data-dup-idx]');
      if (dupB) {
        ev.preventDefault();
        ev.stopPropagation();
        var ui = parseInt(dupB.getAttribute('data-dup-idx') || '-1', 10);
        var arDup = BRIDGE.snipList || [];
        if (arDup[ui] != null) {
          BRIDGE.pending = {
            action: 'duplicate_snippet',
            text: arDup[ui],
            fieldPurpose: BRIDGE.lastFieldPurpose || '',
            fieldKey: currentFieldKey || '',
            t: Date.now(),
          };
          if (elStatus) elStatus.textContent = 'Duplicating…';
        }
        return;
      }
      var sn = ev.target && ev.target.closest && ev.target.closest('button.orbit-ksc-snip');
      if (sn) {
        var ix = parseInt(sn.getAttribute('data-idx') || '-1', 10);
        var arr = BRIDGE.snipList || [];
        var full = arr[ix];
        if (full) {
          var ins = full;
          if (!ins.length || ins.charCodeAt(ins.length - 1) !== 10) ins = ins + String.fromCharCode(10);
          var r = insertAtCursorInternal(ins);
          if (elStatus) elStatus.textContent = r.ok ? 'Inserted saved line' : ('Insert failed: ' + (r.error || ''));
        }
        return;
      }
      var btn = ev.target && ev.target.closest && ev.target.closest('[data-ksc]');
      if (!btn) return;
      var act = btn.getAttribute('data-ksc');
      if (act === 'min') {
        panelPinnedOpen = false;
        setPanelMinimized(true, true);
        if (elStatus) elStatus.textContent = 'Minimized — suggestion pill stays available';
        return;
      }
      if (act === 'close') {
        panelPinnedOpen = false;
        if (currentFieldKey) dismissedKeys[currentFieldKey] = true;
        hideMainPanel();
        if (lastSummaryEl && document.activeElement === lastSummaryEl) showReopenChip(true);
        return;
      }
      if (act === 'theme') {
        togglePanelTheme();
        return;
      }
      if (act === 'learn') {
        var txtL = lastSummaryEl ? String(lastSummaryEl.value || '').trim() : '';
        if (txtL.length < 6) {
          if (elStatus) elStatus.textContent = 'Type a few words in the chart, then Learn';
          return;
        }
        BRIDGE.pending = {
          action: 'learn_field_text',
          text: txtL.slice(0, 2000),
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Saving…';
      } else if (act === 'sugg') {
        BRIDGE.pending = {
          action: 'suggest_contextual',
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Thinking…';
      } else if (act === 'listmv') {
        BRIDGE.pending = {
          action: 'list_saved_phrases',
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Loading saved…';
      } else if (act === 'clr') {
        BRIDGE.pending = {
          action: 'clear_field_memory',
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Clearing…';
      } else if (act === 'bulk_learn') {
        var panelRulesDiv = ROOT.querySelector('#orbit-ksc-panel-rules');
        if (panelRulesDiv) panelRulesDiv.style.display = 'none';
        var bulkPanel = ROOT.querySelector('#orbit-ksc-bulk-panel');
        if (bulkPanel) {
          var isOpen = bulkPanel.style.display !== 'none';
          bulkPanel.style.display = isOpen ? 'none' : 'block';
          if (!isOpen) {
            var bulkInput = ROOT.querySelector('#orbit-ksc-bulk-input');
            if (bulkInput) { bulkInput.value = ''; bulkInput.focus(); }
            var bulkCount = ROOT.querySelector('#orbit-ksc-bulk-count');
            if (bulkCount) bulkCount.textContent = '0 lines detected';
          }
        }
      } else if (act === 'bulk_cancel') {
        var bulkPanel2 = ROOT.querySelector('#orbit-ksc-bulk-panel');
        if (bulkPanel2) bulkPanel2.style.display = 'none';
      } else if (act === 'panel_rule') {
        var prDiv = ROOT.querySelector('#orbit-ksc-panel-rules');
        var bkDiv = ROOT.querySelector('#orbit-ksc-bulk-panel');
        if (bkDiv) bkDiv.style.display = 'none';
        if (prDiv) {
          var prOpen = prDiv.style.display !== 'none';
          if (prOpen) {
            prDiv.style.display = 'none';
          } else {
            prDiv.style.display = 'block';
            renderPanelRulesSection(prDiv);
          }
        }
      } else if (act === 'bulk_save') {
        var bulkInput2 = ROOT.querySelector('#orbit-ksc-bulk-input');
        var raw = String(bulkInput2 ? bulkInput2.value : '').trim();
        if (!raw) { if (elStatus) elStatus.textContent = 'Paste text first'; return; }
        var parsed = parseBulkLearnText(raw);
        if (!parsed.length) { if (elStatus) elStatus.textContent = 'No valid lines found'; return; }
        BRIDGE.pending = {
          action: 'bulk_learn_field_text',
          lines: parsed,
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
        if (elStatus) elStatus.textContent = 'Saving ' + parsed.length + ' lines…';
        var bulkPanel3 = ROOT.querySelector('#orbit-ksc-bulk-panel');
        if (bulkPanel3) bulkPanel3.style.display = 'none';
        if (bulkInput2) bulkInput2.value = '';
      } else if (act === 'gen') {
        BRIDGE.pending = {
          action: 'draft',
          mode: 'generate',
          improveHint: (elHint && elHint.value) ? String(elHint.value).trim().slice(0, 900) : '',
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
      } else if (act === 'regen') {
        BRIDGE.pending = { action: 'draft', mode: 'regenerate', improveHint: (elHint && elHint.value) ? String(elHint.value).trim().slice(0, 900) : '', fieldPurpose: BRIDGE.lastFieldPurpose || '', fieldKey: currentFieldKey || '', t: Date.now() };
      } else if (act === 'imp') {
        BRIDGE.pending = { action: 'draft', mode: 'improve', improveHint: (elHint && elHint.value) || '', fieldPurpose: BRIDGE.lastFieldPurpose || '', fieldKey: currentFieldKey || '', t: Date.now() };
      } else if (act === 'chat_send') {
        var chatInput = ROOT.querySelector('#orbit-ksc-chat-input');
        var msg = String(chatInput ? chatInput.value : '').trim();
        if (!msg) return;
        if (chatInput) chatInput.value = '';
        appendChatMsg('user', msg);

        // ── Direct command handler — bypass AI for simple checkbox/select operations ──
        var msgLow = msg.toLowerCase().trim();
        var directHandled = false;

        // Check/uncheck checkbox commands
        // Detect: "check X", "check the box X", "check the box for X", "X check", "X confirm"
        var msgWords = msgLow.split(' ').filter(function(w) { return w.length > 0; });
        var checkVerbs = ['check', 'tick', 'mark', 'enable', 'confirm', 'select'];
        var uncheckVerbs = ['uncheck', 'untick', 'unmark', 'disable', 'deselect', 'clear'];
        var isCheckCmd = false;
        var isUncheckCmd = false;
        var cbSearchTerms = '';

        // Check if first word is a check/uncheck verb
        if (msgWords.length > 1 && checkVerbs.indexOf(msgWords[0]) >= 0) {
          isCheckCmd = true;
          cbSearchTerms = msgWords.slice(1).join(' ');
        } else if (msgWords.length > 1 && uncheckVerbs.indexOf(msgWords[0]) >= 0) {
          isUncheckCmd = true;
          cbSearchTerms = msgWords.slice(1).join(' ');
        }
        // Check if last word is a check verb (e.g. "patient identity confirm")
        if (!isCheckCmd && !isUncheckCmd && msgWords.length > 1) {
          var lastWord = msgWords[msgWords.length - 1];
          if (checkVerbs.indexOf(lastWord) >= 0) {
            isCheckCmd = true;
            cbSearchTerms = msgWords.slice(0, -1).join(' ');
          }
        }
        // Also detect "check the box ..." pattern
        if (isCheckCmd || isUncheckCmd) {
          cbSearchTerms = cbSearchTerms.replace(/^the /, '').replace(/^box /, '').replace(/^for /, '').trim();
        }

        if ((isCheckCmd || isUncheckCmd) && cbSearchTerms.length > 1) {
          var wantCheck = isCheckCmd;
          var searchLabel = cbSearchTerms;
          // Strip filler words
          searchLabel = searchLabel.replace(/^the /, '').replace(/^radio /, '').replace(/^box /, '').replace(/^button /, '').replace(/ for /g, ' ').trim();
          // Expand common abbreviations (word-level replacement)
          var expandWords = searchLabel.split(' ');
          for (var ew = 0; ew < expandWords.length; ew++) {
            var w = expandWords[ew];
            if (w === 'pt') expandWords[ew] = 'patient';
            else if (w === 'id') expandWords[ew] = 'identity';
            else if (w === 'confirm') expandWords[ew] = 'confirmed';
            else if (w === 'ident') expandWords[ew] = 'identity';
            else if (w === 'hb') expandWords[ew] = 'homebound';
            else if (w === 'dx') expandWords[ew] = 'diagnosis';
            else if (w === 'eval') expandWords[ew] = 'evaluation';
          }
          var expandedSearch = expandWords.join(' ');

          // Helper: score an element against search terms
          function scoreElement(el) {
            var elLabel = (labelFor(el) || '').toLowerCase();
            var elId = (el.id || '').toLowerCase().replace(/_/g, '');
            var elName = (el.name || '').toLowerCase().replace(/_/g, '');
            var elParent = el.parentElement ? (el.parentElement.textContent || '').toLowerCase().trim() : '';
            var elVal = (el.value || '').toLowerCase();
            var elBlob = elLabel + ' ' + elId + ' ' + elName + ' ' + elParent + ' ' + elVal;
            var score = 0;
            var searches = [searchLabel, expandedSearch];
            for (var si2 = 0; si2 < searches.length; si2++) {
              var s = searches[si2];
              var sNoSpaces = s.split(' ').join('');
              if (elLabel === s) score = Math.max(score, 100);
              else if (elLabel.indexOf(s) >= 0) score = Math.max(score, 85);
              if (elId.indexOf(sNoSpaces) >= 0) score = Math.max(score, 90);
              if (elName.indexOf(sNoSpaces) >= 0) score = Math.max(score, 90);
              if (s.indexOf(elLabel) >= 0 && elLabel.length > 3) score = Math.max(score, 70);
              if (elParent.indexOf(s) >= 0) score = Math.max(score, 60);
              var words = s.split(' ');
              var matched = 0;
              for (var wi = 0; wi < words.length; wi++) {
                if (words[wi].length > 2 && elBlob.indexOf(words[wi]) >= 0) matched++;
              }
              if (matched > 0) score = Math.max(score, 20 + matched * 15);
            }
            return score;
          }

          // Search checkboxes AND radio buttons
          var allCheckable = document.querySelectorAll('input[type="checkbox"], input[type="radio"]');
          var bestCb = null;
          var bestScore = 0;
          for (var cbi = 0; cbi < allCheckable.length; cbi++) {
            var cb = allCheckable[cbi];
            if (!visible(cb)) continue;
            var score = scoreElement(cb);
            if (score > bestScore) { bestScore = score; bestCb = cb; }
          }
          if (bestCb && bestScore >= 20) {
            if (bestCb.type === 'radio') {
              if (!bestCb.checked) bestCb.click();
            } else {
              if (bestCb.checked !== wantCheck) bestCb.click();
            }
            var cbLbl = labelFor(bestCb) || bestCb.id || bestCb.type;
            var cbVal = bestCb.type === 'radio' ? ' (' + (bestCb.value || '') + ')' : '';
            appendChatMsg('agent', (wantCheck ? 'Checked' : 'Unchecked') + ': ' + cbLbl + cbVal);
            directHandled = true;
          } else {
            appendChatMsg('agent', 'Could not find checkbox or radio button matching "' + searchLabel + '".');
            directHandled = true;
          }
        }

        // Select dropdown commands: "set X to Y", "change X to Y", "select X Y", "X: Y"
        if (!directHandled) {
          var fieldSearch = '';
          var valueSearch = '';
          var toIdx = msgLow.indexOf(' to ');
          if (toIdx > 0 && (msgLow.indexOf('set ') === 0 || msgLow.indexOf('change ') === 0 || msgLow.indexOf('pick ') === 0 || msgLow.indexOf('choose ') === 0)) {
            var verbEnd = msgLow.indexOf(' ');
            fieldSearch = msgLow.slice(verbEnd + 1, toIdx).trim();
            valueSearch = msgLow.slice(toIdx + 4).trim();
          }
          // "select X Y" pattern (e.g., "select pain location other")
          if (!fieldSearch && msgLow.indexOf('select ') === 0) {
            var selParts = msgLow.slice(7).trim();
            // Try to find which part is the field and which is the value by checking against all selects
            var allSelsCheck = document.querySelectorAll('select');
            var bestSplit = null;
            var bestSplitScore = 0;
            for (var sp = selParts.length - 1; sp > 0; sp--) {
              if (selParts[sp] !== ' ') continue;
              var fPart = selParts.slice(0, sp).trim();
              var vPart = selParts.slice(sp + 1).trim();
              if (!fPart || !vPart) continue;
              for (var sck = 0; sck < allSelsCheck.length; sck++) {
                var scLabel = (labelFor(allSelsCheck[sck]) || '').toLowerCase();
                var scParent = allSelsCheck[sck].parentElement ? (allSelsCheck[sck].parentElement.textContent || '').toLowerCase() : '';
                if (scLabel.indexOf(fPart) >= 0 || scParent.indexOf(fPart) >= 0) {
                  var spScore = fPart.length;
                  if (spScore > bestSplitScore) { bestSplitScore = spScore; bestSplit = { f: fPart, v: vPart }; }
                }
              }
            }
            if (bestSplit) { fieldSearch = bestSplit.f; valueSearch = bestSplit.v; }
          }
          // "X: Y" colon pattern (e.g., "pre-therapy: 2", "position: sitting")
          if (!fieldSearch) {
            var colonIdx = msgLow.indexOf(':');
            if (colonIdx > 0 && colonIdx < msgLow.length - 1) {
              fieldSearch = msgLow.slice(0, colonIdx).trim();
              valueSearch = msgLow.slice(colonIdx + 1).trim();
              // Strip leading "fill" or "set"
              fieldSearch = fieldSearch.replace(/^(fill|set|change|pick|choose)\s+/i, '');
            }
          }
          if (fieldSearch && valueSearch) {
            var allSels = document.querySelectorAll('select');
            var bestSel = null;
            var bestSelScore = 0;
            for (var sli = 0; sli < allSels.length; sli++) {
              var sel = allSels[sli];
              if (!visible(sel)) continue;
              var selLabel = (labelFor(sel) || '').toLowerCase();
              var selParent = sel.parentElement ? (sel.parentElement.textContent || '').toLowerCase() : '';
              var selId = (sel.id || '').toLowerCase().replace(/_/g, ' ');
              var score3 = 0;
              if (selLabel.indexOf(fieldSearch) >= 0) score3 = 80;
              else if (fieldSearch.indexOf(selLabel) >= 0 && selLabel.length > 3) score3 = 60;
              if (selParent.indexOf(fieldSearch) >= 0 && score3 < 50) score3 = 50;
              if (selId.indexOf(fieldSearch.replace(/[- ]/g, '')) >= 0 && score3 < 70) score3 = 70;
              if (score3 > bestSelScore) { bestSelScore = score3; bestSel = sel; }
            }
            if (bestSel && bestSelScore >= 40) {
              var opts = bestSel.options;
              var matched3 = false;
              for (var oi = 0; oi < opts.length; oi++) {
                if (opts[oi].text.toLowerCase().indexOf(valueSearch) >= 0 || opts[oi].value.toLowerCase().indexOf(valueSearch) >= 0) {
                  bestSel.value = opts[oi].value;
                  bestSel.dispatchEvent(new Event('change', { bubbles: true }));
                  appendChatMsg('agent', 'Set ' + (labelFor(bestSel) || 'dropdown') + ' to: ' + opts[oi].text);
                  matched3 = true;
                  directHandled = true;
                  break;
                }
              }
              if (!matched3) {
                appendChatMsg('agent', 'Could not find option "' + valueSearch + '" in ' + (labelFor(bestSel) || 'dropdown'));
                directHandled = true;
              }
            }
          }
        }

        if (directHandled) return;

        // ── Fall through to AI for complex commands ──
        appendChatMsg('agent', 'Working...');
        BRIDGE.pending = {
          action: 'agent_chat',
          message: msg,
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
      } else if (act === 'ins') {
        var d = BRIDGE.lastDraft || '';
        if (!d) { elStatus.textContent = 'No draft yet'; return; }
        var ins = d;
        if (!d.length || d.charCodeAt(d.length - 1) !== 10) ins = d + String.fromCharCode(10);
        var r = insertAtCursorInternal(ins);
        BRIDGE.pending = { action: 'insert_result', ok: !!r.ok, fingerprint: BRIDGE.fingerprint, t: Date.now() };
        elStatus.textContent = r.ok ? 'Inserted' : ('Insert failed: ' + (r.error || ''));
      } else if (act === 'undo') {
        BRIDGE.pending = { action: 'undo_auto_replace', t: Date.now() };
        if (elStatus) elStatus.textContent = 'Undoing…';
      } else if (act === 'cpy') {
        var t = BRIDGE.lastDraft || '';
        if (!t) return;
        BRIDGE.pending = { action: 'clipboard_copy', text: t, fingerprint: BRIDGE.fingerprint, t: Date.now() };
      } else if (act === 'edit') {
        var ss = String(BRIDGE.suggestChipFullText || BRIDGE.lastDraft || (elDraft ? elDraft.textContent : '') || '').trim();
        if (!ss) {
          if (elStatus) elStatus.textContent = 'No suggestion/draft to edit';
          return;
        }
        BRIDGE.lastDraft = ss;
        if (elDraftEditor) elDraftEditor.value = ss;
        syncDraftChrome();
        setDraftEditMode(true);
        if (elDraftEditor) {
          try { elDraftEditor.focus(); } catch (e0) {}
        }
        if (elStatus) elStatus.textContent = 'Editing response…';
      } else if (act === 'edit_save') {
        var nv = String((elDraftEditor && elDraftEditor.value) || '').trim();
        if (!nv) {
          if (elStatus) elStatus.textContent = 'Edited response is empty';
          return;
        }
        BRIDGE.lastDraft = nv;
        if (elDraft) elDraft.textContent = nv;
        setDraftEditMode(false);
        hideSuggestChip();
        syncDraftChrome();
        if (nv.length >= 6) {
          BRIDGE.pending = {
            action: 'learn_field_text',
            text: nv.slice(0, 2000),
            fieldPurpose: BRIDGE.lastFieldPurpose || '',
            fieldKey: currentFieldKey || '',
            t: Date.now(),
          };
          if (elStatus) elStatus.textContent = 'Edited response saved + learning style…';
        } else if (elStatus) {
          elStatus.textContent = 'Edited response saved';
        }
      } else if (act === 'edit_cancel') {
        setDraftEditMode(false);
        if (elStatus) elStatus.textContent = 'Edit canceled';
      } else if (act === 'up') {
        BRIDGE.pending = {
          action: 'feedback',
          kind: 'thumbs_up',
          fingerprint: BRIDGE.fingerprint,
          teachHintSnapshot: (elHint && elHint.value) ? String(elHint.value).trim().slice(0, 900) : '',
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          t: Date.now(),
        };
      } else if (act === 'dn') {
        BRIDGE.pending = {
          action: 'feedback',
          kind: 'thumbs_down',
          fingerprint: BRIDGE.fingerprint,
          fieldPurpose: BRIDGE.lastFieldPurpose || '',
          fieldKey: currentFieldKey || '',
          rejectedText: String(BRIDGE.suggestChipFullText || BRIDGE.lastDraft || '').slice(0, 1800),
          t: Date.now(),
        };
      }
    });
    syncDraftChrome();
  }

  function onPanelDragMove(ev) {
    if (!panelDragState || !ROOT) return;
    var dx = ev.clientX - panelDragState.startX;
    var dy = ev.clientY - panelDragState.startY;
    var rw = Math.min(ROOT.offsetWidth || 300, window.innerWidth - 12);
    var rh = Math.min(ROOT.offsetHeight || 140, window.innerHeight - 8);
    var nl = clamp(panelDragState.origLeft + dx, 6, window.innerWidth - rw - 6);
    var nt = clamp(panelDragState.origTop + dy, 6, window.innerHeight - rh - 6);
    ROOT.style.left = nl + 'px';
    ROOT.style.top = nt + 'px';
    panelManualPos = { left: nl, top: nt };
  }

  function onPanelDragUp() {
    panelDragState = null;
    try {
      document.removeEventListener('mousemove', onPanelDragMove, true);
      document.removeEventListener('mouseup', onPanelDragUp, true);
    } catch (e0) {}
  }

  function insertAtCursorInternal(text) {
    var t = String(text || '');
    if (!lastSummaryEl) return { ok: false, error: 'no_summary_target' };
    var tag = (lastSummaryEl.tagName || '').toUpperCase();
    if (tag !== 'TEXTAREA' && !(tag === 'INPUT' && isTextLikeInput(lastSummaryEl))) {
      return { ok: false, error: 'no_summary_target' };
    }
    var ta = lastSummaryEl;
    try {
      ta.focus();
      var start = ta.selectionStart;
      var end = ta.selectionEnd;
      var v = ta.value || '';
      if (start == null || end == null) ta.value = v + t;
      else {
        ta.value = v.slice(0, start) + t + v.slice(end);
        var np = start + t.length;
        ta.selectionStart = ta.selectionEnd = np;
      }
      try {
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e3) {}
      return { ok: true, inserted: t.length };
    } catch (e4) {
      return { ok: false, error: String(e4.message || e4) };
    }
  }

  /** Replace active field value entirely (for confident auto-apply). */
  function replaceActiveValueInternal(text) {
    var t = String(text || '');
    if (!lastSummaryEl) return { ok: false, error: 'no_summary_target' };
    var tag = (lastSummaryEl.tagName || '').toUpperCase();
    if (tag !== 'TEXTAREA' && !(tag === 'INPUT' && isTextLikeInput(lastSummaryEl))) {
      return { ok: false, error: 'no_summary_target' };
    }
    var el = lastSummaryEl;
    try {
      var prev = String(el.value || '');
      var fk = fieldKey(el);
      el.focus();
      el.value = t;
      try {
        var end = t.length;
        if (typeof el.selectionStart === 'number') {
          el.selectionStart = end;
          el.selectionEnd = end;
        }
      } catch (e2) {}
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e3) {}
      lastAutoReplace = { fieldKey: fk, prevValue: prev, nextValue: t, at: Date.now() };
      return { ok: true, replaced: t.length };
    } catch (e4) {
      return { ok: false, error: String(e4.message || e4) };
    }
  }

  /** Undo most recent full-field auto-replace if still on same field and unchanged. */
  function undoLastReplaceInternal() {
    if (!lastAutoReplace || !lastSummaryEl) return { ok: false, error: 'nothing_to_undo' };
    try {
      var fk = fieldKey(lastSummaryEl);
      if (!fk || fk !== String(lastAutoReplace.fieldKey || '')) return { ok: false, error: 'field_changed' };
      var prev = String(lastAutoReplace.prevValue || '');
      var cur = String(lastSummaryEl.value || '');
      if (cur !== String(lastAutoReplace.nextValue || '')) return { ok: false, error: 'value_changed' };
      lastSummaryEl.focus();
      lastSummaryEl.value = prev;
      try {
        var end = prev.length;
        if (typeof lastSummaryEl.selectionStart === 'number') {
          lastSummaryEl.selectionStart = end;
          lastSummaryEl.selectionEnd = end;
        }
      } catch (e2) {}
      try {
        lastSummaryEl.dispatchEvent(new Event('input', { bubbles: true }));
        lastSummaryEl.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e3) {}
      lastAutoReplace = null;
      return { ok: true };
    } catch (e4) {
      return { ok: false, error: String(e4.message || e4) };
    }
  }

  function capturePageContext() {
    var path = '';
    try { path = location.pathname || ''; } catch (e) {}
    var title = '';
    try { title = document.title || ''; } catch (e) {}
    var headings = [];
    try {
      var hs = document.querySelectorAll('h1, h2, h3, [role="heading"]');
      for (var i = 0; i < hs.length && headings.length < 35; i++) {
        if (!visible(hs[i])) continue;
        var tx = trunc(hs[i].textContent || hs[i].innerText || '', 180);
        if (tx) headings.push(tx);
      }
    } catch (e) {}

    var fields = [];
    var seen = new WeakSet();
    var maxFields = 400;
    var maxVal = 480;

    function pushField(role, el, val, extra) {
      if (fields.length >= maxFields) return;
      if (!el || seen.has(el)) return;
      seen.add(el);
      var label = labelFor(el);
      var f = {
        role: role,
        type: (el.type || el.tagName || role).toLowerCase(),
        label: label || (el.name || el.id || role),
        name: trunc(el.name || '', 120),
        id: trunc(el.id || '', 120),
        value: trunc(val, maxVal),
      };
      if (extra) {
        for (var ek in extra) { f[ek] = extra[ek]; }
      }
      fields.push(f);
    }

    try {
      var tas = document.querySelectorAll('textarea');
      for (var j = 0; j < tas.length; j++) {
        if (!visible(tas[j])) continue;
        try { pushField('textarea', tas[j], tas[j].value); } catch (e) {}
      }
      var inputs = document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"], input[type="number"]');
      for (var k = 0; k < inputs.length; k++) {
        if (!visible(inputs[k])) continue;
        var tp = (inputs[k].type || '').toLowerCase();
        if (tp && tp !== 'text' && tp !== 'search' && tp !== 'number' && tp !== '') continue;
        try { pushField('input', inputs[k], inputs[k].value); } catch (e2) {}
      }
      // Checkboxes
      var cbs = document.querySelectorAll('input[type="checkbox"]');
      for (var cbi = 0; cbi < cbs.length; cbi++) {
        if (!visible(cbs[cbi])) continue;
        try { pushField('checkbox', cbs[cbi], cbs[cbi].checked ? 'checked' : 'unchecked', { checked: cbs[cbi].checked }); } catch (e5) {}
      }
      // Radio buttons
      var radios = document.querySelectorAll('input[type="radio"]');
      for (var ri = 0; ri < radios.length; ri++) {
        if (!visible(radios[ri])) continue;
        try {
          pushField('radio', radios[ri], radios[ri].value, {
            checked: radios[ri].checked,
            radioGroup: radios[ri].name || '',
          });
        } catch (e6) {}
      }
      // Selects with options
      var sels = document.querySelectorAll('select');
      for (var m = 0; m < sels.length; m++) {
        if (!visible(sels[m])) continue;
        try {
          var sv = '';
          if (sels[m].selectedOptions && sels[m].selectedOptions[0]) sv = sels[m].selectedOptions[0].text || sels[m].value;
          else sv = sels[m].value;
          var opts = [];
          for (var oi = 0; oi < sels[m].options.length && oi < 10; oi++) {
            var opt = sels[m].options[oi];
            if (opt.value || opt.text) opts.push({ value: opt.value, text: opt.text });
          }
          pushField('select', sels[m], sv, { options: opts });
        } catch (e3) {}
      }
    } catch (e4) {}

    var out = {
      path: path,
      title: title,
      headings: headings,
      fields: fields,
      capturedAt: Date.now(),
    };
    try {
      var ae = document.activeElement;
      var chartTa = null;
      if (ae && ROOT && ROOT.contains(ae)) {
        chartTa = lastSummaryEl;
      } else if (ae && isLikelySummaryBox(ae) && visible(ae)) {
        chartTa = ae;
      }
      if (chartTa && isLikelySummaryBox(chartTa) && visible(chartTa)) {
        var semF = fieldSemantics(chartTa);
        out.focusedField = {
          label: labelFor(chartTa),
          name: trunc(chartTa.name || '', 120),
          id: trunc(chartTa.id || '', 120),
          placeholder: trunc(chartTa.getAttribute('placeholder') || '', 200),
          value: trunc(chartTa.value || '', 2200),
          fieldPurpose: semF.fieldPurpose,
          sectionTrail: semF.sectionTrail,
          tableCaption: semF.tableCaption,
          tableRow: semF.tableRow,
          tableColumn: semF.tableColumn,
          rowPeerValues: semF.rowPeerValues || [],
          nearbySectionData: semF.nearbySectionData || [],
          nearbySectionName: semF.nearbySectionName || '',
          vitalsContext: collectVitalsContext(),
        };
      }
    } catch (e5) {}
    return out;
  }

  /** Capture EVERY visible field on the page — text, checkboxes, radios, selects — for training mode. */
  function captureFullNote() {
    var allFields = [];
    var seen = new WeakSet();
    function pushFull(el) {
      if (!el || seen.has(el) || !visible(el)) return;
      seen.add(el);
      var tag = (el.tagName || '').toUpperCase();
      var type = (el.type || '').toLowerCase();
      var sem = fieldSemantics(el);
      var entry = {
        tag: tag,
        type: type,
        id: trunc(el.id || '', 120),
        name: trunc(el.name || '', 120),
        label: trunc(labelFor(el), 200),
        fieldPurpose: trunc(sem.fieldPurpose, 400),
        sectionTrail: sem.sectionTrail || [],
        tableRow: sem.tableRow || '',
        tableColumn: sem.tableColumn || '',
      };
      if (tag === 'SELECT') {
        entry.fieldType = 'select';
        entry.value = el.value || '';
        entry.selectedText = (el.selectedOptions && el.selectedOptions[0]) ? (el.selectedOptions[0].text || '') : '';
        entry.options = [];
        for (var oi = 0; oi < Math.min(el.options.length, 30); oi++) {
          entry.options.push({ value: el.options[oi].value, text: el.options[oi].text || '' });
        }
      } else if (type === 'checkbox') {
        entry.fieldType = 'checkbox';
        entry.checked = !!el.checked;
        entry.value = el.value || '';
      } else if (type === 'radio') {
        entry.fieldType = 'radio';
        entry.checked = !!el.checked;
        entry.value = el.value || '';
        entry.radioGroup = el.name || '';
      } else if (tag === 'TEXTAREA') {
        entry.fieldType = 'textarea';
        entry.value = trunc(el.value || '', 3000);
      } else {
        entry.fieldType = 'input';
        entry.value = trunc(el.value || '', 500);
      }
      allFields.push(entry);
    }
    try {
      var els = document.querySelectorAll('textarea, input, select');
      for (var i = 0; i < els.length; i++) pushFull(els[i]);
    } catch (e) {}
    var headings = [];
    try {
      var hs = document.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
      for (var hi = 0; hi < hs.length && headings.length < 40; hi++) {
        if (!visible(hs[hi])) continue;
        var tx = trunc(hs[hi].textContent || '', 180);
        if (tx) headings.push(tx);
      }
    } catch (e2) {}
    return {
      ok: true,
      path: (function() { try { return location.pathname || ''; } catch (e) { return ''; } })(),
      title: (function() { try { return document.title || ''; } catch (e) { return ''; } })(),
      headings: headings,
      fields: allFields,
      capturedAt: Date.now(),
      totalFields: allFields.length,
      filledTextFields: allFields.filter(function(f) { return (f.fieldType === 'textarea' || f.fieldType === 'input') && (f.value || '').trim().length > 0; }).length,
      checkedBoxes: allFields.filter(function(f) { return f.fieldType === 'checkbox' && f.checked; }).length,
      selectedDropdowns: allFields.filter(function(f) { return f.fieldType === 'select' && (f.value || '').trim().length > 0; }).length,
    };
  }

  function applyHostPayload(p) {
    if (!p || typeof p !== 'object') return;
    if (elStatus && p.status != null) elStatus.textContent = String(p.status);
    if (elDraft && p.draft != null) {
      elDraft.textContent = String(p.draft);
      BRIDGE.lastDraft = String(p.draft);
    }
    if (p.fingerprint != null) BRIDGE.fingerprint = String(p.fingerprint);
    if (p.loading === true) {
      aiLoading = true;
      if (elStatus) elStatus.textContent = 'Working…';
    }
    if (p.loading === false) aiLoading = false;
    if (p.clearDraft) {
      if (elDraft) elDraft.textContent = '';
      BRIDGE.lastDraft = '';
    }
    if (p.localSuggestions != null) {
      renderSnipButtons(Array.isArray(p.localSuggestions) ? p.localSuggestions : []);
    }
    if (p.panelMinimized === true) setPanelMinimized(true);
    if (p.panelMinimized === false) setPanelMinimized(false);
    if (p.suggestChipHide === true) hideSuggestChip();
    if (p.rulesPreview != null) {
      BRIDGE.rulesPreview = Array.isArray(p.rulesPreview) ? p.rulesPreview : [];
      if (chipRulesOpen) renderChipRulesPanel();
    }
    if (p.suggestChipText != null) {
      var stx = String(p.suggestChipText).trim();
      if (stx) showSuggestChip(stx);
      else hideSuggestChip();
    }
    if (p.sectionTemplates != null) {
      templateList = Array.isArray(p.sectionTemplates) ? p.sectionTemplates : [];
      if (templateOverlayOpen) renderTemplateList();
    }
    if (p.sectionTemplateLoad != null && templateSectionEl) {
      var filled = fillSectionFromTemplate(templateSectionEl, p.sectionTemplateLoad || {});
      if (elStatus) elStatus.textContent = 'Filled ' + filled + ' fields from template';
    }
    if (p.chatReply != null) {
      appendChatMsg('agent', String(p.chatReply));
    }
    if (p.agentFills != null && Array.isArray(p.agentFills)) {
      console.log('[AgentFills] Received ' + p.agentFills.length + ' fills:', JSON.stringify(p.agentFills).slice(0, 500));
      var fillCount = 0;
      for (var afi = 0; afi < p.agentFills.length; afi++) {
        var af = p.agentFills[afi];
        if (!af) continue;
        // Skip only if there's nothing useful — value OR checked must be present
        if (af.value == null && af.checked == null) continue;
        var target = null;
        // Try multiple lookup strategies
        if (af.id) target = document.getElementById(af.id);
        if (!target && af.name) {
          try { target = document.querySelector('[name="' + af.name.replace(/"/g, '') + '"]'); } catch(e1){}
        }
        // Fallback: search by partial id/name match
        if (!target && af.id) {
          try {
            var partialId = document.querySelector('[id*="' + af.id.replace(/"/g, '').slice(-20) + '"]');
            if (partialId) target = partialId;
          } catch(e2){}
        }
        // Fallback: search by label text
        if (!target && af.label) {
          try {
            var labels = document.querySelectorAll('label');
            for (var li = 0; li < labels.length; li++) {
              var lt = (labels[li].textContent || '').trim().toLowerCase();
              if (lt === af.label.toLowerCase() || lt.indexOf(af.label.toLowerCase()) >= 0) {
                var forId = labels[li].getAttribute('for');
                if (forId) target = document.getElementById(forId);
                if (!target) target = labels[li].querySelector('input, select, textarea');
                if (!target) {
                  // Check adjacent elements
                  var next = labels[li].nextElementSibling;
                  if (next && (next.tagName === 'INPUT' || next.tagName === 'SELECT' || next.tagName === 'TEXTAREA')) target = next;
                }
                if (target) break;
              }
            }
          } catch(e3){}
        }
        // Fallback: find select elements by nearby text content
        if (!target && af.value != null && af.checked == null) {
          try {
            var searchLabel = String(af.label || af.name || af.id || '').toLowerCase().trim();
            if (searchLabel) {
              var allSelects = document.querySelectorAll('select');
              for (var si = 0; si < allSelects.length; si++) {
                var sel = allSelects[si];
                // Check parent/grandparent text, previous sibling text, or table cell text
                var ctx = '';
                if (sel.parentElement) ctx += ' ' + (sel.parentElement.textContent || '');
                if (sel.previousElementSibling) ctx += ' ' + (sel.previousElementSibling.textContent || '');
                // For table layouts, check the cell before this one
                var td = sel.closest('td');
                if (td && td.previousElementSibling) ctx += ' ' + (td.previousElementSibling.textContent || '');
                // Check the table header if in a table
                if (td) {
                  var tr = td.closest('tr');
                  if (tr) {
                    var thIdx = Array.prototype.indexOf.call(tr.children, td);
                    var thead = td.closest('table');
                    if (thead) {
                      var headerRow = thead.querySelector('tr');
                      if (headerRow && headerRow.children[thIdx]) ctx += ' ' + (headerRow.children[thIdx].textContent || '');
                    }
                  }
                }
                ctx = ctx.toLowerCase().trim();
                if (ctx.indexOf(searchLabel) >= 0) {
                  target = sel;
                  break;
                }
              }
            }
          } catch(e5){}
        }
        // Fallback: find text inputs by nearby text content
        if (!target && af.value != null && af.checked == null) {
          try {
            var searchLabel2 = String(af.label || af.name || af.id || '').toLowerCase().trim();
            if (searchLabel2) {
              var allInputs2 = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
              for (var ii = 0; ii < allInputs2.length; ii++) {
                var inp = allInputs2[ii];
                var ictx = '';
                if (inp.parentElement) ictx += ' ' + (inp.parentElement.textContent || '');
                if (inp.previousElementSibling) ictx += ' ' + (inp.previousElementSibling.textContent || '');
                var itd = inp.closest('td');
                if (itd && itd.previousElementSibling) ictx += ' ' + (itd.previousElementSibling.textContent || '');
                ictx = ictx.toLowerCase().trim();
                if (ictx.indexOf(searchLabel2) >= 0) {
                  target = inp;
                  break;
                }
              }
            }
          } catch(e6){}
        }
        // Try finding radio button by group name + value or by label text
        if (!target && af.checked != null) {
          try {
            // Radio: match by name (group) + value
            if (af.name && af.value) {
              var radios = document.querySelectorAll('input[type="radio"][name="' + af.name.replace(/"/g, '') + '"]');
              for (var rdi = 0; rdi < radios.length; rdi++) {
                if (radios[rdi].value.toLowerCase() === String(af.value).toLowerCase()) {
                  target = radios[rdi]; break;
                }
              }
            }
            // Radio/checkbox: match by adjacent text content
            if (!target) {
              var searchText = String(af.label || af.name || af.id || '').toLowerCase();
              var searchVal = String(af.value || '').toLowerCase();
              if (searchText || searchVal) {
                var allInputs = document.querySelectorAll('input[type="checkbox"], input[type="radio"]');
                for (var cbi = 0; cbi < allInputs.length; cbi++) {
                  var cb = allInputs[cbi];
                  var parentText = (cb.parentElement ? cb.parentElement.textContent : '').trim().toLowerCase();
                  // Match by label text containing search text
                  if (searchText && parentText.indexOf(searchText) >= 0) {
                    // For radio buttons, also check value matches if provided
                    if (cb.type === 'radio' && searchVal && cb.value.toLowerCase() !== searchVal) continue;
                    target = cb; break;
                  }
                  // Match by value (e.g., "Yes", "No")
                  if (searchVal && cb.value.toLowerCase() === searchVal && parentText.indexOf(searchVal) >= 0) {
                    target = cb; break;
                  }
                }
              }
            }
          } catch(e4){}
        }
        if (!target) {
          console.log('[AgentFills] Could not find target for fill:', JSON.stringify(af));
          continue;
        }
        console.log('[AgentFills] Found target:', target.tagName, target.type, 'id=' + target.id, 'for fill:', JSON.stringify(af).slice(0, 200));
        try {
          if (target.type === 'radio') {
            // For radio buttons: click to select if not already selected
            if (!target.checked) {
              target.click();
              fillCount++;
            }
          } else if (target.type === 'checkbox') {
            var wantChecked = af.checked === true || af.checked === 'true' || af.value === 'true' || af.value === 'checked';
            if (target.checked !== wantChecked) {
              target.click();
              fillCount++;
            }
          } else if (target.tagName === 'SELECT') {
            var setVal = String(af.value || '');
            // Try exact value match first
            target.value = setVal;
            if (target.value !== setVal) {
              // Try matching by option text (AI often sends display text instead of value)
              var opts = target.options;
              for (var oi = 0; oi < opts.length; oi++) {
                if (opts[oi].text.toLowerCase().trim() === setVal.toLowerCase().trim()) {
                  target.value = opts[oi].value;
                  break;
                }
                // Partial match
                if (opts[oi].text.toLowerCase().indexOf(setVal.toLowerCase()) >= 0) {
                  target.value = opts[oi].value;
                  break;
                }
              }
            }
            target.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('[AgentFills] SELECT final value:', target.value, 'selectedText:', (target.selectedOptions && target.selectedOptions[0] ? target.selectedOptions[0].text : ''));
            fillCount++;
          } else {
            target.value = String(af.value || '');
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            fillCount++;
          }
        } catch (afe) {}
      }
      if (fillCount && elStatus) elStatus.textContent = 'Agent filled ' + fillCount + ' field(s)';
    }
    syncDraftChrome();
    scheduleReposition();
  }

  document.addEventListener('focusin', onDocFocusIn, true);
  document.addEventListener('focusout', onDocFocusOut, true);

  document.addEventListener('input', function(ev) {
    var el = ev.target;
    if (!el || el !== lastSummaryEl || !isLikelySummaryBox(el)) return;
    fieldInputCount = Math.min(10000, fieldInputCount + 1);
  }, true);

  document.addEventListener('keydown', function(ev) {
    try {
      if (!ev || ev.defaultPrevented) return;
      if (ev.key !== ' ' && ev.code !== 'Space') return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (!SUGGEST_CHIP || SUGGEST_CHIP.style.display === 'none') return;
      if (!BRIDGE.suggestChipFullText) return;
      if (!lastSummaryEl || document.activeElement !== lastSummaryEl) return;
      var next = BRIDGE.suggestChipFullText;
      var r = replaceActiveValueInternal(next);
      if (r && r.ok) {
        ev.preventDefault();
        ev.stopPropagation();
        if (elStatus) elStatus.textContent = 'Replaced field with suggestion (Space)';
        hideSuggestChip();
      }
    } catch (e0) {}
  }, true);

  document.addEventListener('scroll', function(ev) {
    try {
      var tgt = ev.target;
      if (tgt && tgt !== document && tgt !== document.documentElement && ROOT && ROOT.contains(tgt)) return;
    } catch (e) {}
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(scheduleReposition, 140);
  }, true);
  window.addEventListener('resize', function() {
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(scheduleReposition, 160);
  });

  mountFloat();

  // Attach template listeners to section headings (re-scan periodically for dynamic content)
  try { attachSectionHeadingListeners(); } catch (e) {}
  setInterval(function() { try { attachSectionHeadingListeners(); } catch (e) {} }, 5000);
  try { setupBulkInputCounter(); } catch (e) {}
  try { setupChatInput(); } catch (e) {}

  window.__KINNSER_SUMMARY_COPILOT__ = {
    drainSignals: function() {
      var o = SIGNAL_BUF.slice();
      SIGNAL_BUF.length = 0;
      return o;
    },
    drainBridge: function() {
      var p = BRIDGE.pending;
      if (p) {
        // #region agent log
        fetch('http://127.0.0.1:7444/ingest/9f1a5f2d-97a0-4685-b04b-06f3a38c8908',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1182f5'},body:JSON.stringify({sessionId:'1182f5',runId:'rule-click',hypothesisId:'H3',location:'kinnserSummaryCopilotScript.js:drainBridge',message:'Bridge drained pending action',data:{action:String(p.action||''),fieldKey:String(p.fieldKey||'').slice(0,180)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        BRIDGE.pending = null;
        return p;
      }
      var a = BRIDGE.pendingAutoSuggest;
      BRIDGE.pendingAutoSuggest = null;
      return a || null;
    },
    applyHostPayload: applyHostPayload,
    setFloatEnabled: function(on) {
      floatUserEnabled = !!on;
      if (!floatUserEnabled) {
        hideMainPanel();
        showReopenChip(false);
      } else if (lastSummaryEl && document.activeElement === lastSummaryEl) {
        presentForField(lastSummaryEl);
      }
    },
    clearDismissals: function() {
      dismissedKeys = {};
      showReopenChip(false);
      if (lastSummaryEl && document.activeElement === lastSummaryEl && floatUserEnabled) presentForField(lastSummaryEl);
    },
    capturePageContext: capturePageContext,
    captureFullNote: captureFullNote,
    getActiveSummaryMeta: function() {
      if (!lastSummaryEl) return null;
      var sm = fieldSemantics(lastSummaryEl);
      return {
        label: trunc(labelFor(lastSummaryEl), 200),
        id: lastSummaryEl.id || '',
        name: lastSummaryEl.name || '',
        fieldPurpose: sm.fieldPurpose,
        sectionTrail: sm.sectionTrail,
        tableRow: sm.tableRow,
        tableColumn: sm.tableColumn,
      };
    },
    insertAtCursor: function(text) {
      return insertAtCursorInternal(text);
    },
    replaceActiveValue: function(text) {
      return replaceActiveValueInternal(text);
    },
    undoLastReplace: function() {
      return undoLastReplaceInternal();
    },
    ping: function() { return 'SUMMARY_COPILOT_OK'; }
  };

  return 'SUMMARY_COPILOT_INSTALLED';
})();
`;
}

export function getKinnserSummaryCaptureCode() {
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.capturePageContext) return { ok: false, error: 'not_installed' };
    var snap = k.capturePageContext();
    var meta = k.getActiveSummaryMeta && k.getActiveSummaryMeta();
    if (meta && meta.label) snap.activeSummaryLabel = meta.label;
    if (meta && meta.fieldPurpose) snap.activeFieldPurpose = meta.fieldPurpose;
    return { ok: true, snapshot: snap };
  } catch (e) { return { ok: false, error: String(e.message || e) }; } })()`;
}

/** @param {string} draftText */
export function getKinnserSummaryInsertCode(draftText) {
  const escaped = JSON.stringify(String(draftText ?? ''));
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.insertAtCursor) return { ok: false, error: 'not_installed' };
    return k.insertAtCursor(${escaped});
  } catch (e) { return { ok: false, error: String(e.message || e) }; } })()`;
}

/** @param {string} text */
export function getKinnserSummaryReplaceActiveFieldCode(text) {
  const escaped = JSON.stringify(String(text ?? ''));
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.replaceActiveValue) return { ok: false, error: 'not_installed' };
    return k.replaceActiveValue(${escaped});
  } catch (e) { return { ok: false, error: String(e.message || e) }; } })()`;
}

export function getKinnserSummaryUndoReplaceCode() {
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.undoLastReplace) return { ok: false, error: 'not_installed' };
    return k.undoLastReplace();
  } catch (e) { return { ok: false, error: String(e.message || e) }; } })()`;
}

export function getKinnserSummaryDrainSignalsCode() {
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.drainSignals) return [];
    return k.drainSignals();
  } catch (e) { return []; } })()`;
}

export function getKinnserSummaryDrainBridgeCode() {
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.drainBridge) return null;
    return k.drainBridge();
  } catch (e) { return null; } })()`;
}

/** @param {Record<string, unknown>} payloadObj */
export function getKinnserSummaryApplyHostPayloadCode(payloadObj) {
  const inner = JSON.stringify(payloadObj);
  const escaped = JSON.stringify(inner);
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (k && k.applyHostPayload) k.applyHostPayload(JSON.parse(${escaped}));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; } })()`;
}

/** @param {boolean} enabled */
export function getKinnserSummarySetFloatEnabledCode(enabled) {
  const on = enabled ? 'true' : 'false';
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (k && k.setFloatEnabled) k.setFloatEnabled(${on});
    return { ok: true };
  } catch (e) { return { ok: false }; } })()`;
}

export function getKinnserSummaryClearDismissalsCode() {
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (k && k.clearDismissals) k.clearDismissals();
    return { ok: true };
  } catch (e) { return { ok: false }; } })()`;
}

export function getKinnserSummaryFullNoteCaptureCode() {
  return `(() => { try {
    var k = window.__KINNSER_SUMMARY_COPILOT__;
    if (!k || !k.captureFullNote) return { ok: false, error: 'not_installed' };
    return k.captureFullNote();
  } catch (e) { return { ok: false, error: String(e.message || e) }; } })()`;
}
