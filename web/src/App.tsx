import { type ReactNode, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider, useAuth, useIsAdmin } from "@/auth";
import { lazyPage, useNewBuildOnNavigation } from "@/lib/build";
import { AccountsPage } from "@/pages/AccountsPage";
import { BasketPage } from "@/pages/BasketPage";
import { BasketsPage } from "@/pages/BasketsPage";
import { BeanBatchPage } from "@/pages/BeanBatchPage";
import { BeanBatchesPage } from "@/pages/BeanBatchesPage";
import { BeanPage } from "@/pages/BeanPage";
import { BeansPage } from "@/pages/BeansPage";
import { ConflictsPage } from "@/pages/ConflictsPage";
import { GrinderPage } from "@/pages/GrinderPage";
import { GrindersPage } from "@/pages/GrindersPage";
import { InvitePage } from "@/pages/InvitePage";
import { LocationPage } from "@/pages/LocationPage";
import { LocationsPage } from "@/pages/LocationsPage";
import { MachinePage } from "@/pages/MachinePage";
import { MachinesPage } from "@/pages/MachinesPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { ProfilesPage } from "@/pages/ProfilesPage";
import { RecipePage } from "@/pages/RecipePage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { SetupPage } from "@/pages/SetupPage";
import { HomePage, Shell } from "@/pages/Shell";
import { SignInPage, type SignInState } from "@/pages/SignInPage";
import { ToolPage } from "@/pages/ToolPage";
import { ToolsPage } from "@/pages/ToolsPage";

// The Shot and Steam Record pages load their charts and calendar only when opened, which keeps them out of every other page.
// One whose chunk fails to load reloads as it is shown (`src/lib/build.ts`).
const ShotsPage = lazyPage(() => import("@/pages/ShotsPage").then((page) => page.ShotsPage));
const ShotPage = lazyPage(() => import("@/pages/ShotPage").then((page) => page.ShotPage));
const SteamRecordsPage = lazyPage(() => import("@/pages/SteamRecordsPage").then((page) => page.SteamRecordsPage));
const SteamRecordPage = lazyPage(() => import("@/pages/SteamRecordPage").then((page) => page.SteamRecordPage));

export function App() {
  return (
    <BrowserRouter>
      <NewBuildOnNavigation />
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
            <Route path="/library" element={<Navigate to="/library/beans" replace />} />
            <Route path="/library/beans" element={<BeansPage />} />
            <Route path="/library/beans/:id" element={<BeanPage />} />
            <Route path="/library/bean-batches" element={<BeanBatchesPage />} />
            <Route path="/library/bean-batches/:id" element={<BeanBatchPage />} />
            <Route path="/library/grinders" element={<GrindersPage />} />
            <Route path="/library/grinders/:id" element={<GrinderPage />} />
            <Route path="/library/profiles" element={<ProfilesPage />} />
            <Route path="/library/profiles/:id" element={<ProfilePage />} />
            <Route path="/library/baskets" element={<BasketsPage />} />
            <Route path="/library/baskets/:id" element={<BasketPage />} />
            <Route path="/library/tools" element={<ToolsPage />} />
            <Route path="/library/tools/:id" element={<ToolPage />} />
            <Route path="/library/recipes/:id" element={<RecipePage />} />
            <Route path="/library/conflicts" element={<ConflictsPage />} />
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="/locations/:id" element={<LocationPage />} />
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
            <Route
              path="/steam-records"
              element={
                <Suspense>
                  <SteamRecordsPage />
                </Suspense>
              }
            />
            <Route
              path="/steam-records/:id"
              element={
                <Suspense>
                  <SteamRecordPage />
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

/** Loads the build the server serves at the next navigation once it is another (`src/lib/build.ts`). */
function NewBuildOnNavigation(): null {
  useNewBuildOnNavigation();
  return null;
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
