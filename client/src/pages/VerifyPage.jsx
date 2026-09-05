import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { verifySchema, resendSchema } from "../../../shared/schemas.js";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";

const COOLDOWN_SECONDS = 60;

function useCountdown(active) {
  const [remaining, setRemaining] = useState(active ? COOLDOWN_SECONDS : 0);
  const timer = useRef(null);

  useEffect(() => {
    if (!active) return;
    setRemaining(COOLDOWN_SECONDS);
    timer.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(timer.current);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer.current);
  }, [active]);

  return remaining;
}

export default function VerifyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refresh } = useAuth();

  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [needsEmail, setNeedsEmail] = useState(!searchParams.get("email"));
  const [issues, setIssues] = useState({});
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldownActive, setCooldownActive] = useState(false);

  const cooldown = useCountdown(cooldownActive);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    setIssues({});

    const result = verifySchema.safeParse({ email, code });
    if (!result.success) {
      setIssues(result.error.flatten().fieldErrors);
      return;
    }

    setSubmitting(true);
    const res = await api("/api/auth/verify", { method: "POST", body: result.data });
    setSubmitting(false);

    if (res.ok) {
      setSuccess("Email verified.");
      await refresh();
      navigate("/dashboard");
    } else {
      setFormError(res.data?.error ?? "Something went wrong.");
    }
  }

  async function handleResend() {
    setFormError("");
    setIssues({});

    const result = resendSchema.safeParse({ email });
    if (!result.success) {
      setIssues(result.error.flatten().fieldErrors);
      return;
    }

    setResending(true);
    const res = await api("/api/auth/resend", { method: "POST", body: result.data });
    setResending(false);

    if (res.ok) {
      setCooldownActive(true);
      setSuccess("A new code is on its way.");
    } else {
      setFormError(res.data?.error ?? "Something went wrong.");
    }
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <header className="auth-card__header">
          <h1 className="auth-card__title">Verify your email</h1>
          <p className="auth-card__subtitle">
            Enter the six-digit code we sent. It expires in 15 minutes.
          </p>
        </header>

        {success ? <Alert variant="success">{success}</Alert> : null}
        {formError ? <Alert variant="error">{formError}</Alert> : null}

        <form onSubmit={handleSubmit} noValidate className="stack">
          {needsEmail ? (
            <Input
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={issues.email ? issues.email[0] : undefined}
            />
          ) : null}
          <Input
            label="Verification code"
            name="code"
            variant="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            error={issues.code ? issues.code[0] : undefined}
          />
          <Button type="submit" block loading={submitting}>
            {submitting ? "Verifying…" : "Verify email"}
          </Button>
        </form>

        <div className="resend-row">
          {cooldown > 0 ? (
            <span className="resend-timer">Resend available in {cooldown}s</span>
          ) : (
            <Button type="button" variant="ghost" loading={resending} onClick={handleResend}>
              {resending ? "Sending…" : "Resend code"}
            </Button>
          )}
        </div>

        <p className="link-row">
          <Link to="/signin">Back to sign in</Link>
        </p>
      </Card>
    </div>
  );
}