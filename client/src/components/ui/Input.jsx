import { useId, useState } from "react";

export default function Input({
  label,
  error,
  hint,
  id,
  variant,
  type = "text",
  className = "",
  ...inputProps
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";

  const classes = [
    "ui-input",
    variant === "code" ? "ui-input--code" : "",
    variant === "filled" ? "ui-input--filled" : "",
    isPassword ? "ui-input--password" : "",
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
      <div className="ui-input__wrapper">
        <input
          id={inputId}
          className={classes}
          type={isPassword && revealed ? "text" : type}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          {...inputProps}
        />
        {isPassword ? (
          <button
            type="button"
            className="ui-input__toggle"
            aria-label={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        ) : null}
      </div>
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