// Dev mail catcher. Starts Mailpit bound to loopback, with a persistent mailbox,
// and refuses to hand the stack a mail server it has not positively identified.
//
// Run on its own with `npm run dev:mail`, or as part of `npm run dev`.
// Pass --fresh to delete the stored mailbox before starting.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Read the same .env the server reads, so SMTP_PORT can never drift between the
// catcher and the app that is supposed to be talking to it.
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // Optional: the defaults below already match .env.example.
}

const HOST = "127.0.0.1";
// Both spellings of loopback, because which one "localhost" resolves to first
// varies by machine and Mailpit must be reachable either way.
const LOOPBACK = ["127.0.0.1", "[::1]"];
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 1025);
const UI_PORT = Number(process.env.MAILPIT_UI_PORT ?? 8025);
const UI_URL = `http://localhost:${UI_PORT}`;

const binary = path.join(root, "tools", "mailpit", process.platform === "win32" ? "mailpit.exe" : "mailpit");
const database = path.join(root, "tools", "mailpit", "mailpit.db");

/** Ask the candidate on the UI port whether it is actually Mailpit. */
async function identify() {
  for (const host of LOOPBACK) {
    try {
      const res = await fetch(`http://${host}:${UI_PORT}/api/v1/info`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) continue;
      const info = await res.json();
      if (info?.Version) return info;
    } catch {
      // Try the other loopback family before giving up.
    }
  }
  return null;
}

function isPortOpen(port) {
  // Open on either loopback family counts as taken: binding would fail anyway.
  return Promise.all(LOOPBACK.map((host) => connects(port, host))).then((r) => r.some(Boolean));
}

function connects(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (open) => {
      sock.destroy();
      resolve(open);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

function banner(info) {
  console.log(`[mail] Mailpit ${info.Version} ready`);
  console.log(`[mail]   SMTP    ${HOST}:${SMTP_PORT}   <- point SMTP_HOST / SMTP_PORT here`);
  console.log(`[mail]   inbox   ${UI_URL}`);
  console.log(`[mail]   store   ${info.Database} (${info.Messages} message(s) kept across restarts)`);
}

if (process.argv.includes("--fresh")) {
  if (await identify()) {
    console.error("[mail] --fresh refused: Mailpit is already running. Stop it first.");
    process.exit(1);
  }
  // SQLite keeps -wal / -shm siblings next to the database file.
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${database}${suffix}`, { force: true });
  }
  console.log("[mail] --fresh: stored mailbox deleted");
}

const running = await identify();
if (running) {
  console.log(`[mail] Mailpit ${running.Version} is already running — reusing it`);
  banner(running);
  await new Promise(() => {}); // hold the slot so `npm run dev` keeps the other panes alive
}

// Nothing answered as Mailpit. If the ports are busy anyway, something else owns
// them — say so instead of letting the app post mail into a stranger.
for (const [label, port] of [["SMTP", SMTP_PORT], ["web UI", UI_PORT]]) {
  if (await isPortOpen(port)) {
    console.error(`[mail] port ${port} (${label}) is in use by a process that is not Mailpit.`);
    console.error(`[mail] Mail sent by the app would disappear into it. Free the port, then retry:`);
    console.error(`[mail]   netstat -ano | findstr :${port}`);
    process.exit(1);
  }
}

if (!fs.existsSync(binary)) {
  console.error(`[mail] Mailpit binary not found at ${binary}`);
  console.error(`[mail] Download it from https://github.com/axllent/mailpit/releases and unzip it there.`);
  process.exit(1);
}

const child = spawn(
  binary,
  [
    // Dual-stack ([::]) on purpose. This machine resolves "localhost" to ::1
    // before 127.0.0.1, so an IPv4-only bind makes http://localhost:8025 hit a
    // refused connection on ::1 -- browsers then either stall on the fallback or
    // show the UI as dead. A [::] socket accepts ::1 and 127.0.0.1 alike, so every
    // spelling of localhost works for both the UI and SMTP.
    "--smtp", `[::]:${SMTP_PORT}`,
    "--listen", `[::]:${UI_PORT}`,
    // Without this the mailbox lives in a randomly-named temp file and every
    // restart silently loses every message received so far.
    "--database", database,
    // Mailpit reverse-resolves each connecting client by default; on Windows that
    // lookup can stall for seconds before the message shows up.
    "--smtp-disable-rdns",
    // Skip the startup call to GitHub for release info.
    "--disable-version-check",
    "--label", "Assesment 1 dev",
  ],
  { stdio: "inherit", windowsHide: false }
);

child.on("error", (err) => {
  console.error(`[mail] failed to start Mailpit: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill());
}

// Poll until the API answers, so `npm run dev` prints a usable banner rather than
// leaving you guessing whether the catcher came up.
for (let attempt = 0; attempt < 40; attempt++) {
  const info = await identify();
  if (info) {
    banner(info);
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
