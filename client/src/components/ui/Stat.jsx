export default function Stat({ label, value, caption, className = "" }) {
  const classes = ["ui-stat", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <p className="ui-stat__label">{label}</p>
      <p className="ui-stat__value">{value}</p>
      {caption ? <p className="ui-stat__caption">{caption}</p> : null}
    </div>
  );
}