const TONES = ["neutral", "info", "success", "warning", "error"];

export default function StatusIndicator({
  tone = "neutral",
  className = "",
  children,
  ...rest
}) {
  const safeTone = TONES.includes(tone) ? tone : "neutral";
  const classes = [
    "ui-status",
    safeTone !== "neutral" ? `ui-status--${safeTone}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} {...rest}>
      <span className="ui-status__dot" aria-hidden="true" />
      {children}
    </span>
  );
}