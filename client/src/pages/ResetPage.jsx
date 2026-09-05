import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resetFormSchema } from "../../../shared/schemas.js";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";

export default function ResetPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [values, setValues] = useState({ password: "", confirmPassword: "" });
  const [issues, setIssues] = useState({});
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setValues((v) => ({ ...v, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    setSuccess("");
    setIssues({});

    const result = resetFormSchema.safeParse({ token, password: values.password, confirmPassword: values.confirmPassword });
    if (!result.success) {
      setIssues(result.error.flatten().fieldErrors);
      return;
    }
    if (values.password !== values.confirmPassword) {
      setIssues({ confirmPassword: ["Passwords do not match."] });
      return;
    }

    setSubmitting(true);
    const res = await api("/api/auth/reset", {
      method: "POST",
      body: { token, password: values.password },
    });
    setSubmitting(false);

    if (res.ok) {
      setSuccess("Password reset. You can sign in with your new password.");
      setValues({ password: "", confirmPassword: "" });
    } else {
      setFormError(res.data?.error ?? "Something went wrong.");
    }
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <header className="auth-card__header">
          <h1 className="auth-card__title">Reset password</h1>
          <p className="auth-card__subtitle">Choose a new password for your account.</p>
        </header>

        {!token ? (
          <Alert variant="error">This link is incomplete. Request a new one below.</Alert>
        ) : null}
        {success ? <Alert variant="success">{success}</Alert> : null}
        {formError ? <Alert variant="error">{formError}</Alert> : null}

        {token ? (
          <form onSubmit={handleSubmit} noValidate className="stack">
            <Input
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={handleChange}
              error={issues.password ? issues.password[0] : undefined}
            />
            <Input
              label="Confirm new password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={values.confirmPassword}
              onChange={handleChange}
              error={issues.confirmPassword ? issues.confirmPassword[0] : undefined}
            />
            <Button type="submit" block loading={submitting}>
              {submitting ? "Resetting…" : "Reset password"}
            </Button>
          </form>
        ) : null}

        <p className="link-row">
          <Link to="/forgot">Request a new link</Link>
          <Link to="/signin">Back to sign in</Link>
        </p>
      </Card>
    </div>
  );
}