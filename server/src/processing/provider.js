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
      },
    });
    text = response?.text;
  } catch (err) {
    if (err?.name === "AbortError" || /abort|timeout/i.test(err?.message ?? "")) {
      throw new ProviderTimeoutError(role);
    }
    const detail = String(err?.message ?? err ?? "").slice(0, 300);
    throw new ProviderCallError(`Model request failed (${role}). ${detail}`.trim(), err);
  } finally {
    clearTimeout(timer);
  }

  if (typeof text !== "string" || text.trim() === "") {
    throw new ProviderCallError(`The model returned an empty response (${role}).`);
  }

  try {
    // Models sometimes wrap the JSON in markdown code fences or add prose around it.
    const normalized = text
      .trim()
      .replace(/^```(?:json)?\s*\r?\n?/i, "")
      .replace(/\r?\n?```\s*$/, "");
    return JSON.parse(normalized);
  } catch {
    throw new ProviderCallError(
      `The model returned something that is not valid JSON (${role}).`,
    );
  }
}
