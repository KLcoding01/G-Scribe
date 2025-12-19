const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const OpenAI = require("openai");
const { z } = require("zod");

const { buildMessages } = require("./lib/buildPrompt");
const { validateOutput } = require("./lib/validateOutput");
const { postProcess } = require("./lib/postProcess");
const { buildCorrectionMessages } = require("./lib/correctionPrompt");

// -------------------- Config --------------------
const PORT = process.env.PORT || 3300;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Read prompts once
const systemPrompt = fs.readFileSync(path.resolve(__dirname, "prompts/system.txt"), "utf-8");
const developerPrompt = fs.readFileSync(path.resolve(__dirname, "prompts/developer.txt"), "utf-8");

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// -------------------- App --------------------
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

const BodySchema = z.object({
  originalNote: z.string().min(1, "originalNote is required"),
  changes: z.string().min(1, "changes is required"),
  sentenceTarget: z.number().int().min(5).max(7).optional()
});

// --------------- OpenAI helper ---------------
async function callModel(messages) {
  if (!openai) throw new Error("OPENAI_API_KEY missing. Set it in .env");

  // Using chat.completions for broad SDK compatibility
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.3
  });

  const text = resp?.choices?.[0]?.message?.content || "";
  return text.trim();
}

// --------------- Endpoint ---------------
app.post("/api/revise-note", async (req, res) => {
  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }

    const { originalNote, changes, sentenceTarget = 6 } = parsed.data;

    // 1) First pass
    const messages = buildMessages({ originalNote, changes, sentenceTarget });
    let output = await callModel(messages);
    output = postProcess(output);

    // 2) Validate
    let v = validateOutput(output, sentenceTarget);

    // 3) One correction pass if needed
    if (!v.ok) {
      const correctionMessages = buildCorrectionMessages({
        system: systemPrompt,
        developer: developerPrompt,
        originalNote,
        changes,
        priorOutput: output,
        errors: v.errors,
        sentenceTarget
      });

      let corrected = await callModel(correctionMessages);
      corrected = postProcess(corrected);

      const v2 = validateOutput(corrected, sentenceTarget);
      // If still failing, return corrected anyway + validation warnings (non-blocking)
      if (!v2.ok) {
        return res.json({ output: corrected, warnings: v2.errors });
      }
      return res.json({ output: corrected });
    }

    return res.json({ output });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`Kelvin PT Note Bot running on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
