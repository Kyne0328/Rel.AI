async function improvePromptWithGemini(request, config) {
  const apiKey = String(config.geminiApiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured. Save one in Rel.AI or run: npm run gemini:key -- YOUR_API_KEY");
  }
  if (/[\x00-\x1f\x7f]/.test(apiKey)) {
    throw new Error("Gemini API key contains invalid characters. Paste a clean key without whitespace or control characters.");
  }

  const model = String(config.geminiModel || "gemini-2.5-flash").trim();
  const endpoint = String(config.geminiEndpoint || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/g, "");
  const url = `${endpoint}/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = buildImprovePrompt(request);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(config.timeoutMs) || 60000, 15000), 120000));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200
        }
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_error) {}

    if (!response.ok) {
      const message = data && data.error && data.error.message ? data.error.message : text.slice(0, 1000);
      throw new Error(`Gemini API request failed (${response.status}): ${message}`);
    }

    const improved = extractGeminiText(data).trim();
    if (!improved) {
      throw new Error("Gemini returned an empty prompt improvement.");
    }

    return {
      ok: true,
      type: "relai.geminiPrompt",
      improvedPrompt: clampImprovedPrompt(improved),
      geminiModel: model,
      message: "Improved the task prompt with Gemini."
    };
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Gemini prompt improvement timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildImprovePrompt(request) {
  const lines = [];
  lines.push("Improve this Rel.AI coding task prompt before it is sent to ChatGPT web.");
  lines.push("");
  lines.push("Return only the improved prompt text. Do not include markdown fences, commentary, labels, or multiple alternatives.");
  lines.push("");
  lines.push("Goals:");
  lines.push("- Keep the user's intent intact.");
  lines.push("- Make the task specific, actionable, and concise.");
  lines.push("- Preserve any requested files, paths, constraints, and behavior exactly.");
  lines.push("- Do not invent requirements or implementation details.");
  lines.push("- Do not write code, diffs, or Rel.AI metadata.");
  lines.push("- If the user's prompt is already clear, lightly polish it instead of expanding it.");
  lines.push("");
  if (request.workspace) lines.push(`Workspace alias: ${request.workspace}`);
  if (request.responseMode) lines.push(`Requested response mode: ${request.responseMode}`);
  if (request.contextScope) lines.push(`Context scope: ${request.contextScope}`);
  if (request.contextMode) lines.push(`Context packing: ${request.contextMode}`);
  if (Array.isArray(request.include) && request.include.length) {
    lines.push("Selected include paths:");
    for (const item of request.include.slice(0, 40)) lines.push(`- ${item}`);
  }
  if (Array.isArray(request.exclude) && request.exclude.length) {
    lines.push("Selected exclude paths:");
    for (const item of request.exclude.slice(0, 20)) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("Original user prompt:");
  lines.push(String(request.prompt || "").trim());
  return lines.join("\n");
}

function extractGeminiText(data) {
  const parts = [];
  const candidates = data && Array.isArray(data.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const contentParts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      if (part && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function clampImprovedPrompt(text) {
  return String(text || "").trim().replace(/^```[a-zA-Z0-9_-]*\s*/g, "").replace(/```$/g, "").trim().slice(0, 8000);
}

module.exports = {
  improvePromptWithGemini
};
