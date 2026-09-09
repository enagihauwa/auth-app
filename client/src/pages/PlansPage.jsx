import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import BillingShell from "../components/BillingShell.jsx";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Badge from "../components/ui/Badge.jsx";
import Alert from "../components/ui/Alert.jsx";
import { money } from "../lib/format.js";

const PLANS = [
  {
    key: "free",
    name: "Free",
    blurb: "Everything you need to get started.",
    benefits: ["1 project", "Community support"],
  },
  {
    key: "month",
    name: "Pro",
    interval: "month",
    blurb: "Billed monthly, cancel anytime.",
    benefits: ["Unlimited projects", "Priority support"],
  },
  {
    key: "year",
    name: "Pro",
    interval: "year",
    blurb: "Billed yearly, cheapest way to go Pro.",
    benefits: ["Unlimited projects", "Priority support", "Save 17%"],
  },
];

export default function PlansPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const res = await api("/api/billing/summary");
    if (res.ok) setSummary(res.data);
    else setLoadError(res.data?.error ?? "Could not load plans.");
  }

  useEffect(() => {
    load();
  }, []);

  const subscription = summary?.subscription;

  async function startCheckout(interval) {
    setBusy(interval);
    setError("");
    setNotice("");
    const res = await api("/api/billing/checkout", { method: "POST", body: { interval } });
    setBusy(null);
    if (!res.ok) {
      setError(res.data?.error ?? "Could not start checkout. Please try again.");
      return;
    }
    if (res.data?.url) {
      window.location.assign(res.data.url);
      return;
    }
    setNotice("You're already on that plan.");
  }

  async function requestDowngrade() {
    setBusy("downgrade");
    setError("");
    setNotice("");
    const res = await api("/api/billing/downgrade", { method: "POST", body: {} });
    setBusy(null);
    if (!res.ok) {
      setError(res.data?.error ?? "Could not schedule the switch.");
      return;
    }
    setNotice("Switch to monthly is scheduled to apply at the end of your current billing period.");
    load();
  }

  function isCurrent(p) {
    if (p.key === "free") return user?.plan === "free";
    return user?.plan === "pro" && subscription?.interval === p.key;
  }

  function actionFor(p) {
    if (isCurrent(p)) return null;
    if (p.key === "free") {
      if (user?.plan === "pro" && subscription?.cancelAtPeriodEnd) return "cancel-scheduled";
      if (user?.plan === "pro" && subscription?.pendingInterval === "month") return "downgrade-scheduled";
      return null;
    }
    if (user?.plan === "pro") {
      if (subscription?.interval === p.interval) return null;
      if (subscription?.interval === "year" && p.interval === "month") {
        return subscription?.pendingInterval ? "downgrade-scheduled" : "downgrade";
      }
      if (subscription?.interval === "month" && p.interval === "year") {
        return subscription?.pendingInterval ? "upgrade-scheduled" : "checkout";
      }
      return "checkout";
    }
    return "checkout";
  }

  const pricing = summary?.pricing;

  return (
    <BillingShell>
      {loadError ? (
        <Alert variant="error" title={loadError} />
      ) : (
        <>
          {notice ? (
            <Alert variant="success" title="Done">
              {notice}
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="error" title={error}>
              Your payment information has not been changed.
            </Alert>
          ) : null}

          <div className="plans-grid">
            {PLANS.map((p) => {
              const amount =
                p.key === "free" ? 0 : pricing?.pro?.[p.interval] ?? 0;
              const per =
                p.key === "free" ? "forever" : p.interval === "month" ? "per month" : "per year";

              const action = actionFor(p);
              return (
                <Card key={p.key} className={isCurrent(p) ? "plan-card plan-card--current" : "plan-card"}>
                  <div className="plan-card__body">
                    <div className="plan-card__head">
                      <span className="type-title-medium">{p.name}</span>
                      {isCurrent(p) ? <Badge variant="success">Current plan</Badge> : null}
                      {action === "downgrade-scheduled" ||
                      action === "cancel-scheduled" ||
                      action === "upgrade-scheduled" ? (
                        <Badge variant="warning">Scheduled</Badge>
                      ) : null}
                    </div>
                    <p className="muted">{p.blurb}</p>
                    <div className="plan-card__price">
                      {p.key === "free" ? (
                        <>
                          <span style={{ fontSize: "34px", fontWeight: 700 }}>$0</span>
                          <span className="muted"> / {per}</span>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: "34px", fontWeight: 700 }}>
                            {money(amount, pricing?.currency)}
                          </span>
                          <span className="muted"> / {per}</span>
                        </>
                      )}
                    </div>
                    <ul className="plan-card__list">
                      {p.benefits.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>

                    <div className="plan-card__actions">
                      {action === null ? (
                        <Button variant="secondary" block disabled>
                          Current plan
                        </Button>
                      ) : (
                        <Button
                          variant={isCurrent(p) ? "secondary" : "primary"}
                          block
                          loading={busy === p.key || busy === "downgrade"}
                          disabled={busy !== null}
                          onClick={() =>
                            action === "downgrade" ? requestDowngrade() : startCheckout(p.interval)
                          }
                        >
                          {action === "downgrade"
                            ? "Switch to monthly at period end"
                            : action === "downgrade-scheduled" ||
                                action === "cancel-scheduled" ||
                                action === "upgrade-scheduled"
                              ? "Already scheduled"
                              : "Subscribe"}
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <p className="muted center">
            Payments are processed by an external provider. You'll be redirected to a hosted
            checkout, and your plan is activated only after the provider confirms the payment.
          </p>
        </>
      )}
    </BillingShell>
  );
}