import Card from "./ui/Card.jsx";
import Badge from "./ui/Badge.jsx";

export default function EditResult({ result }) {
  return (
    <div style={{ display: "grid", gap: "20px" }}>
      <Badge variant="info">Follow-up action: {result.action}</Badge>

      <Card>
        <div className="ui-card__body" style={{ display: "grid", gap: "16px" }}>
          <div className="stack--sm">
            <h2 className="type-title-medium">Memo</h2>
            <p className="muted">{result.word_count} words</p>
          </div>
          <p className="type-body-medium" style={{ maxWidth: "70ch", lineHeight: 1.6 }}>
            {result.summary}
          </p>
        </div>
      </Card>

      {result.bullet_points?.length ? (
        <Card>
          <div className="ui-card__body" style={{ display: "grid", gap: "12px" }}>
            <h2 className="type-title-medium">In short</h2>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              {result.bullet_points.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}
    </div>
  );
}