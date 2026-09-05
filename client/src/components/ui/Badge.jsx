const VARIANTS = ["neutral", "info", "success", "warning", "error"];

export default function Badge({ variant = "neutral", className = "", children, ...rest }) {
  const safeVariant = VARIANTS.includes(variant) ? variant : "neutral";
  const classes = ["ui-badge", `ui-badge--${safeVariant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}