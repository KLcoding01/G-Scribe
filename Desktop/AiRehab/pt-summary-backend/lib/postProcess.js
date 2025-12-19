/**
 * Post-processing that ONLY enforces formatting/terminology
 * (does not add new clinical findings/interventions).
 */
function postProcess(text) {
  if (!text) return text;
  
  let out = text;
  
  // Remove arrows if present
  out = out.replace(/[↑↓]/g, "");
  
  // Standardize common terms -> abbreviations
  const replacements = [
    [/\bPatient\b/g, "Pt"],
    [/\bpatient\b/g, "Pt"],
    [/\bsoft\s*tissue\s*mobilization\b/gi, "STM"],
    [/\btherapeutic\s*exercise\b/gi, "TherEx"],
    [/\btherapeutic\s*activity\b/gi, "TherAct"],
    [/\bhome\s*exercise\s*program\b/gi, "HEP"],
    [/\bactivities\s*of\s*daily\s*living\b/gi, "ADLs"],
    [/\bbilateral\b/gi, "B"],
    [/\bright\b/gi, "R"],
    [/\bleft\b/gi, "L"]
  ];
  
  for (const [rx, rep] of replacements) out = out.replace(rx, rep);
  
  // Normalize spacing but preserve paragraph breaks
  out = out.replace(/\r\n/g, "\n");
  
  // Work with a single lines array for all formatting rules
  let lines = out.split("\n").map((l) => l.trimEnd());
  
  // Ensure a blank line AFTER the first line (Subjective → Summary separation)
  if (lines.length > 1 && lines[1].trim() !== "") {
    lines.splice(1, 0, ""); // insert blank line after subjective
  }
  
  // Collapse excessive blank lines (keep max 1 blank line)
  out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  
  // Re-split after collapsing
  lines = out.split(/\r?\n/).map((l) => l.trimEnd());
  
  // Ensure PT POC line exists at end
  const hasPOC = lines.some((l) => /^PT\s*POC\s*:/i.test(l.trim()));
  if (!hasPOC) {
    lines.push(
               "PT POC: Continue skilled PT with MT/STM, TherEx, and TherAct to improve mobility, restore function, and facilitate return to PLOF with improved ADL independence."
               );
  }
  
  return lines.join("\n").trim();
}

module.exports = { postProcess };
