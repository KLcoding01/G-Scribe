\
/**
 * Validates the required output structure and constraints.
 * Returns { ok: boolean, errors: string[], parsed: {statusLine, summaryText, pocLine} }
 */

function splitSentences(text) {
  const t = (text || "").trim();
  if (!t) return [];
  // Split on sentence end punctuation followed by whitespace and a capital letter/number.
  // This avoids splitting common abbreviations like "L-spine".
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/g).map(s => s.trim()).filter(Boolean);
  return parts;
}

function parseOutput(output) {
  const lines = (output || "").split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  // Identify PT POC line (must exist)
  const pocIdx = lines.findIndex(l => /^PT\s*POC\s*:/i.test(l));
  const pocLine = pocIdx >= 0 ? lines[pocIdx] : "";

  const statusLine = lines[0] || "";

  // Summary is everything after status line up to PT POC
  let summaryLines = [];
  if (pocIdx >= 0) {
    summaryLines = lines.slice(1, pocIdx);
  } else {
    summaryLines = lines.slice(1);
  }

  const summaryText = summaryLines.join(" ").replace(/\s+/g, " ").trim();

  return { statusLine, summaryText, pocLine };
}

function validateOutput(output, sentenceTarget) {
  const errors = [];
  const { statusLine, summaryText, pocLine } = parseOutput(output);

  if (!statusLine) errors.push("Missing pre-summary status line (first line).");

  if (!pocLine || !/^PT\s*POC\s*:/i.test(pocLine)) {
    errors.push('Missing final "PT POC:" line.');
  }

  // No arrows
  if (/[↑↓]/.test(output || "")) errors.push("Contains arrow symbols (↑ or ↓).");

  // Main summary exists
  if (!summaryText) errors.push("Missing main summary text.");

  // Sentence count 5–7
  const sentences = splitSentences(summaryText);
  if (sentences.length < 5 || sentences.length > 7) {
    errors.push(`Main summary must be 5–7 sentences; detected ${sentences.length}.`);
  }

  // Banned phrases in main summary
  const low = summaryText.toLowerCase();
  const banned = ["pt reports", "pt states", "verbalizes", "reported", "stated", "verbalized"];
  const hit = banned.find(b => low.includes(b));
  if (hit) errors.push(`Main summary contains banned phrasing ("${hit}"). Move this content to pre-summary status line.`);

  // Last sentence must support continued skilled PT
  const last = sentences[sentences.length - 1]?.toLowerCase() || "";
  const continuedOk =
    last.includes("continued skilled pt") ||
    last.includes("skilled pt remains indicated") ||
    last.includes("continued skilled physical therapy") ||
    last.includes("continued pt") && last.includes("skilled") && last.includes("indicated");

  if (!continuedOk) {
    errors.push("Last sentence of main summary must support need for continued skilled PT.");
  }

  // Target preference (soft check)
  const target = Number(sentenceTarget || 6);
  if (target >= 5 && target <= 7 && sentences.length !== target) {
    // Not a hard error; model must be 5–7. Keep as advisory only.
  }

  return { ok: errors.length === 0, errors, parsed: { statusLine, summaryText, pocLine } };
}

module.exports = { validateOutput, parseOutput, splitSentences };
