import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api.js";
import SigninPage from "./pages/SigninPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";
import ForgotPage from "./pages/ForgotPage.jsx";
import ResetPage from "./pages/ResetPage.jsx";
import VerifyPage from "./pages/VerifyPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import JobViewPage from "./pages/JobViewPage.jsx";
import DesignSystemPage from "./pages/DesignSystemPage.jsx";
import PlansPage from "./pages/PlansPage.jsx";
import ReturnPage from "./pages/ReturnPage.jsx";
import BillingPage from "./pages/BillingPage.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import ThemeToggle from "./components/ui/ThemeToggle.jsx";

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

function ProtectedRoute({ children }) {
  const { user, checking } = useAuth();
  const location = useLocation();

  if (checking) {
    return (
      <div className="auth-screen">
        <p className="muted">Checking session…</p>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }
  return children;
}

function RedirectIfSignedIn({ children }) {
  const { user, checking } = useAuth();
  if (checking) {
    return (
      <div className="auth-screen">
        <p className="muted">Checking session…</p>
      </div>
    );
  }
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { ok, data } = await api("/api/me");
      setUser(ok ? data.user : null);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setChecking(false));
  }, [refresh]);

  const value = { user, setUser, refresh, checking };

  return (
    <AuthContext.Provider value={value}>
      <ThemeToggle floating />
      <Routes>
        <Route
          path="/signin"
          element={
            <RedirectIfSignedIn>
              <SigninPage />
            </RedirectIfSignedIn>
          }
        />
        <Route
          path="/signup"
          element={
            <RedirectIfSignedIn>
              <SignupPage />
            </RedirectIfSignedIn>
          }
        />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/upload"
          element={
            <ProtectedRoute>
              <UploadPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/:id"
          element={
            <ProtectedRoute>
              <JobViewPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/plans"
          element={
            <ErrorBoundary>
              <ProtectedRoute>
                <PlansPage />
              </ProtectedRoute>
            </ErrorBoundary>
          }
        />
        <Route
          path="/return"
          element={
            <ErrorBoundary>
              <ProtectedRoute>
                <ReturnPage />
              </ProtectedRoute>
            </ErrorBoundary>
          }
        />
        <Route
          path="/billing"
          element={
            <ErrorBoundary>
              <ProtectedRoute>
                <BillingPage />
              </ProtectedRoute>
            </ErrorBoundary>
          }
        />
        <Route path="/design-system" element={<DesignSystemPage />} />
        <Route path="/" element={<Navigate to="/signin" replace />} />
        <Route path="*" element={<Navigate to="/signin" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}