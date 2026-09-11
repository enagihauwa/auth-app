import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";
import Dialog from "../components/ui/Dialog.jsx";
import EmptyState from "../components/ui/EmptyState.jsx";

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function NoteDetailPage() {
  const { publicId } = useParams();
  const navigate = useNavigate();
  const [note, setNote] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api(`/api/notes/${publicId}`)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setNote(res.data.note);
        } else if (res.status === 403 || res.status === 404) {
          setNotFound(true);
        } else {
          setError(res.data?.error ?? "Could not load this note.");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this note.");
      });
    return () => {
      cancelled = true;
    };
  }, [publicId]);

  async function handleDelete() {
    setDeleting(true);
    const res = await api(`/api/notes/${publicId}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      navigate("/notes", { replace: true });
    } else {
      setConfirming(false);
      setError(res.data?.error ?? "The note could not be deleted.");
    }
  }

  if (notFound) {
    return (
      <div className="auth-screen">
        <Card className="auth-card">
          <div className="ui-card__body">
            <EmptyState
              title="Note not found"
              description="Either it never existed or it belongs to another account — you are never shown a note that is not yours."
            />
            <div style={{ marginTop: "16px" }}>
              <Button variant="outline" onClick={() => navigate("/notes")}>
                Back to your notes
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <main className="notes-shell">
        <header className="ui-header">
          <div className="stack--sm">
            <h1 className="type-headline-small">Note</h1>
            <p className="muted">
              <Link to="/notes">Your notes</Link>
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => navigate("/notes/new")}>
            New note
          </Button>
        </header>

        {error ? <Alert title="Something went wrong">{error}</Alert> : null}

        {note === null && !notFound ? (
          <Card>
            <div className="ui-card__body">
              <p className="muted">Loading note…</p>
            </div>
          </Card>
        ) : null}

        {note ? (
          <>
            <Card>
              <div className="ui-card__body" style={{ display: "grid", gap: "16px" }}>
                <div className="stack--sm">
                  <h2 className="type-headline-small">{note.title}</h2>
                  <p className="muted">
                    Created {formatDate(note.created_at)} · Updated {formatDate(note.updated_at)}
                  </p>
                </div>
                <p className="note-body">{note.content}</p>
              </div>
            </Card>

            <Card>
              <div className="ui-card__body" style={{ display: "grid", gap: "16px" }}>
                <div className="stack--sm">
                  <p className="type-label-large">Private link</p>
                  <p className="muted">
                    This note is addressed by a random identifier, never by a database id. That id is the
                    only thing the server uses to look it up, and it only resolves for your account.
                  </p>
                </div>
                <p className="note-public-link">/notes/{note.public_id}</p>
                <hr className="divider" />
                <div className="flex-row" style={{ gap: "12px", justifyContent: "flex-end" }}>
                  <Button variant="ghost" onClick={() => navigate("/notes")}>
                    Back
                  </Button>
                  <Button variant="error" onClick={() => setConfirming(true)}>
                    Delete note
                  </Button>
                </div>
              </div>
            </Card>

            <Dialog
              open={confirming}
              onClose={() => setConfirming(false)}
              title="Delete this note?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button variant="error" loading={deleting} disabled={deleting} onClick={handleDelete}>
                    {deleting ? "Deleting…" : "Delete"}
                  </Button>
                </>
              }
            >
              <p className="type-body-medium">
                “{note.title}” will be permanently removed from your account. Deleting this note writes a
                line to the server’s audit log so the action is always traceable.
              </p>
            </Dialog>
          </>
        ) : null}
      </main>
    </div>
  );
}