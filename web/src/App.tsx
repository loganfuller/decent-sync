import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider, useAuth } from "@/auth";
import { LocationsPage } from "@/pages/LocationsPage";
import { SetupPage } from "@/pages/SetupPage";
import { HomePage, Shell } from "@/pages/Shell";
import { SignInPage, type SignInState } from "@/pages/SignInPage";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/setup" element={<Gate page="setup" />} />
          <Route path="/sign-in" element={<Gate page="sign-in" />} />
          <Route element={<Gate page="signed-in" />}>
            <Route index element={<HomePage />} />
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

interface ReturnTo {
  from?: string;
}

/**
 * Shows a page only in the state it belongs to: setup while the server has no
 * accounts, sign-in while signed out, and everything else while signed in.
 * Any other page redirects.
 */
function Gate({ page }: { page: "setup" | "sign-in" | "signed-in" }): ReactNode {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === "loading") return null;
  if (state.status === "unreachable") return <Unreachable />;

  if (state.status === "signed-in") {
    if (page === "signed-in") return <Shell />;
    return <Navigate to={(location.state as ReturnTo | null)?.from ?? "/"} replace />;
  }

  if (state.setupRequired) {
    return page === "setup" ? (
      <SetupPage passwordMinLength={state.passwordMinLength} />
    ) : (
      <Navigate to="/setup" replace />
    );
  }
  if (page === "sign-in") return <SignInPage />;
  if (page === "setup") {
    const notice: SignInState = { notice: "This server is already set up. Sign in instead." };
    return <Navigate to="/sign-in" replace state={notice} />;
  }
  return <Navigate to="/sign-in" replace state={{ from: location.pathname } satisfies ReturnTo} />;
}

function Unreachable() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <p role="alert">The Decent Sync server can't be reached. Reload the page to try again.</p>
    </main>
  );
}
