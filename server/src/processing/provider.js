import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { ROLES } from "./prompts.js";

// Thin wrapper around the official @google/genai SDK. Everything the worker needs:
// request structured output with a JSON schema, enforce a hard timeout, translate
// SDK failures into one of three typed errors the service can retry on.

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("The AI slice is not configured yet: paste your GEMINI_API_KEY into server/.env.");
    this.name = "ProviderNotConfiguredError";
  }
}

export class ProviderTimeoutError extends Error {
  constructor(role) {
    super(
      `The model call timed out after ${Math.round(config.processing.modelTimeoutMs / 1000)}s (${role}).`
    );
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderCallError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProviderCallError";
    this.cause = cause;
  }
}

// Deliberately NOT a subclass of ProviderCallError: the service retries those, and
// running out of output budget is deterministic. Retrying spends the same tokens to
// fail the same way, which is what turned a one-line config problem into three
// identical failed attempts.
export class ProviderTruncatedError extends Error {
  constructor(role, { maxOutputTokens, thoughtsTokens, outputTokens }) {
    super(
      `The model ran out of output budget before finishing its JSON (${role}). ` +
        `It spent ${thoughtsTokens} token(s) thinking and ${outputTokens} on the answer, ` +
        `against a ${maxOutputTokens}-token cap. Lower the role's thinkingLevel or raise ` +
        `maxOutputTokens in processing/prompts.js.`
    );
    this.name = "ProviderTruncatedError";
    this.role = role;
  }
}

let client = null;
let configurationChecked = false;

function getClient() {
  if (!configurationChecked) {
    configurationChecked = true;
    if (config.ai.geminiApiKey) {
      client = new GoogleGenAI({ apiKey: config.ai.geminiApiKey });
    }
  }
  if (!client) throw new ProviderNotConfiguredError();
  return client;
}

export function isConfigured() {
  try {
    getClient();
    return true;
  } catch {
    return false;
  }
}

export async function generateStructured({
  role,
  parts,
  userText = "",
}) {
  const roleDef = ROLES[role];
  if (!roleDef) throw new ProviderCallError(`Unknown model role: ${role}`);

  const api = getClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.processing.modelTimeoutMs);

  let text;
  let finishReason;
  let usage = {};
  try {
    const response = await api.models.generateContent({
      model: config.processing.modelId,
      contents: {
        role: "user",
        parts: [...(userText ? [{ text: userText }] : []), ...parts],
      },
      config: {
        abortSignal: controller.signal,
        systemInstruction: roleDef.systemPrompt,
        temperature: roleDef.params.temperature,
        topP: roleDef.params.topP,
        maxOutputTokens: roleDef.params.maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: roleDef.schema.json,
        // Gemini 3 charges reasoning tokens to maxOutputTokens and rejects the
        // older `thinkingBudget` knob outright (400 INVALID_ARGUMENT), so the
        // level is the only supported way to stop thinking from eating the answer.
        ...(roleDef.params.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: roleDef.params.thinkingLevel } }
          : {}),
      },
    });
    text = response?.text;
    finishReason = response?.candidates?.[0]?.finishReason;
    usage = response?.usageMetadata ?? {};
  } catch (err) {
    if (err?.name === "AbortError" || /abort|timeout/i.test(err?.message ?? "")) {
      throw new ProviderTimeoutError(role);
    }
    const detail = String(err?.message ?? err ?? "").slice(0, 300);
    throw new ProviderCallError(`Model request failed (${role}). ${detail}`.trim(), err);
  } finally {
    clearTimeout(timer);
  }

  // Check this before parsing: a budget overrun produces a fragment that is also
  // invalid JSON, and reporting it as a parse failure hides the actual cause.
  if (finishReason === "MAX_TOKENS") {
    throw new ProviderTruncatedError(role, {
      maxOutputTokens: roleDef.params.maxOutputTokens,
      thoughtsTokens: usage.thoughtsTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    });
  }

  if (typeof text !== "string" || text.trim() === "") {
    throw new ProviderCallError(
      `The model returned an empty response (${role}, finishReason=${finishReason ?? "unknown"}).`
    );
  }

  try {
    // Models sometimes wrap the JSON in markdown code fences or add prose around it.
    const normalized = text
      .trim()
      .replace(/^```(?:json)?\s*\r?\n?/i, "")
      .replace(/\r?\n?```\s*$/, "");
    return JSON.parse(normalized);
  } catch (err) {
    // Carry the evidence. Without the snippet and finishReason this failure is
    // indistinguishable from a dozen others and cannot be diagnosed from logs.
    throw new ProviderCallError(
      `The model returned something that is not valid JSON (${role}, ` +
        `finishReason=${finishReason ?? "unknown"}, ${text.length} chars). ` +
        `${err.message}. Response began: ${JSON.stringify(text.slice(0, 200))}`
    );
  }
}
