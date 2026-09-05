import { useState } from "react";
import { Link } from "react-router-dom";
import { forgotSchema } from "../../../shared/schemas.js";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";

export default function ForgotPage() {
  const [values, setValues] = useState({ email: "" });
  const [issues, setIssues] = useState({});
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleChange(e) {
    setValues((v) => ({ ...v, email: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    setSuccess("");
    setIssues({});

    const result = forgotSchema.safeParse(values);
    if (!result.success) {
      setIssues(result.error.flatten().fieldErrors);
      return;
    }

    setSubmitting(true);
    const res = await api("/api/auth/forgot", { method: "POST", body: result.data });
    setSubmitting(false);

    if (res.ok) {
      setSuccess(res.data.message);
    } else {
      setFormError(res.data?.error ?? "Something went wrong.");
      setSuccess("");
    }
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <header className="auth-card__header">
          <h1 className="auth-card__title">Forgot password</h1>
          <p className="auth-card__subtitle">
            Enter your email and we will send a one-time reset link.
          </p>
        </header>

        {success ? <Alert variant="success">{success}</Alert> : null}
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
          <Button type="submit" block loading={submitting}>
            {submitting ? "Sending…" : "Send reset link"}
          </Button>
        </form>

        <p className="link-row">
          <Link to="/signin">Back to sign in</Link>
        </p>
      </Card>
    </div>
  );
}