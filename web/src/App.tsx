import { type ReactNode, Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider, useAuth, useIsAdmin } from "@/auth";
import { AccountsPage } from "@/pages/AccountsPage";
import { InvitePage } from "@/pages/InvitePage";
import { LocationsPage } from "@/pages/LocationsPage";
import { MachinePage } from "@/pages/MachinePage";
import { MachinesPage } from "@/pages/MachinesPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { SetupPage } from "@/pages/SetupPage";
import { HomePage, Shell } from "@/pages/Shell";
import { SignInPage, type SignInState } from "@/pages/SignInPage";

// The Shot pages load their charts and calendar only when opened, which keeps them out of every other page.
const ShotsPage = lazy(() => import("@/pages/ShotsPage").then((page) => ({ default: page.ShotsPage })));
const ShotPage = lazy(() => import("@/pages/ShotPage").then((page) => ({ default: page.ShotPage })));

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/setup" element={<Gate page="setup" />} />
          <Route path="/sign-in" element={<Gate page="sign-in" />} />
          <Route path="/invite/:secret" element={<Gate page="invite" />} />
          <Route path="/reset-password/:secret" element={<Gate page="reset-password" />} />
          <Route element={<Gate page="signed-in" />}>
            <Route index element={<HomePage />} />
            <Route
              path="/accounts"
              element={
                <AdminOnly>
                  <AccountsPage />
                </AdminOnly>
              }
            />
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="/machines" element={<MachinesPage />} />
            <Route path="/machines/:id" element={<MachinePage />} />
            <Route
              path="/shots"
              element={
                <Suspense>
                  <ShotsPage />
                </Suspense>
              }
            />
            <Route
              path="/shots/:id"
              element={
                <Suspense>
                  <ShotPage />
                </Suspense>
              }
            />
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
 * Any other page redirects. An invite or password reset link opens whether
 * or not someone is signed in, and says what to do either way.
 */
function Gate({ page }: { page: "setup" | "sign-in" | "invite" | "reset-password" | "signed-in" }): ReactNode {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === "loading") return null;
  if (state.status === "unreachable") return <Unreachable />;
  if (page === "invite") return <InvitePage />;
  if (page === "reset-password") return <ResetPasswordPage />;

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

/** A page only Admins can use: the server refuses Staff what it shows, so they go home instead. */
function AdminOnly({ children }: { children: ReactNode }): ReactNode {
  return useIsAdmin() ? children : <Navigate to="/" replace />;
}

function Unreachable() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <p role="alert">The Decent Sync server can't be reached. Reload the page to try again.</p>
    </main>
  );
}
