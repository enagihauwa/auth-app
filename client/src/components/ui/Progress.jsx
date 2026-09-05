export default function Progress({
  value = 0,
  indeterminate = false,
  label,
  className = "",
}) {
  const classes = [
    "ui-progress",
    indeterminate ? "ui-progress--indeterminate" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const clamped = Math.max(0, Math.min(100, Number(value) || 0));

  return (
    <div
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : clamped}
    >
      <div
        className="ui-progress__bar"
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}