import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { prisma } from "./src/db.js";

const CHROME = process.env.CHROME_BIN || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const API = "http://localhost:3000";
const APP = "http://localhost:5173";
const SHOT_DIR = join(process.cwd(), "evidence", "shots");
const DEBUG_PORT = 9225;
const PROFILE = join(process.cwd(), ".chrome-shot-profile");

mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, { method = "GET", body, cookie } = {}) {
  const opts = { method, headers: { "content-type": "application/json" }, redirect: "manual" };
  if (cookie) opts.headers.cookie = cookie;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const setCookie = res.headers.get("set-cookie");
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, setCookie };
}

// --- CDP plumbing ---------------------------------------------
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, ws };
}

async function screenshot(cdp, name) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(shot.data, "base64"));
  console.log("shot:", name);
}

// --- Main ------------------------------------------------------
(async () => {
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`, "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });

  // wait for the debugging endpoint
  let target;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(APP + "/")}`, { method: "PUT" });
      if (res.ok) { target = await res.json(); break; }
    } catch { /* retry */ }
  }
  if (!target) throw new Error("Chrome debugging endpoint not ready");

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");

  async function ready(tries = 40) {
    for (let i = 0; i < tries; i++) {
      const r = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r.result.value === "complete") return;
      await sleep(200);
    }
  }
  async function goto(url) {
    await cdp.send("Page.navigate", { url });
    await ready();
    await sleep(1500);
  }
  async function click(selector) {
    await cdp.send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
      returnByValue: true,
    });
  }

  // 1. fresh user
  const email = `shot_${Date.now()}@test.local`;
  const password = "Passw0rd!x";
  await req("/api/auth/signup", { method: "POST", body: { name: "Screenshot Tester", email, password } });
  const u = await prisma.user.findFirst({ where: { email } });
  await prisma.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
  const signin = await req("/api/auth/signin", { method: "POST", body: { email, password } });
  const sid = signin.setCookie.split(";")[0];
  const sidValue = sid.slice("sid=".length);
  console.log("user:", email);

  // inject session cookie into the browser (host-specific to localhost)
  await cdp.send("Network.setCookie", {
    url: APP + "/", name: "sid", value: sidValue,
    httpOnly: true, path: "/", sameSite: "Lax",
  });

  // 2. /plans free
  await goto(`${APP}/plans`);
  await screenshot(cdp, "01-plans-free");

  // 3. start monthly checkout + show provider page
  const ckM = await req("/api/billing/checkout", { method: "POST", body: { interval: "month" }, cookie: sid });
  await goto(`${API}/pay/${ckM.data.reference}`);
  await screenshot(cdp, "02-provider-checkout-monthly");

  // 4. pay -> return page (polls to completed)
  await click('.pay');
  await ready();
  await cdp.send("Runtime.evaluate", { expression: `document.title`, returnByValue: true });
  await sleep(6000); // let ReturnPage poll complete the webhook->plan change
  await screenshot(cdp, "03-return-confirmed");

  // 5. /billing monthly active, open the cancel confirm UI
  await goto(`${APP}/billing`);
  await screenshot(cdp, "04-billing-monthly-active");
  await cdp.send("Runtime.evaluate", {
    expression: `(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel subscription'); if (!el) return false; el.click(); return true; })()`,
    returnByValue: true,
  });
  await sleep(700);
  await screenshot(cdp, "05-billing-cancel-confirm");

  // 6. upgrade to yearly (charged now, applies at period end) through the provider
  const ckY = await req("/api/billing/checkout", { method: "POST", body: { interval: "year" }, cookie: sid });
  await goto(`${API}/pay/${ckY.data.reference}`);
  await screenshot(cdp, "06-provider-checkout-yearly-upgrade");
  await click('.pay');
  await ready();
  await sleep(6000);

  // 7. /plans shows the monthly plan as current with the yearly upgrade scheduled
  await goto(`${APP}/plans`);
  await screenshot(cdp, "07-plans-monthly-upgrade-scheduled");
  // 8. /billing shows the monthly period continuing and the scheduled yearly switch
  await goto(`${APP}/billing`);
  await screenshot(cdp, "08-billing-monthly-upgrade-scheduled");

  console.log("\nDONE — screenshots in:", SHOT_DIR);
  cdp.ws.close();
  chrome.kill();
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("DRIVER FAILED:", err);
  process.exit(1);
});