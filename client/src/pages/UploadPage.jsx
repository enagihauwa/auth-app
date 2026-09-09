import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../App.jsx";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Alert from "../components/ui/Alert.jsx";
import { formatBytes, readFileSizeMb } from "../lib/money.js";

// Mirrors server/src/config.js -> processing.upload (kept in sync by hand; the server
// rejects anything that slips past these, these just make the UX honest up front).
export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const MAX_FILES = 6;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPT_HINT = ACCEPTED_MIME_TYPES.join(",").replace(/image\//g, "").replace(/\//g, "");

function validateFile(file) {
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return `"${file.name}" is not an accepted type (${file.type || "unknown"}) — use JPG, PNG, WEBP or PDF.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `"${file.name}" is ${readFileSizeMb(file.size)} MB — the limit is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

export default function UploadPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  const { accepted, rejected } = useMemo(() => {
    const accepted = [];
    const rejected = [];
    for (const file of selected) {
      const issue = validateFile(file);
      (issue ? rejected : accepted).push({ file, issue });
    }
    return { accepted, rejected };
  }, [selected]);

  function addFiles(fileList) {
    setError(null);
    const next = [...selected, ...Array.from(fileList)].slice(0, MAX_FILES * 4);
    setSelected(next);
  }

  function removeFile(index) {
    setSelected((current) => current.filter((_, i) => i !== index));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (accepted.length === 0) {
      setError("Choose at least one valid receipt file (JPG, PNG, WEBP or PDF, 5 MB or smaller).");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const body = new FormData();
      for (const { file } of accepted) body.append("files", file);
      const res = await api("/api/processing/upload", { method: "POST", body });
      if (!res.ok) {
        setError(res.data?.error ?? "Upload failed.");
        return;
      }
      navigate(`/jobs/${res.data.job.id}`);
    } catch {
      setError("Could not reach the server. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <main className="dashboard-wrap">
        <header className="ui-header">
          <div className="stack--sm">
            <h1 className="type-headline-small">Receipts to expense summaries</h1>
            <p className="muted">
              Signed in as <strong>{user?.name}</strong> — file goes to a background job, not the
              request.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/dashboard")}
          >
            Back to dashboard
          </Button>
        </header>

        {error ? (
          <Alert variant="error" title="Could not submit">
            {error}
          </Alert>
        ) : null}

        <Card>
          <div className="ui-card__body" style={{ display: "grid", gap: "20px" }}>
            <form onSubmit={handleSubmit} style={{ display: "grid", gap: "20px" }}>
              <div className="stack--sm">
                <h2 className="type-title-medium">Upload a receipt</h2>
                <p className="muted">
                  One or more photos (or PDFs) of receipts. Accepted: {ACCEPTED_MIME_TYPES.join(", ")}.
                  Up to {MAX_FILES} files, each up to {MAX_FILE_BYTES / (1024 * 1024)} MB. Allowed file
                  types and sizes are re-checked on the server.
                </p>
              </div>

              <input
                ref={inputRef}
                type="file"
                name="files"
                accept={ACCEPT_HINT}
                multiple
                style={{ width: "100%" }}
                onChange={(event) => addFiles(event.target.files)}
              />

              <div
                style={{
                  border: "1px dashed var(--colour-roles-outline-variant, #ccc)",
                  borderRadius: 8,
                  padding: 20,
                  display: "grid",
                  gap: 8,
                }}
              >
                {selected.length === 0 ? (
                  <p className="muted center">No files chosen yet.</p>
                ) : (
                  selected.map((file, index) => {
                    const issue = validateFile(file);
                    return (
                      <div
                        key={`${file.name}-${index}`}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          alignItems: "center",
                        }}
                      >
                        <span className="type-body-small" style={{ overflow: "hidden" }}>
                          {file.name} <span className="muted">· {formatBytes(file.size)}</span>
                        </span>
                        {issue ? (
                          <span className="type-body-small" style={{ color: "var(--colour-roles-error, #b3261e)" }}>
                            {issue}
                          </span>
                        ) : (
                          <span className="type-body-small" style={{ color: "var(--colour-roles-tertiary, #1a7f37)" }}>
                            OK
                          </span>
                        )}
                        <button
                          type="button"
                          className="type-body-small"
                          onClick={() => removeFile(index)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--colour-roles-on-surface-variant, #666)" }}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Button type="submit" loading={submitting} disabled={accepted.length === 0}>
                  {submitting ? "Uploading…" : "Upload and process"}
                </Button>
                <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
                  Choose files
                </Button>
              </div>
              <p className="muted">
                {accepted.length} valid file{accepted.length === 1 ? "" : "s"} ready. Uploading returns
                instantly with a job id; the model call happens in a background worker.
              </p>
            </form>
          </div>
        </Card>
      </main>
    </div>
  );
}