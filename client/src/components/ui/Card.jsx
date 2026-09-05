export default function Card({
  variant = "default",
  interactive = false,
  className = "",
  ...rest
}) {
  const classes = [
    "ui-card",
    `ui-card--${variant}`,
    interactive ? "ui-card--interactive" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes} {...rest} />;
}