import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createNoteSchema } from "../../../shared/notes.js";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";
import Input from "../components/ui/Input.jsx";

function issuesFrom(schemaResult) {
  const issues = {};
  for (const issue of schemaResult.error.issues) {
    const key = issue.path[0] ?? "_";
    if (!issues[key]) issues[key] = [];
    issues[key].push(issue.message);
  }
  return issues;
}

export default function NoteCreatePage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ title: "", content: "" });
  const [issues, setIssues] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function handleChange(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setIssues((current) => ({ ...current, [name]: undefined }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const result = createNoteSchema.safeParse(values);
    if (!result.success) {
      setIssues(issuesFrom(result));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const res = await api("/api/notes", { method: "POST", body: result.data });
    setSubmitting(false);
    if (res.ok) {
      navigate(`/notes/${res.data.note.public_id}`, { replace: true });
    } else {
      setFormError(
        res.data?.issues ? undefined : res.data?.error ?? "Something went wrong."
      );
      setIssues(res.data?.issues ?? {});
    }
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <header className="auth-card__header">
          <h1 className="auth-card__title">New note</h1>
          <p className="auth-card__subtitle">
            Saved to your account. Only you can see or open it.
          </p>
        </header>

        {formError ? <Alert variant="error">{formError}</Alert> : null}

        <form onSubmit={handleSubmit} noValidate className="stack">
          <Input
            label="Title"
            name="title"
            value={values.title}
            onChange={handleChange}
            maxLength={120}
            error={issues.title ? issues.title[0] : undefined}
          />
          <div className="ui-field">
            <label className="ui-label" htmlFor="note-content">
              Content
            </label>
            <textarea
              id="note-content"
              name="content"
              className="ui-input"
              rows={10}
              value={values.content}
              onChange={handleChange}
              maxLength={20000}
              aria-invalid={issues.content ? "true" : undefined}
            />
            {issues.content ? (
              <p className="ui-error" role="alert">
                {issues.content[0]}
              </p>
            ) : null}
          </div>
          <Button type="submit" block loading={submitting}>
            {submitting ? "Saving…" : "Save note"}
          </Button>
        </form>

        <p className="muted center">
          <Link to="/notes">Back to your notes</Link>
        </p>
      </Card>
    </div>
  );
}