const VARIANTS = [
  "primary",
  "secondary",
  "tertiary",
  "error",
  "outline",
  "ghost",
];

export default function Button({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  className = "",
  type = "button",
  disabled,
  children,
  ...rest
}) {
  const safeVariant = VARIANTS.includes(variant) ? variant : "primary";

  const classes = [
    "ui-btn",
    `ui-btn--${safeVariant}`,
    size === "sm" ? "ui-btn--sm" : "",
    block ? "ui-btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={classes}
      type={type}
      disabled={disabled || loading}
      aria-disabled={disabled || loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}