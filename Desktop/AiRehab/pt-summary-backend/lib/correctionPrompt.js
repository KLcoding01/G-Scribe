function buildCorrectionMessages({ system, developer, originalNote, changes, priorOutput, errors, sentenceTarget }) {
  const user = [
    "Your prior output violated formatting rules. Rewrite the note to satisfy ALL requirements.",
    "",
    "ORIGINAL NOTE:",
    originalNote?.trim() || "",
    "",
    "REQUESTED CHANGES:",
    changes?.trim() || "",
    "",
    "PRIOR OUTPUT (for reference):",
    priorOutput?.trim() || "",
    "",
    "ERRORS TO FIX:",
    ...errors.map(e => `- ${e}`),
    "",
    `Main summary sentence target: ${sentenceTarget || 6} (must be 5–7)`,
    "",
    "Return ONLY the corrected revised note."
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "developer", content: developer },
    { role: "user", content: user }
  ];
}

module.exports = { buildCorrectionMessages };
