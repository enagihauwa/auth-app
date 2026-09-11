import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import EmptyState from "../components/ui/EmptyState.jsx";

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function NotesPage() {
  const navigate = useNavigate();
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api("/api/notes")
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setNotes(res.data.notes);
        } else {
          setError(res.data?.error ?? "Could not load your notes.");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your notes.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="auth-screen">
      <main className="dashboard-wrap">
        <header className="ui-header">
          <div className="stack--sm">
            <h1 className="type-headline-small">Your notes</h1>
            <p className="muted">Private to your account. Nothing here is ever visible to anyone else.</p>
          </div>
          <Button type="button" onClick={() => navigate("/notes/new")}>
            New note
          </Button>
        </header>

        {error ? (
          <Card>
            <div className="ui-card__body">
              <p className="type-body-medium">{error}</p>
              <div>
                <Button variant="outline" onClick={() => navigate("/dashboard")}>
                  Back to dashboard
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {notes === null && !error ? (
          <Card>
            <div className="ui-card__body">
              <p className="muted">Loading your notes…</p>
            </div>
          </Card>
        ) : null}

        {notes !== null && notes.length === 0 && !error ? (
          <Card>
            <div className="ui-card__body">
              <EmptyState
                title="No notes yet"
                description="Create your first note — it stays private to your account and is only reachable through a URL that carries a random identifier, never a database id."
              >
                <Button type="button" onClick={() => navigate("/notes/new")}>
                  Write your first note
                </Button>
              </EmptyState>
            </div>
          </Card>
        ) : null}

        {notes !== null && notes.length > 0 ? (
          <div style={{ display: "grid", gap: "12px" }}>
            {notes.map((note) => (
              <Card key={note.public_id}>
                <Link
                  to={`/notes/${note.public_id}`}
                  style={{ display: "block", padding: "18px 20px", color: "inherit" }}
                >
                  <div className="flex-row" style={{ justifyContent: "space-between", alignItems: "center", gap: "16px" }}>
                    <div className="stack--sm" style={{ minWidth: 0 }}>
                      <p className="type-title-medium" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {note.title}
                      </p>
                      <p className="muted">{formatDate(note.created_at)}</p>
                    </div>
                    <span aria-hidden="true">→</span>
                  </div>
                </Link>
              </Card>
            ))}
          </div>
        ) : null}

        <p className="muted center">
          <Link to="/dashboard">Back to dashboard</Link>
        </p>
      </main>
    </div>
  );
}