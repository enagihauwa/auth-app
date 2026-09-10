import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api } from "../api.js";
import Card from "../components/ui/Card.jsx";
import Button from "../components/ui/Button.jsx";
import Badge from "../components/ui/Badge.jsx";
import Alert from "../components/ui/Alert.jsx";
import Progress from "../components/ui/Progress.jsx";
import StatusIndicator from "../components/ui/StatusIndicator.jsx";
import ExpenseResult from "../components/ExpenseResult.jsx";
import EditResult from "../components/EditResult.jsx";
import { formatBytes } from "../lib/money.js";

const POLL_MS = 1200;
const MAX_ATTEMPTS_LABEL = 3;

const STATUS_TONE = {
  PENDING: "warning",
  PROCESSING: "info",
  DONE: "success",
  FAILED: "error",
};

function StatusCopy({ job }) {
  switch (job.status) {
    case "PENDING":
      return "Queued — waiting for a free worker slot (concurrency is capped).";
    case "PROCESSING":
      return `Processing — attempt ${job.attempts} of ${MAX_ATTEMPTS_LABEL} through the model.`;
    case "DONE":
      return job.kind === "EDIT"
        ? "Follow-up finished — the memo below was produced from the extracted receipt."
        : "Extraction finished — the structured result below was validated against our schema.";
    case "FAILED":
      return "This job failed. The error below is the real reason, and a retry re-runs it.";
    default:
      return "";
  }
}

export default function JobViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api(`/api/processing/jobs/${id}`);
    if (res.ok) {
      setJob(res.data.job);
      setLoadError(null);
    } else {
      setLoadError(res.data?.error ?? "Could not load this job.");
    }
  }, [id]);

  useEffect(() => {
    setJob(null);
    setLoadError(null);
    load();
  }, [load]);

  const active = job && (job.status === "PENDING" || job.status === "PROCESSING");

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  async function handleRetry() {
    setBusy(true);
    const res = await api(`/api/processing/jobs/${job.id}/retry`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setLoadError(res.data?.error ?? "Could not retry.");
      return;
    }
    setJob((current) => ({ ...current, status: "PENDING", error: null, ...(res.data.job ?? {}) }));
  }

  async function handleFollowUp() {
    setBusy(true);
    const res = await api(`/api/processing/jobs/${job.id}/follow-up`, {
      method: "POST",
      body: { action: "summarise" },
    });
    setBusy(false);
    if (!res.ok) {
      setLoadError(res.data?.error ?? "Could not start the follow-up.");
      return;
    }
    navigate(`/jobs/${res.data.job.id}`);
  }

  if (loadError && !job) {
    return (
      <div className="auth-screen">
        <main className="dashboard-wrap">
          <Alert variant="error" title="Could not open this job">
            {loadError}
          </Alert>
          <Button type="button" variant="outline" onClick={() => navigate("/upload")}>
            Upload another receipt
          </Button>
        </main>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="auth-screen">
        <main className="dashboard-wrap">
          <p className="muted center">Loading job…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <main className="dashboard-wrap" style={{ display: "grid", gap: "20px" }}>
        <header className="ui-header">
          <div className="stack--sm">
            <h1 className="type-headline-small">
              {job.kind === "EDIT" ? "Follow-up memo" : "Receipt extraction"}
            </h1>
            <p className="muted">Job #{job.id}</p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Badge variant={STATUS_TONE[job.status]}>{job.status}</Badge>
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/upload")}>
              New upload
            </Button>
          </div>
        </header>

        <Card>
          <div className="ui-card__body" style={{ display: "grid", gap: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <StatusIndicator tone={STATUS_TONE[job.status]}>
                <StatusCopy job={job} />
              </StatusIndicator>
              {job.attempts > 0 ? <span className="muted">attempts: {job.attempts}</span> : null}
            </div>

            {(job.status === "PENDING" || job.status === "PROCESSING") && (
              <Progress indeterminate label="Model call in progress" />
            )}

            {job.status === "FAILED" && (
              <Alert variant="error" title="The truth about this failure">
                {job.error}
              </Alert>
            )}
          </div>
        </Card>

        {job.kind === "EDIT" && job.parent_id && (
          <p className="muted">
            Produced from{" "}
            <Link to={`/jobs/${job.parent_id}`} className="link">
              job #{job.parent_id}
            </Link>
            . <span className="muted">Requested action: {job.input?.action ?? "summarise"}.</span>
          </p>
        )}

        {job.files?.length ? (
          <Card>
            <div className="ui-card__body" style={{ display: "grid", gap: "8px" }}>
              <p className="type-label-large">Input files</p>
              {job.files.map((file) => (
                <p className="muted" key={file.id}>
                  {file.name} · {formatBytes(file.size_bytes)} · {file.mime_type}
                </p>
              ))}
            </div>
          </Card>
        ) : null}

        {job.status === "DONE" ? (
          <>
            {job.kind === "EXTRACT" ? <ExpenseResult result={job.result} /> : <EditResult result={job.result} />}

            {job.kind === "EXTRACT" && (
              <Card>
                <div
                  className="ui-card__body"
                  style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
                >
                  <div className="stack--sm" style={{ flex: 1 }}>
                    <h2 className="type-title-medium">Follow-up action</h2>
                    <p className="muted">
                      Summarise this expense into a plain-language memo using the second model role.
                    </p>
                  </div>
                  <Button type="button" loading={busy} onClick={handleFollowUp}>
                    Summarise this expense
                  </Button>
                </div>
              </Card>
            )}
          </>
        ) : null}

        {job.status === "FAILED" && (
          <div>
            <Button type="button" variant="outline" loading={busy} onClick={handleRetry}>
              Retry this job
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}