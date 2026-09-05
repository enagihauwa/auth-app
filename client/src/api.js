export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty body
  }
  return { ok: res.ok, status: res.status, data };
}

export function fieldErrors(issues = {}) {
  return (field) => issues[field]?.[0];
}