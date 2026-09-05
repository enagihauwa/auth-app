export default function Skeleton({ width, height = 16, className = "", ...rest }) {
  const classes = ["ui-skeleton", className].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      style={{
        width: width ?? "100%",
        height,
        ...(rest.style ?? {}),
      }}
      aria-hidden="true"
    >
      {null}
    </div>
  );
}