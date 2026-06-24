/**
 * ai-fallback.ts — src/lib/ai-fallback.ts
 *
 * Cascading multi-model / multi-provider AI caller. Tries each candidate in
 * order; on a rate-limit / quota / overload error, automatically falls through
 * to the next. Each provider is a SEPARATE free quota bucket, so it's very hard
 * to exhaust all of them at once.
 *
 * Providers used (all free, no credit card):
 *   - Gemini   : your AI_API_KEY. Frontier closed model, multimodal (images/audio/pdf).
 *   - Groq     : GROQ_API_KEY.     Fastest open-weights, Llama 3.3 70B + GPT-OSS 120B. Text only.
 *   - Cerebras : CEREBRAS_API_KEY. Even faster than Groq (~2000 tok/s), Llama 3.3 70B. Text only.
 *   - OpenRouter: OPENROUTER_API_KEY. One key → many free models w/ auto-failover. Text only.
 *
 * All non-Gemini providers are OpenAI-compatible, so they share one caller.
 * Text-only providers are skipped automatically when media is attached.
 *
 * Setup — add whichever keys you want to .env (more keys = more resilience):
 *   AI_API_KEY=...          (Gemini, you already have this)
 *   GROQ_API_KEY=...        (console.groq.com — no card)
 *   CEREBRAS_API_KEY=...    (cloud.cerebras.ai — no card)
 *   OPENROUTER_API_KEY=...  (openrouter.ai — no card for free models)
 */

import { GoogleGenAI } from "@google/genai";

const geminiAI = new GoogleGenAI({ apiKey: process.env.AI_API_KEY });

const GROQ_KEY       = process.env.GROQ_API_KEY       ?? "";
const CEREBRAS_KEY   = process.env.CEREBRAS_API_KEY   ?? "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

// ─── OpenAI-compatible endpoints for each provider ────────────────────────────
const ENDPOINTS: Record<string, string> = {
  groq:       "https://api.groq.com/openai/v1/chat/completions",
  cerebras:   "https://api.cerebras.ai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

const KEYS: Record<string, string> = {
  groq:       GROQ_KEY,
  cerebras:   CEREBRAS_KEY,
  openrouter: OPENROUTER_KEY,
};

// ─── Candidate chain (ordered best → fallback) ────────────────────────────────
// Within a tier, ordered by smartness. Media-incapable lanes are skipped when
// the request carries inline media (only Gemini handles images/audio/pdf).

type Provider = "gemini" | "groq" | "cerebras" | "openrouter";

interface Candidate {
  provider:     Provider;
  model:        string;
  label:        string;
  mediaCapable: boolean;
}

const CANDIDATES: Candidate[] = [
  // ── Gemini: frontier, multimodal — primary lanes ────────────────────────────
  { provider: "gemini",     model: "gemini-2.5-flash",                       label: "Gemini 2.5 Flash",      mediaCapable: true  },
  { provider: "gemini",     model: "gemini-2.5-flash-lite",                  label: "Gemini 2.5 Flash-Lite", mediaCapable: true  },
  { provider: "gemini",     model: "gemini-3-flash",                         label: "Gemini 3 Flash",        mediaCapable: true  },

  // ── Cerebras: fastest free inference (~2000 tok/s), smart 70B ───────────────
  { provider: "cerebras",   model: "llama-3.3-70b",                          label: "Cerebras Llama 3.3 70B", mediaCapable: false },

  // ── Groq: very fast, GPT-OSS 120B is the smartest open-weight lane ──────────
  { provider: "groq",       model: "openai/gpt-oss-120b",                    label: "Groq GPT-OSS 120B",      mediaCapable: false },
  { provider: "groq",       model: "llama-3.3-70b-versatile",                label: "Groq Llama 3.3 70B",     mediaCapable: false },

  // ── OpenRouter: broad free pool w/ its own failover, DeepSeek reasoning ─────
  { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1:free",       label: "OpenRouter DeepSeek V3", mediaCapable: false },
  { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", label: "OpenRouter Llama 3.3 70B", mediaCapable: false },

  // ── Last resort: smallest/fastest Groq lane ─────────────────────────────────
  { provider: "groq",       model: "llama-3.1-8b-instant",                   label: "Groq Llama 3.1 8B",      mediaCapable: false },
];

// ─── Error classification ─────────────────────────────────────────────────────

function isFalloverError(err: any): boolean {
  const status  = err?.status ?? err?.code ?? err?.response?.status;
  const message = String(err?.message ?? err ?? "").toLowerCase();

  if (status === 429 || status === 503 || status === 500 || status === 502) return true;

  const phrases = [
    "rate limit", "resource_exhausted", "quota", "usage spike",
    "too many requests", "overloaded", "unavailable", "try again later",
    "429", "503", "exceeded", "capacity",
  ];
  return phrases.some(p => message.includes(p));
}

// ─── Gemini caller (multimodal) ───────────────────────────────────────────────

async function callGemini(
  model: string, history: any[], parts: any[], systemInstruction: string
): Promise<string> {
  const chat = geminiAI.chats.create({ model, history, config: { systemInstruction } });
  const response = await chat.sendMessage({ message: parts });
  const text = response.text;
  if (!text) throw new Error("Empty response from Gemini");
  return text;
}

// ─── Generic OpenAI-compatible caller (Groq / Cerebras / OpenRouter) ──────────

async function callOpenAICompat(
  provider: Provider, model: string, history: any[], parts: any[], systemInstruction: string
): Promise<string> {
  const key      = KEYS[provider];
  const endpoint = ENDPOINTS[provider];
  if (!key) throw new Error(`${provider} key not set — skipping`);

  // Flatten current turn's text parts (these providers are text-only)
  const userText = parts
    .filter(p => typeof p.text === "string")
    .map(p => p.text).join("\n").trim();

  const messages: any[] = [{ role: "system", content: systemInstruction }];
  for (const turn of history) {
    const role = turn.role === "model" ? "assistant" : "user";
    const content = (turn.parts ?? [])
      .filter((p: any) => typeof p.text === "string")
      .map((p: any) => p.text).join("\n");
    if (content) messages.push({ role, content });
  }
  messages.push({ role: "user", content: userText });

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${key}`,
    "Content-Type":  "application/json",
  };
  // OpenRouter likes these headers (optional but recommended)
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/lasma-whatsapp-bot";
    headers["X-Title"]      = "Lasma WhatsApp Bot";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err: any = new Error(`${provider} HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json() as any;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Empty response from ${provider}`);
  return text;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AskResult {
  text:  string;
  model: string;
}

export async function askWithFallback(
  history: any[], parts: any[], systemInstruction: string, hasMedia: boolean
): Promise<AskResult> {
  const errors: string[] = [];

  for (const cand of CANDIDATES) {
    // Skip text-only providers when media is attached
    if (hasMedia && !cand.mediaCapable) continue;
    // Skip a lane if its key isn't configured
    if (cand.provider !== "gemini" && !KEYS[cand.provider]) continue;

    try {
      console.log(`[ai] Trying ${cand.label}...`);
      const text = cand.provider === "gemini"
        ? await callGemini(cand.model, history, parts, systemInstruction)
        : await callOpenAICompat(cand.provider, cand.model, history, parts, systemInstruction);

      console.log(`[ai] ✅ Answered by ${cand.label}`);
      return { text, model: cand.label };

    } catch (err: any) {
      const reason = String(err?.message ?? err).slice(0, 120);
      console.log(`[ai] ${cand.label} failed: ${reason}`);
      errors.push(`${cand.label}: ${reason.slice(0, 70)}`);
      // Whether fallover or hard error, move to the next candidate
      continue;
    }
  }

  throw new Error("All AI models are currently unavailable. Tried:\n" + errors.join("\n"));
}