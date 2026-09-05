import nodemailer from "nodemailer";
import { config } from "./config.js";

const transport = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

export async function sendEmail({ to, subject, text, html }) {
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
    html,
  });
}

export function verificationEmail(email, code, ttlMinutes) {
  const text = [
    `Your verification code is ${code}.`,
    "",
    `It expires in ${ttlMinutes} minutes.`,
    `If you did not create an account with ${email}, you can ignore this email.`,
    "",
    "Auth App",
  ].join("\n");
  return {
    subject: "Verify your email",
    text,
    html: `<p>Your verification code is</p><p style="font-size:28px;letter-spacing:4px"><strong>${code}</strong></p><p>It expires in ${ttlMinutes} minutes.</p>`,
  };
}

export function resetEmail(email, resetUrl, ttlMinutes) {
  const text = [
    `Someone asked to reset the password for ${email}.`,
    "",
    `Open this link within ${ttlMinutes} minutes: ${resetUrl}`,
    "",
    "If this was not you, you can ignore this email and nothing will change.",
    "",
    "Auth App",
  ].join("\n");
  return {
    subject: "Reset your password",
    text,
    html: `<p>Someone asked to reset the password for <strong>${email}</strong>.</p><p><a href="${resetUrl}">Reset your password</a> (valid for ${ttlMinutes} minutes).</p><p>If this was not you, ignore this email.</p>`,
  };
}