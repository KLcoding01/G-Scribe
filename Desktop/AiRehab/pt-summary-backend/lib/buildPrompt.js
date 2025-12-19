const fs = require("fs");
const path = require("path");

function readPrompt(relPath) {
  const p = path.resolve(__dirname, "..", relPath);
  return fs.readFileSync(p, "utf-8");
}

/**
 * Builds messages for OpenAI chat.completions.
 */
function buildMessages({ originalNote, changes, sentenceTarget }) {
  const system = readPrompt("prompts/system.txt");
  const developer = readPrompt("prompts/developer.txt");

  const user = [
    "ORIGINAL NOTE:",
    originalNote?.trim() || "",
    "",
    "REQUESTED CHANGES:",
    changes?.trim() || "",
    "",
    "OUTPUT SETTINGS:",
    `- Main summary sentence target: ${sentenceTarget || 6} (must be 5–7)`,
    "",
    "Return the revised note now."
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "developer", content: developer },
    { role: "user", content: user }
  ];
}

module.exports = { buildMessages };
