/**
 * Pluggable AI provider adapter.
 *
 * docs/stack.md lists OpenAI, Claude and Gemini as interchangeable options, so the
 * call site stays behind one interface and the provider is chosen by env var. Raw
 * HTTP rather than three SDKs: Deno Edge Functions, three providers, one shape.
 */

export type ProviderName = "openai" | "claude" | "gemini";

export interface SummaryRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface SummaryResult {
  provider: ProviderName;
  model: string;
  content: string;
}

export class ProviderRefusal extends Error {
  constructor(readonly category: string | null) {
    super(`Provider declined the request${category ? ` (${category})` : ""}`);
    this.name = "ProviderRefusal";
  }
}

const MODELS: Record<ProviderName, string> = {
  claude: "claude-opus-5",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
};

export function activeProvider(): ProviderName {
  const value = Deno.env.get("AI_PROVIDER") ?? "claude";
  if (value !== "openai" && value !== "claude" && value !== "gemini") {
    throw new Error(`AI_PROVIDER must be openai, claude or gemini (got "${value}")`);
  }
  return value;
}

export function summarise(request: SummaryRequest): Promise<SummaryResult> {
  const provider = activeProvider();
  switch (provider) {
    case "claude":
      return callClaude(request);
    case "openai":
      return callOpenAi(request);
    case "gemini":
      return callGemini(request);
  }
}

async function callClaude(request: SummaryRequest): Promise<SummaryResult> {
  const key = requireKey("ANTHROPIC_API_KEY");
  const model = MODELS.claude;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? 2048,
      system: request.system,
      // Summarising a day of activity is routine work — low effort keeps latency
      // and spend down. Note: temperature/top_p are rejected on this model.
      output_config: { effort: "low" },
      messages: [{ role: "user", content: request.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();

  // A safety classifier can decline with HTTP 200 — check before reading content,
  // or indexing content[0] throws on an empty array.
  if (body.stop_reason === "refusal") {
    throw new ProviderRefusal(body.stop_details?.category ?? null);
  }

  const text = (body.content ?? [])
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("");

  return { provider: "claude", model, content: text };
}

async function callOpenAi(request: SummaryRequest): Promise<SummaryResult> {
  const key = requireKey("OPENAI_API_KEY");
  const model = MODELS.openai;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_completion_tokens: request.maxTokens ?? 2048,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return {
    provider: "openai",
    model,
    content: body.choices?.[0]?.message?.content ?? "",
  };
}

async function callGemini(request: SummaryRequest): Promise<SummaryResult> {
  const key = requireKey("GEMINI_API_KEY");
  const model = MODELS.gemini;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: { maxOutputTokens: request.maxTokens ?? 2048 },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((part: { text?: string }) => part.text ?? "")
    .join("");

  return { provider: "gemini", model, content: text };
}

function requireKey(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set for the selected AI_PROVIDER`);
  return value;
}
