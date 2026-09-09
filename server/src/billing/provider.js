import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function checkoutUrl(reference) {
  return `${config.serverUrl}/pay/${reference}`;
}

export function returnUrl(reference, status) {
  return `${config.appUrl}/return?ref=${reference}&status=${status}`;
}

export function signWebhookPayload(rawBody, secret = config.billing.providerWebhookSecret) {
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return `t=${ts},v1=${signature}`;
}

export function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  secret = config.billing.providerWebhookSecret,
  now = Math.floor(Date.now() / 1000),
  maxAgeSec = 5 * 60,
}) {
  if (!rawBody || typeof signatureHeader !== "string") return false;
  const entries = {};
  for (const pair of signatureHeader.split(",")) {
    const [k, ...rest] = pair.split("=");
    entries[k] = rest.join("=");
  }
  const ts = Number(entries.t);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeSec) return false;

  const expected = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  const supplied = entries.v1 ?? "";
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(
    supplied.length === expected.length ? supplied : "?".repeat(expected.length),
    "utf8"
  );
  return timingSafeEqual(a, b);
}