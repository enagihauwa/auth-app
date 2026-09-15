import { prisma } from "../db.js";
import { recordAudit, AUDIT_ACTIONS } from "../services/audit.js";

// Records every blocked authorization transition (401 / 403) into the audit
// log. Registered once, ahead of the routes, so no route can ever forget to
// log "unauthenticated" or "forbidden". Forbidden (403) responses carry the
// session actor when one exists; unauthenticated (401) responses are anonymous
// with the attempted email captured when the request submitted one. The body
// is never stored.
export function auditUnauthorizedAccess({ db = prisma } = {}) {
  return (req, res, next) => {
    const originalSend = res.send.bind(res);

    res.send = function (body) {
      const status = this.statusCode;
      if ((status === 401 || status === 403) && !req.__auditAccessRecorded) {
        req.__auditAccessRecorded = true;
        const actorId = req.session?.userId ?? null;
        const attemptedEmail =
          typeof req.body === "object" &&
          req.body !== null &&
          typeof req.body.email === "string"
            ? req.body.email.trim().toLowerCase()
            : null;

        void recordAudit(db, {
          action: AUDIT_ACTIONS.UNAUTHORIZED_ACCESS,
          actorId,
          targetType: "http_request",
          targetId: `${req.method} ${req.originalUrl}`,
          detail: `Blocked ${status === 401 ? "unauthenticated" : "forbidden"} request.`,
          metadata: {
            ip: typeof req.ip === "string" && req.ip ? req.ip : null,
            method: req.method,
            path: req.originalUrl,
            status,
            userAgent:
              typeof req.headers?.["user-agent"] === "string"
                ? req.headers["user-agent"]
                : null,
            ...(attemptedEmail ? { email: attemptedEmail } : {}),
          },
        });
      }

      return originalSend.call(this, body);
    };

    next();
  };
}