import { useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/ui/Button.jsx";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Badge from "../components/ui/Badge.jsx";
import Alert from "../components/ui/Alert.jsx";
import Dialog from "../components/ui/Dialog.jsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "../components/ui/Table.jsx";
import Progress from "../components/ui/Progress.jsx";
import Skeleton from "../components/ui/Skeleton.jsx";
import EmptyState from "../components/ui/EmptyState.jsx";
import Stat from "../components/ui/Stat.jsx";
import StatusIndicator from "../components/ui/StatusIndicator.jsx";
import ThemeToggle from "../components/ui/ThemeToggle.jsx";

const ROLE_SWATCHES = [
  ["primary"],
  ["on-primary", true],
  ["primary-container"],
  ["on-primary-container", true],
  ["secondary"],
  ["on-secondary", true],
  ["secondary-container"],
  ["on-secondary-container", true],
  ["tertiary"],
  ["on-tertiary", true],
  ["tertiary-container"],
  ["on-tertiary-container", true],
  ["error"],
  ["on-error", true],
  ["error-container"],
  ["on-error-container", true],
  ["success"],
  ["on-success", true],
  ["success-container"],
  ["on-success-container", true],
  ["surface"],
  ["surface-container"],
  ["outline", true],
  ["outline-variant", true],
  ["background"],
  ["on-background", true],
  ["on-surface", true],
  ["on-surface-variant", true],
  ["warning"],
  ["on-warning", true],
];

const SIZES = [
  ["super-large", "64px"],
  ["very-large", "32px"],
  ["extra-large", "24px"],
  ["large", "20px"],
  ["base", "16px"],
  ["medium", "12px"],
  ["small", "8px"],
  ["extra-small", "4px"],
  ["no-spacing", "0"],
];

const SHADOWS = [
  ["hard", "--effect-hard-shadow"],
  ["soft", "--effect-soft-shadows"],
  ["medium", "--effect-medium-shadow"],
];

const SPACING_TOKENS = [
  ["--spacing-collection-no-spacing", "0"],
  ["--spacing-collection-extra-small", "4px"],
  ["--spacing-collection-small", "8px"],
  ["--spacing-collection-medium", "12px"],
  ["--spacing-collection-base", "16px"],
  ["--spacing-collection-large", "20px"],
  ["--spacing-collection-extra-large", "24px"],
  ["--spacing-collection-very-large", "32px"],
];

function colorCssVar(name) {
  return `var(--colour-roles-${name})`;
}

function textColorFor() {
  return "var(--colour-roles-surface)";
}

export default function DesignSystemPage() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="showcase">
      <nav className="ui-nav">
        <span className="ui-nav__brand">Design system</span>
        <div className="ui-nav__links">
          <Link className="ui-nav__link ui-nav__link--active" to="/design-system">
            Guide
          </Link>
          <Link className="ui-nav__link" to="/signin">
            Sign in
          </Link>
          <ThemeToggle />
        </div>
      </nav>

      <main className="showcase__body">
        <header className="showcase__header">
          <h1 className="type-display-medium">Design system</h1>
          <p className="type-body-large muted">
            All styles are driven by semantic tokens from <code>tokens.css</code>. Toggle the
            floating theme switch to preview dark mode.
          </p>
        </header>

        <section className="showcase__section">
          <h2 className="type-headline-small">Colour roles</h2>
          <div className="swatch-grid">
            {ROLE_SWATCHES.map(([name, isText]) => (
              <div
                key={name}
                className="swatch"
                style={{ backgroundColor: colorCssVar(name), color: textColorFor(name) }}
              >
                <span className="swatch__name">{name}</span>
                <span className="swatch__value">var(--colour-roles-{name})</span>
              </div>
            ))}
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Typography</h2>
          <div className="stack">
            <p className="type-display-large">Display large — 96/96 letters</p>
            <p className="type-display-medium">Display medium — 60/80 letters</p>
            <p className="type-display-small">Display small — 40/60 letters</p>
            <p className="type-headline-large">Headline large — 32/48 letters</p>
            <p className="type-headline-medium">Headline medium — 28/42 letters</p>
            <p className="type-headline-small">Headline small — 24/36 letters</p>
            <p className="type-title-large">Title large — 20/32 letters</p>
            <p className="type-title-medium">Title medium — 16/24 letters</p>
            <p className="type-title-small">Title small — 14/24 letters</p>
            <p className="type-body-large">Body large — 16/24 letters</p>
            <p className="type-body-medium">Body medium — 14/20 letters</p>
            <p className="type-body-small">Body small — 12/16 letters</p>
            <p className="type-label-large">Label large — 14/20 letters</p>
            <p className="type-label-medium">Label medium — 12/16 letters</p>
            <p className="type-label-small">Label small — 11/16 letters</p>
          </div>

          <div className="stack">
            <p className="type-number">Number font — 1 2 3 4 5 6 7 8 9 0</p>
            <p className="type-number-regular">Number regular — 012 345 6789</p>
            <p className="type-number-medium">Number medium — 012 345 6789</p>
            <p className="type-number-bold">Number bold — 012 345 6789</p>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Spacing &amp; radius</h2>
          <div className="stack">
            {SPACING_TOKENS.map(([name, value]) => (
              <div key={name} className="spacing-row">
                <span className="type-label-large" style={{ minWidth: 260 }}>
                  {name}
                </span>
                <span
                  className="spacing-block"
                  style={{ width: value, height: value }}
                />
                <code>{value}</code>
              </div>
            ))}
            <div className="spacing-row">
              <span className="type-label-large" style={{ minWidth: 260 }}>
                --spacing-collection-extra-large-highlight
              </span>
              <span className="spacing-block radius-shape" />
              <code>rounding / overlay</code>
            </div>
            <div className="spacing-row">
              <span className="type-label-large" style={{ minWidth: 260 }}>
                Radius “pill”
              </span>
              <span className="spacing-block radius-pill" />
              <code>999px</code>
            </div>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Elevation</h2>
          <div className="shadow-row">
            {SHADOWS.map(([label, varName]) => (
              <div key={label} className="shadow-card" style={{ boxShadow: `var(${varName})` }}>
                <strong>Elevation {label}</strong>
                <code>{varName}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Buttons</h2>
          <div className="flex-row wrap">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="tertiary">Tertiary</Button>
            <Button variant="error">Error</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button loading>Loading</Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
            <Button size="sm" variant="outline">
              Small
            </Button>
            <Button block>Block</Button>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Inputs</h2>
          <div className="grid-2">
            <Input label="Default" placeholder="Type something…" />
            <Input label="Focused" defaultValue="Focused value" onFocus={() => {}} />
            <Input label="Filled" variant="filled" placeholder="Filled variant" />
            <Input label="Code" variant="code" inputMode="numeric" placeholder="123456" />
            <Input label="With error" placeholder="Bad input" error="This field is required." />
            <Input label="Disabled" disabled defaultValue="Cannot edit" />
            <Input label="With hint" hint="We will not share your email." placeholder="you@example.com" />
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Cards</h2>
          <div className="flex-row wrap">
            <Card>Default card</Card>
            <Card variant="elevated">Elevated card</Card>
            <Card variant="outlined">Outlined card</Card>
            <Card interactive tabIndex={0} role="button" aria-label="Interactive card">
              Interactive card
            </Card>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Badges</h2>
          <div className="flex-row wrap">
            <Badge>Neutral</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="error">Error</Badge>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Status indicators</h2>
          <div className="flex-row wrap">
            <StatusIndicator>Neutral</StatusIndicator>
            <StatusIndicator tone="info">Processing</StatusIndicator>
            <StatusIndicator tone="success">Verified</StatusIndicator>
            <StatusIndicator tone="warning">Review needed</StatusIndicator>
            <StatusIndicator tone="error">Failed</StatusIndicator>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Alerts</h2>
          <div className="stack">
            <Alert variant="info">This is an informational alert.</Alert>
            <Alert variant="success">Email verified successfully.</Alert>
            <Alert variant="warning">Your session expires soon.</Alert>
            <Alert variant="error">This code is invalid or has expired.</Alert>
            <Alert variant="info" title="With title">A titled alert body.</Alert>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Dialog</h2>
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            Open dialog
          </Button>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title="Delete item?"
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button variant="error" onClick={() => setDialogOpen(false)}>
                  Delete
                </Button>
              </>
            }
          >
            <p className="type-body-medium">
              This action is destructive and cannot be undone. Press Escape or click outside to
              close.
            </p>
          </Dialog>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Table</h2>
          <Table>
            <Thead>
              <Tr>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th>Role</Th>
                <Th num>Failed attempts</Th>
              </Tr>
            </Thead>
            <Tbody>
              <Tr>
                <Td>you@example.com</Td>
                <Td>
                  <StatusIndicator tone="success">Active</StatusIndicator>
                </Td>
                <Td>Admin</Td>
                <Td num>0</Td>
              </Tr>
              <Tr>
                <Td>someone@example.com</Td>
                <Td>
                  <StatusIndicator tone="warning">Pending</StatusIndicator>
                </Td>
                <Td>User</Td>
                <Td num>2</Td>
              </Tr>
            </Tbody>
          </Table>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Progress &amp; skeleton</h2>
          <div className="stack">
            <Progress value={45} label="45% complete" />
            <Progress indeterminate label="Loading…" />
            <div className="grid-2">
              <Skeleton width={40} height={20} />
              <Skeleton width="40%" height={16} />
            </div>
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Stats</h2>
          <div className="stat-grid">
            <Stat label="Failed attempts" value="0" caption="Last 30 days" />
            <Stat label="Uptime" value="99.98%" caption="Rolling month" />
            <Stat label="Members" value="1,248" caption="Verified accounts" />
          </div>
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Empty state</h2>
          <EmptyState
            icon="⛶"
            title="Nothing here yet"
            description="This area is empty until you add content."
          />
        </section>

        <section className="showcase__section">
          <h2 className="type-headline-small">Also available</h2>
          <p className="type-body-medium muted">
            Layout primitives (auth-screen, auth-card, dashboard-wrap, stat-grid, link-row,
            resend-row), dialogs with focus management, keyboard/aria support throughout, and
            fully responsive breakpoints at 40rem.
          </p>
        </section>
      </main>
    </div>
  );
}