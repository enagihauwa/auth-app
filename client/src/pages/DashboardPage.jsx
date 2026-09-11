import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Badge from "../components/ui/Badge.jsx";
import Stat from "../components/ui/Stat.jsx";
import StatusIndicator from "../components/ui/StatusIndicator.jsx";

function formatDate(value) {
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

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    const res = await api("/api/auth/signout", { method: "POST" });
    setSigningOut(false);
    setUser(null);
    navigate("/signin", { replace: true });
  }

  const memberDate = formatDate(user?.created_at);

  return (
    <div className="auth-screen">
      <main className="dashboard-wrap">
        <header className="ui-header">
          <div className="stack--sm">
            <h1 className="type-headline-small">Dashboard</h1>
            <p className="muted">
              Signed in as <strong>{user?.name}</strong>
            </p>
          </div>
          <Badge variant="success">Verified</Badge>
        </header>

        <Card>
          <div className="ui-card__body" style={{ display: "grid", gap: "20px" }}>
            <div className="stack--sm">
              <h2 className="type-title-medium">Receipts to expense summaries</h2>
              <p className="muted">
                Upload receipt photos, let a background job extract structured expense data through a
                Gemini model, then summarise the result.
              </p>
            </div>
            <div>
              <Button type="button" onClick={() => navigate("/upload")}>
                Upload a receipt
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <div className="ui-card__body" style={{ display: "grid", gap: "20px" }}>
            <div className="stack--sm">
              <h2 className="type-title-medium">Private notes</h2>
              <p className="muted">
                Your own notes space. Every record is scoped to your account, each write is
                validated, and deleting one leaves an audit trail behind.
              </p>
            </div>
            <div>
              <Button type="button" variant="secondary" onClick={() => navigate("/notes")}>
                Open notes
              </Button>
            </div>
          </div>
        </Card>

        <section className="stat-grid">
          <Stat label="Member since" value={memberDate} caption="Account created" />
          <Stat label="Session status" value="Active" caption="Session cookie valid for 7 days" />
          <Stat label="Verification" value="100%" caption="Email confirmed" />
        </section>

        <Card>
          <div className="ui-card__body" style={{ display: "grid", gap: "20px" }}>
            <div className="stack--sm">
              <h2 className="type-title-medium">Account</h2>
              <p className="muted">Details associated with this session.</p>
            </div>
            <div className="stack--sm">
              <p className="type-label-large">Email</p>
              <p className="type-body-medium">{user?.email}</p>
            </div>
            <div className="stack--sm">
              <p className="type-label-large">Status</p>
              <StatusIndicator tone="success">Email verified</StatusIndicator>
            </div>
            <hr className="divider" />
            <div className="flex-row" style={{ gap: "12px" }}>
              <Button
                type="button"
                variant="primary"
                onClick={() => navigate("/billing")}
              >
                Billing &amp; plan
              </Button>
              <Button
                type="button"
                variant="outline"
                loading={signingOut}
                onClick={handleSignOut}
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          </div>
        </Card>

        <p className="muted center">
          This dashboard only renders because your server-side session is valid. Sign out or
          reset your password and it disappears.
        </p>
      </main>
    </div>
  );
}