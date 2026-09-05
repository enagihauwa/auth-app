import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signupFormSchema } from "../../../shared/schemas.js";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";

export default function SignupPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ name: "", email: "", password: "", confirmPassword: "" });
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

    const result = signupFormSchema.safeParse(values);
    if (!result.success) {
      setIssues(result.error.flatten().fieldErrors);
      return;
    }
    if (values.password !== values.confirmPassword) {
      setIssues({ confirmPassword: ["Passwords do not match."] });
      return;
    }

    setSubmitting(true);
    const { email, password, name } = result.data;
    const res = await api("/api/auth/signup", { method: "POST", body: { email, password, name } });
    setSubmitting(false);

    if (res.ok) {
      navigate(`/verify?email=${encodeURIComponent(email)}`);
    } else {
      setFormError(res.data?.error ?? "Something went wrong.");
    }
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <header className="auth-card__header">
          <h1 className="auth-card__title">Create account</h1>
          <p className="auth-card__subtitle">A verification code will be sent to your email.</p>
        </header>

        {formError ? <Alert variant="error">{formError}</Alert> : null}

        <form onSubmit={handleSubmit} noValidate className="stack">
          <Input
            label="Full name"
            name="name"
            autoComplete="name"
            value={values.name}
            onChange={handleChange}
            error={issues.name ? issues.name[0] : undefined}
          />
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
            autoComplete="new-password"
            value={values.password}
            onChange={handleChange}
            error={issues.password ? issues.password[0] : undefined}
          />
          <Input
            label="Confirm password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={values.confirmPassword}
            onChange={handleChange}
            error={issues.confirmPassword ? issues.confirmPassword[0] : undefined}
          />
          <Button type="submit" block loading={submitting}>
            {submitting ? "Creating…" : "Create account"}
          </Button>
        </form>

        <p className="link-row">
          <Link to="/signin">Already have an account? Sign in</Link>
        </p>
      </Card>
    </div>
  );
}