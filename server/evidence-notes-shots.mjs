import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "./src/db.js";

const CHROME = process.env.CHROME_BIN || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const API = "http://localhost:3000";
const APP = "http://localhost:5173";
const ROOT = join(process.cwd(), "..");
const SHOT_DIR = join(ROOT, "evidence", "shots");
const DEBUG_PORT = 9226;
const PROFILE = join(process.cwd(), ".chrome-shot-profile-notes");

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

const html = (rows) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; margin: 24px; background: #f6f7f9; color: #1a1d21; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p { color: #646b74; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e4e7ec; vertical-align: top; }
  th { background: #eef1f5; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #3d454e; }
  .uuid { color: #8a5b00; }
  code { background: #f1f3f5; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style></head><body>
<h1>note_delete_audit</h1>
<p>The most recent delete rows on the live database — every delete of a note writes one of these in the same transaction.</p>
<table>
<tr><th>id</th><th>note_id (db)</th><th>note_public_id</th><th>title</th><th>deleted_by (user)</th><th>deleted_at (utc)</th></tr>
${rows.map((r) => `<tr>
  <td>${r.id}</td><td>${r.noteId}</td><td class="uuid">${r.notePublicId}</td><td>${r.title}</td>
  <td class="uuid">${r.deletedBy}</td><td>${r.deletedAt}</td>
</tr>`).join("\n")}
</table>
<p>Note how the public id shown to the client (and used in /notes/&lt;publicId&gt; URLs) is a separate UUID column from the
row's numeric database id. Deleting <em>any</em> note — even the reject-then-retry loop above — records who did it and when.</p>
</body></html>`;

(async () => {
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`, "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });

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

  const email = `notes_shot_${Date.now()}@test.local`;
  const password = "Passw0rd!x";
  await req("/api/auth/signup", { method: "POST", body: { name: "Notes Screenshot", email, password } });
  const u = await prisma.user.findFirst({ where: { email } });
  await prisma.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
  const signin = await req("/api/auth/signin", { method: "POST", body: { email, password } });
  const sid = signin.setCookie.split(";")[0];
  const sidValue = sid.slice("sid=".length);

  await cdp.send("Network.setCookie", {
    url: APP + "/", name: "sid", value: sidValue,
    httpOnly: true, path: "/", sameSite: "Lax",
  });

  const c1 = await req("/api/notes", { method: "POST", body: { title: "Meeting notes", content: "Decide on Q3 budget split by Thursday." }, cookie: sid });
  const c2 = await req("/api/notes", { method: "POST", body: { title: "Research links", content: "1. Prisma driver adapters\n2. React router loaders\n3. Express 5 changes" }, cookie: sid });
  const pid2 = c2.data.note.public_id;

  await goto(`${APP}/notes`);
  await screenshot(cdp, "notes-01-list-public-ids");

  await goto(`${APP}/notes/${pid2}`);
  await screenshot(cdp, "notes-02-detail-public-url");

  const del = await req(`/api/notes/${c1.data.note.public_id}`, { method: "DELETE", cookie: sid });
  console.log("deleted c1 ->", del.status);

  const auditRows = await prisma.noteDeleteAudit.findMany({
    take: 5,
    orderBy: { deletedAt: "desc" },
    select: { id: true, noteId: true, notePublicId: true, title: true, deletedBy: true, deletedAt: true },
  });
  const rows = auditRows.map((a) => ({
    id: Number(a.id),
    noteId: Number(a.noteId),
    notePublicId: a.notePublicId,
    title: a.title,
    deletedBy: a.deletedBy,
    deletedAt: a.deletedAt.toISOString().replace("T", " ").slice(0, 19),
  }));
  writeFileSync(join(ROOT, "evidence", "notes-audit-log.html"), html(rows));
  await goto(`file:///${join(ROOT, "evidence", "notes-audit-log.html").replace(/\\/g, "/")}`);
  await sleep(800);
  await screenshot(cdp, "notes-03-audit-log");

  console.log("created:", c1.data.note.public_id, c2.data.note.public_id);
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});