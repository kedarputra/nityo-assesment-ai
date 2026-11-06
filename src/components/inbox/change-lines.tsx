import { formatUsd } from "@/lib/money";
import type { ProposalView } from "@/server/inbox/email-work";

// The lines of a change or a cancellation, shared by the review controls and a decided Proposal.

// A change in value, signed: "+$575.00", "−$1,500.00".
export function formatChange(cents: number): string {
  if (cents > 0) return `+${formatUsd(cents)}`;
  if (cents < 0) return `−${formatUsd(-cents)}`;
  return formatUsd(0);
}

// A change or a cancellation as each line's quantity before → after, at the order's own price
// (or the system's for a line added), with what it does to the order's value.
export function ChangeLines({ proposal }: { proposal: ProposalView }) {
  return (
    <table className="lines">
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col" className="num">
            Qty before → after
          </th>
          <th scope="col" className="num">
            Price
          </th>
          <th scope="col" className="num">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {proposal.lines.map((line) => (
          <tr key={line.lineNo}>
            <td data-label="Product">
              {line.productName ?? "Not in the catalog"}
              <br />
              <span className="id">{line.sku}</span>
              <span className="meta">{line.orderLineNo === null ? " new line" : ` line ${line.orderLineNo}`}</span>
              {line.customerWords ? <span className="meta"> They wrote: “{line.customerWords}”</span> : null}
            </td>
            <td className="num" data-label="Quantity">
              {line.before === null || line.after === null ? formatSigned(line.quantity) : `${line.before} → ${line.after}`}
              {line.available !== null && line.quantity > 0 ? <span className="meta">{line.available} on the shelf</span> : null}
            </td>
            <td className="num" data-label="Price">
              {line.unitPriceCents === null ? "–" : formatUsd(line.unitPriceCents)}
              {line.priceSource ? <span className="meta"> {line.priceSource}</span> : null}
            </td>
            <td className="num" data-label="Change">
              {line.lineTotalCents === null ? "–" : formatChange(line.lineTotalCents)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={3}>
            Change in order value
          </th>
          <td className="num">{formatChange(proposal.totalCents)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function formatSigned(quantity: number): string {
  return quantity > 0 ? `+${quantity}` : `−${-quantity}`;
}
