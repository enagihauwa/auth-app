import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import BillingShell from "../components/BillingShell.jsx";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";
import { money } from "../lib/format.js";

const POLL_MS = 2000;
const MAX_ATTEMPTS = 30;

export default function ReturnPage() {
  const [params] = useSearchParams();
  const reference = params.get("ref") ?? "";
  const initialStatus = params.get("status") ?? "success";
  const { refresh } = useAuth();

  const [phase, setPhase] = useState(initialStatus === "success" ? "waiting" : "failed");
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [gaveUp, setGaveUp] = useState(false);

  const attempts = useRef(0);

  useEffect(() => {
    if (phase !== "waiting" || !reference) return undefined;
    let cancelled = false;
    let timer = null;

    async function check() {
      const res = await api(`/api/billing/session/${encodeURIComponent(reference)}`);
      if (cancelled) return;
      if (!res.ok) {
        attempts.current += 1;
        if (attempts.current >= MAX_ATTEMPTS) {
          setGaveUp(true);
          setPhase("unknown");
          return;
        }
        timer = setTimeout(check, POLL_MS);
        return;
      }
      const s = res.data.session;
      attempts.current += 1;
      if (s.status === "completed") {
        setSession(s);
        setPhase("done");
        refresh();
        return;
      }
      if (s.status === "failed") {
        setSession(s);
        setPhase("failed");
        return;
      }
      if (s.status === "expired" || attempts.current >= MAX_ATTEMPTS) {
        setGaveUp(true);
        setPhase("unknown");
        return;
      }
      timer = setTimeout(check, POLL_MS);
    }

    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reference, phase, refresh]);

  return (
    <BillingShell>
      <Card>
        <div className="ui-card__body" style={{ display: "grid", gap: "18px" }}>
          <div className="stack--sm">
            <h2 className="type-title-medium">Payment confirmation</h2>
            <p className="muted">
              Reference <strong>{reference || "—"}</strong>
            </p>
          </div>

          {phase === "waiting" ? (
            <div className="stack--sm">
              <p>
                <span className="ui-spinner" aria-hidden="true" />{" "}
                Waiting for the provider to confirm your payment…
              </p>
              <p className="muted">
                Your Pro plan activates the moment payment is verified — keep this tab open.
              </p>
            </div>
          ) : null}

          {phase === "done" ? (
            <>
              <Alert variant="success" title="Payment confirmed">
                Your payment of {money(session?.amountMinor, session?.currency)} was verified and
                your plan is now active.
              </Alert>
              <div style={{ display: "flex", gap: "12px" }}>
                <Link to="/billing" className="ui-btn ui-btn--primary">
                  View billing
                </Link>
                <Link to="/dashboard" className="ui-btn ui-btn--outline">
                  Go to dashboard
                </Link>
              </div>
            </>
          ) : null}

          {phase === "failed" ? (
            <>
              <Alert variant="error" title="Payment was not completed">
                The payment didn't go through, so no charge was made. You can try again whenever
                you're ready.
              </Alert>
              <div style={{ display: "flex", gap: "12px" }}>
                <Link to="/plans" className="ui-btn ui-btn--primary">
                  Choose a plan
                </Link>
              </div>
            </>
          ) : null}

          {phase === "unknown" ? (
            <>
              <Alert variant="warning" title="Still waiting on the provider">
                {gaveUp
                  ? "Your payment hasn't been confirmed yet. No money has been taken unless the provider confirms — check your billing page shortly for the final status."
                  : "Something is blocking confirmation."}
              </Alert>
              <div style={{ display: "flex", gap: "12px" }}>
                <Link to="/billing" className="ui-btn ui-btn--primary">
                  Go to billing
                </Link>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Card>

      <p className="muted center">
        If anything went wrong just now, reload this page and we'll show you the latest status from
        the provider.
      </p>
    </BillingShell>
  );
}