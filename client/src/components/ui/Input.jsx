import { useId } from "react";

export default function Input({
  label,
  error,
  hint,
  id,
  variant,
  className = "",
  ...inputProps
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  const classes = [
    "ui-input",
    variant === "code" ? "ui-input--code" : "",
    variant === "filled" ? "ui-input--filled" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="ui-field">
      {label ? (
        <label className="ui-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        className={classes}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...inputProps}
      />
      {hint ? (
        <p className="ui-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="ui-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}