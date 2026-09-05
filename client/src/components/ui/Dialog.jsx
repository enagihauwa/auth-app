import { useEffect, useId, useRef } from "react";

export default function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className = "",
}) {
  const titleId = useId();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const classes = ["ui-dialog", className].filter(Boolean).join(" ");

  return (
    <div className="ui-dialog-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="ui-dialog__title">
          {title}
        </h3>
        <div>{children}</div>
        {footer ? <div className="ui-dialog__footer">{footer}</div> : null}
      </div>
    </div>
  );
}