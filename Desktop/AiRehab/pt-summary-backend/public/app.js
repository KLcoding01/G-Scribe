const $ = (id) => document.getElementById(id);

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg || "";
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setWarnings(warnings) {
  const el = $("warnings");
  if (!warnings || warnings.length === 0) {
    el.textContent = "";
    return;
  }
  el.textContent = "Validator warnings (returned anyway):\n- " + warnings.join("\n- ");
}

async function reviseNote() {
  const originalNote = $("originalNote").value.trim();
  const changes = $("changes").value.trim();
  const sentenceTarget = Number($("sentenceTarget").value);

  if (!originalNote || !changes) {
    setStatus("Please paste the original note and the requested changes.", true);
    return;
  }

  $("generateBtn").disabled = true;
  setStatus("Generating...");
  setWarnings(null);

  try {
    const resp = await fetch("/api/revise-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ originalNote, changes, sentenceTarget })
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "Request failed");
    }

    $("output").textContent = data.output || "";
    setWarnings(data.warnings || null);
    setStatus("Done.");
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    $("generateBtn").disabled = false;
  }
}

$("generateBtn").addEventListener("click", reviseNote);

$("copyBtn").addEventListener("click", async () => {
  const text = $("output").textContent || "";
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Copied to clipboard.");
});

$("clearBtn").addEventListener("click", () => {
  $("output").textContent = "";
  $("warnings").textContent = "";
  setStatus("");
});
