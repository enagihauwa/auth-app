import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import Button from "./ui/Button.jsx";
import Badge from "./ui/Badge.jsx";

export default function BillingShell({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await api("/api/auth/signout", { method: "POST" });
    setSigningOut(false);
    setUser(null);
    navigate("/signin", { replace: true });
  }

  const navLinkClass = ({ isActive }) => (isActive ? "billing-nav__link billing-nav__link--active" : "billing-nav__link");

  return (
    <div className="auth-screen">
      <main className="billing-wrap">
        <header className="ui-header">
          <div className="stack--sm">
            <h1 className="type-headline-small">Acme</h1>
            <p className="muted">
              Signed in as <strong>{user?.name}</strong>
            </p>
          </div>
          <Badge variant={user?.plan === "pro" ? "success" : "neutral"}>
            {user?.plan === "pro" ? "Pro" : "Free"} plan
          </Badge>
        </header>

        <nav className="billing-nav" aria-label="Subscription">
          <NavLink to="/plans" className={navLinkClass}>
            Plans
          </NavLink>
          <NavLink to="/billing" className={navLinkClass}>
            Billing
          </NavLink>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="outline" loading={signingOut} onClick={handleSignOut}>
            Sign out
          </Button>
        </nav>

        <div style={{ display: "grid", gap: "20px" }}>{children}</div>
      </main>
    </div>
  );
}