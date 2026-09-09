import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="auth-screen">
          <div className="billing-wrap" role="alert">
            <h1 className="type-headline-small">Something went wrong</h1>
            <p className="muted">
              An unexpected error interrupted this page. Your subscription is never affected —
              you can reload and pick up where you left off.
            </p>
            <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
              <button className="ui-btn ui-btn--primary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <a className="ui-btn ui-btn--outline" href="/billing">
                Go to Billing
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}