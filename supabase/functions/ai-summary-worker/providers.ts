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
  /**
   * Request a JSON object where the provider has a mode for it. Defaults to on;
   * pass `false` for a caller that wants prose.
   *
   * Never a guarantee — Claude has no JSON mode at all — so `parseModelOutput`
   * still has to cope with a plain paragraph. This only raises the odds of the
   * structured path being taken.
   */
  json?: boolean;
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

/**
 * A hung provider must not hold the whole batch.
 *
 * The worker summarises every employee in sequence; without a deadline one stalled
 * connection takes the Edge Function's wall clock with it and the rest of the
 * company gets no summary at all.
 */
const REQUEST_TIMEOUT_MS = 45_000;

function timeout(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function callClaude(request: SummaryRequest): Promise<SummaryResult> {
  const key = requireKey("ANTHROPIC_API_KEY");
  const model = MODELS.claude;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: timeout(),
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
    signal: timeout(),
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_completion_tokens: request.maxTokens ?? 2048,
      // Safe to request: the system prompt names JSON, which this mode requires.
      ...(request.json === false ? {} : { response_format: { type: "json_object" } }),
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
  const choice = body.choices?.[0];

  // Same shape of event as Claude's `stop_reason: "refusal"`, reported differently:
  // a populated `refusal` field, or the filter tripping on the way out.
  if (typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0) {
    throw new ProviderRefusal("refusal");
  }
  if (choice?.finish_reason === "content_filter") {
    throw new ProviderRefusal("content_filter");
  }

  return { provider: "openai", model, content: choice?.message?.content ?? "" };
}

async function callGemini(request: SummaryRequest): Promise<SummaryResult> {
  const key = requireKey("GEMINI_API_KEY");
  const model = MODELS.gemini;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      signal: timeout(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? 2048,
          ...(request.json === false ? {} : { responseMimeType: "application/json" }),
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();

  // Gemini declines in two places: before generation (the prompt is blocked) and
  // after (the candidate is). Neither is an HTTP error, so both need reading.
  const blockReason = body.promptFeedback?.blockReason;
  if (typeof blockReason === "string") throw new ProviderRefusal(blockReason);

  const candidate = body.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (typeof finishReason === "string" && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    throw new ProviderRefusal(finishReason);
  }

  const text = (candidate?.content?.parts ?? [])
    .map((part: { text?: string }) => part.text ?? "")
    .join("");

  return { provider: "gemini", model, content: text };
}

function requireKey(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set for the selected AI_PROVIDER`);
  return value;
}
