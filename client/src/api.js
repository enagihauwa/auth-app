export async function api(path, options = {}) {
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = isFormData ? {} : { "Content-Type": "application/json" };
  const body = isFormData
    ? options.body
    : options.body
      ? JSON.stringify(options.body)
      : undefined;
  const res = await fetch(path, {
    credentials: "same-origin",
    headers,
    ...options,
    body,
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