import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signinSchema } from "../../../shared/schemas.js";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";

export default function SigninPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [values, setValues] = useState({ email: "", password: "" });
  const [issues, setIssues] = useState({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setValues((v) => ({ ...v, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    setIssues({});

    const result = signinSchema.safeParse(values);
    if (!result.success) {
      setIssues(result.error.flatten().fieldErrors);
      return;
    }

    setSubmitting(true);
    const res = await api("/api/auth/signin", {
      method: "POST",
      body: result.data,
    });
    setSubmitting(false);

    if (res.data?.needsVerification) {
      navigate(`/verify?email=${encodeURIComponent(res.data.email)}`);
      return;
    }
    if (res.ok) {
      await refresh();
      navigate("/dashboard");
    } else {
      setFormError(res.data?.error ?? "Something went wrong.");
    }
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <header className="auth-card__header">
          <h1 className="auth-card__title">Sign in</h1>
          <p className="auth-card__subtitle">Welcome back. Enter your details to continue.</p>
        </header>

        {formError ? <Alert variant="error">{formError}</Alert> : null}

        <form onSubmit={handleSubmit} noValidate className="stack">
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={handleChange}
            error={issues.email ? issues.email[0] : undefined}
          />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={values.password}
            onChange={handleChange}
            error={issues.password ? issues.password[0] : undefined}
          />
          <Button type="submit" block loading={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="link-row">
          <Link to="/forgot">Forgot password?</Link>
          <Link to="/signup">Create account</Link>
        </p>
      </Card>
    </div>
  );
}