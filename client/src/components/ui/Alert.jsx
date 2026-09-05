const VARIANTS = ["info", "success", "warning", "error"];

export default function Alert({
  variant = "info",
  title,
  className = "",
  children,
  ...rest
}) {
  const safeVariant = VARIANTS.includes(variant) ? variant : "info";
  const classes = ["ui-alert", `ui-alert--${safeVariant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="alert" {...rest}>
      {title ? <span className="ui-alert__title">{title}</span> : null}
      {children}
    </div>
  );
}