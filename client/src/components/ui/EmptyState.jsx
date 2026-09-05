export default function EmptyState({
  icon,
  title,
  description,
  children,
  className = "",
}) {
  const classes = ["ui-empty", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      {icon ? <div className="ui-empty__icon">{icon}</div> : null}
      <h3 className="ui-empty__title">{title}</h3>
      {description ? <p className="ui-empty__description">{description}</p> : null}
      {children}
    </div>
  );
}