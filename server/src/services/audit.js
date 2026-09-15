export const AUDIT_ACTIONS = {
  SIGNUP: "user.signup",
  VERIFY_EMAIL: "user.verify_email",
  SIGNIN: "user.signin",
  SIGNOUT: "user.signout",
  FORGOT_PASSWORD: "user.forgot_password",
  RESET_PASSWORD: "user.reset_password",
  NOTE_CREATE: "note.create",
  NOTE_DELETE: "note.delete",
  CHECKOUT_INITIATED: "billing.checkout_initiated",
  DOWNGRADE_SCHEDULED: "billing.downgrade_scheduled",
  CANCELLATION_SCHEDULED: "billing.cancellation_scheduled",
  SUBSCRIPTION_UPGRADE_SCHEDULED: "billing.upgrade_scheduled",
  SUBSCRIPTION_FULFILLED: "billing.subscription_fulfilled",
  PAYMENT_FAILED: "billing.payment_failed",
  PAYMENT_DUPLICATE_IGNORED: "billing.duplicate_webhook_ignored",
  JOB_CREATED: "processing.job_created",
  JOB_FOLLOW_UP: "processing.job_follow_up",
  JOB_RETRIED: "processing.job_retried",
  UNAUTHORIZED_ACCESS: "auth.unauthorized_access",
};

// Audit rows are best-effort: a failure to record an action must never fail
// the operation the action was part of.
export async function recordAudit(db, { actorId, action, targetType, targetId, detail, metadata }) {
  const data = {
    actorId: actorId ?? null,
    action,
    targetType: targetType ?? null,
    targetId: targetId ?? null,
    detail: detail ?? null,
    metadata: metadata ?? undefined,
  };
  try {
    await db.auditLog.create({ data });
  } catch (err) {
    // The actor no longer exists (e.g. the account was deleted and the session
    // was stale). The fact itself still matters, so fall back to an anonymous row.
    if (err?.code === "P2003" && actorId) {
      try {
        await db.auditLog.create({ data: { ...data, actorId: null } });
        return;
      } catch (innerErr) {
        console.error("Failed to write audit log entry", innerErr);
        return;
      }
    }
    console.error("Failed to write audit log entry", err);
  }
}