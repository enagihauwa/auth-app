import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import BillingShell from "../components/BillingShell.jsx";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Badge from "../components/ui/Badge.jsx";
import Alert from "../components/ui/Alert.jsx";
import { money, dateLabel } from "../lib/format.js";

const CANCEL_REASONS = [
  { label: "Too expensive", value: "too_expensive" },
  { label: "Not using it enough", value: "unused" },
  { label: "Missing a feature", value: "missing_feature" },
  { label: "Switching to another tool", value: "switching" },
  { label: "Other", value: "other" },
];

function SubRow({ label, children }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "16px",
        padding: "10px 0",
        borderBottom: "1px solid var(--color-border, #e6eaf0)",
      }}
    >
      <span className="muted">{label}</span>
      <span style={{ textAlign: "right", fontWeight: 500 }}>{children}</span>
    </div>
  );
}

function planStatus(sub) {
  if (!sub) return { label: "No subscription", tone: "neutral" };
  if (sub.status === "cancelled") return { label: "Cancelled — free plan", tone: "neutral" };
  if (sub.cancelAtPeriodEnd) return { label: "Cancelling at period end", tone: "warning" };
  if (sub.status === "active") return { label: "Active", tone: "success" };
  return { label: sub.status, tone: "neutral" };
}

export default function BillingPage() {
  const { user, setUser } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const res = await api("/api/billing/summary");
    if (res.ok) setSummary(res.data);
    else setLoadError(res.data?.error ?? "Could not load billing details.");
  }

  useEffect(() => {
    load();
  }, []);

  async function confirmCancel() {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await api("/api/billing/cancel", {
      method: "POST",
      body: { reason: reason || null },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data?.error ?? "Could not cancel. Please try again.");
      return;
    }
    setNotice("Your subscription is set to cancel. You keep Pro access until the end of the period.");
    setConfirming(false);
    setUser({ ...user, plan: user?.plan }); // plan unchanged; status flags updated server-side
    load();
  }

  const sub = summary?.subscription;
  const status = planStatus(sub);
  const pricing = summary?.pricing;

  return (
    <BillingShell>
      {loadError ? (
        <Alert variant="error" title={loadError} />
      ) : (
        <>
          {notice ? (
            <Alert variant="success" title="Cancellation scheduled">
              {notice}
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="error" title={error}>
              No changes were made.
            </Alert>
          ) : null}

          <Card>
            <div className="ui-card__body" style={{ display: "grid", gap: "6px" }}>
              <div className="plan-plan" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h2 className="type-title-medium">Your subscription</h2>
                <Badge variant={status.tone}>{status.label}</Badge>
              </div>
              {sub ? (
                <>
                  <SubRow label="Plan">{sub.plan === "pro" ? "Pro" : "Free"}</SubRow>
                  <SubRow label="Interval">
                    {sub.interval === "month" ? "Monthly" : sub.interval === "year" ? "Yearly" : "—"}
                  </SubRow>
                  <SubRow label="Price">
                    {money(sub.amountMinor, sub.currency)} /{" "}
                    {sub.interval === "month" ? "mo" : sub.interval === "year" ? "yr" : ""}
                  </SubRow>
                  <SubRow label="Current period">{"Since " + dateLabel(sub.periodStart)}</SubRow>
                  <SubRow label="Renews / expires">
                    {sub.cancelAtPeriodEnd
                      ? dateLabel(sub.periodEnd) + ", then cancels"
                      : sub.status === "cancelled"
                        ? "—"
                        : dateLabel(sub.periodEnd)}
                  </SubRow>
                  {sub.pendingInterval ? (
                    <SubRow label="Scheduled switch">
                      Switch to {sub.pendingInterval === "year" ? "yearly" : "monthly"} at{" "}
                      {dateLabel(sub.periodEnd)}
                    </SubRow>
                  ) : null}
                  {sub.cancelAtPeriodEnd ? (
                    <SubRow label="Access until">{dateLabel(sub.periodEnd)}</SubRow>
                  ) : null}
                </>
              ) : (
                <div className="stack--sm">
                  <p className="muted">You're on the Free plan.</p>
                  <div>
                    <Link to="/plans" className="ui-btn ui-btn--primary">
                      See plans
                    </Link>
                  </div>
                </div>
              )}

              <div className="billing-actions" style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
                <Link to="/plans" className="ui-btn ui-btn--outline">
                  Change plan
                </Link>
              </div>
            </div>
          </Card>

          {sub?.status === "active" && !sub.cancelAtPeriodEnd ? (
            sub.pendingInterval === "year" ? (
              <Card>
                <div className="ui-card__body" style={{ display: "grid", gap: "14px" }}>
                  <div className="stack--sm">
                    <h2 className="type-title-medium">Upgrade scheduled</h2>
                    <p className="muted">
                      Your yearly upgrade applies at{" "}
                      <strong>{dateLabel(sub.periodEnd)}</strong>. Because you've already paid for
                      that year, cancellation isn't available until it applies.
                    </p>
                  </div>
                </div>
              </Card>
            ) : (
              <Card>
                <div className="ui-card__body" style={{ display: "grid", gap: "14px" }}>
                <div className="stack--sm">
                  <h2 className="type-title-medium">Cancel subscription</h2>
                  <p className="muted">
                    You'll keep Pro access until <strong>{dateLabel(sub.periodEnd)}</strong>, then
                    we'll move you back to the free plan automatically.
                  </p>
                </div>

                {confirming ? (
                  <div className="stack--sm">
                    <label className="type-label-large" htmlFor="cancel-reason">
                      What's the main reason? <span className="muted">(optional)</span>
                    </label>
                    <select
                      id="cancel-reason"
                      className="ui-select"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    >
                      <option value="">Prefer not to say</option>
                      {CANCEL_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: "flex", gap: "12px" }}>
                      <Button variant="error" loading={busy} disabled={busy} onClick={confirmCancel}>
                        Confirm cancellation
                      </Button>
                      <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                        Go back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Button variant="outline" onClick={() => setConfirming(true)}>
                      Cancel subscription
                    </Button>
                  </div>
                )}
              </div>
              </Card>
            )
          ) : null}
        </>
      )}

      <p className="muted center">
        Pricing shown here comes from the server. The provider confirms every charge before plan
        access changes. Plan: {pricing ? `${money(pricing.pro?.month, pricing.currency)}/mo or ${money(pricing.pro?.year, pricing.currency)}/yr` : "—"}.
      </p>
    </BillingShell>
  );
}