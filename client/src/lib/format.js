export function money(minor, currency = "USD") {
  const symbol = { USD: "$" }[currency] ?? `${currency} `;
  return `${symbol}${(Number(minor) || 0) / 100}`;
}

export function dateLabel(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}