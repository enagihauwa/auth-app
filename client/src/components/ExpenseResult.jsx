import Card from "./ui/Card.jsx";
import Badge from "./ui/Badge.jsx";
import Stat from "./ui/Stat.jsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "./ui/Table.jsx";
import { formatMinorAmount, formatIsoDate } from "../lib/money.js";

function Missing({ children = "Not read" }) {
  return <span className="muted">{children}</span>;
}

export default function ExpenseResult({ result }) {
  const currency = result.currency ?? "USD";

  return (
    <div style={{ display: "grid", gap: "20px" }}>
      <Card>
        <div className="ui-card__body" style={{ display: "grid", gap: "16px" }}>
          <div
            className="stack--sm"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}
          >
            <div>
              <p className="type-label-large">
                {result.merchant || <Missing>Merchant not read</Missing>}
              </p>
              <p className="muted">Extracted from the uploaded receipt image</p>
            </div>
            {result.category ? <Badge variant="info">{result.category}</Badge> : null}
          </div>

          <div className="stat-grid">
            <Stat
              label="Total"
              value={result.total_minor !== null ? formatMinorAmount(result.total_minor, currency) : <Missing />}
              caption="Invoice total"
            />
            <Stat
              label="Tax"
              value={result.tax_minor !== null ? formatMinorAmount(result.tax_minor, currency) : <Missing />}
              caption="Tax portion"
            />
            <Stat
              label="Date"
              value={formatIsoDate(result.invoice_date)}
              caption="On the receipt"
            />
            <Stat
              label="Paid by"
              value={result.payment_method ?? <Missing />}
              caption="Payment method"
            />
          </div>
        </div>
      </Card>

      <Card>
        <div className="ui-card__body" style={{ display: "grid", gap: "16px" }}>
          <div className="stack--sm">
            <h2 className="type-title-medium">Line items</h2>
            <p className="muted">
              {result.items?.length
                ? `${result.items.length} item${result.items.length === 1 ? "" : "s"} in printed order`
                : "No line items could be read."}
            </p>
          </div>
          {result.items?.length ? (
            <Table>
              <Thead>
                <Tr>
                  <Th>Description</Th>
                  <Th>Qty</Th>
                  <Th>Unit price</Th>
                  <Th>Line total</Th>
                </Tr>
              </Thead>
              <Tbody>
                {result.items.map((item, index) => (
                  <Tr key={index}>
                    <Td>{item.description}</Td>
                    <Td num>{item.quantity ?? "—"}</Td>
                    <Td num>
                      {item.unit_price_minor !== null
                        ? formatMinorAmount(item.unit_price_minor, currency)
                        : "—"}
                    </Td>
                    <Td num>
                      {item.line_total_minor !== null
                        ? formatMinorAmount(item.line_total_minor, currency)
                        : "—"}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          ) : null}
        </div>
      </Card>

      {result.warnings?.length ? (
        <div
          className="ui-alert ui-alert--warning"
          role="alert"
          style={{ display: "grid", gap: "6px" }}
        >
          <span className="ui-alert__title">Fields the model could not read confidently</span>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}