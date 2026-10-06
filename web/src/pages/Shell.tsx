import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth, useIsAdmin } from "@/auth";
import { Button } from "@/components/ui/button";

/** The signed-in frame: a header with the account and sign-out, and a page. */
export function Shell() {
  const { state, signOut } = useAuth();
  const isAdmin = useIsAdmin();
  const [signingOut, setSigningOut] = useState(false);
  const account = state.status === "signed-in" ? state.account : undefined;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="font-semibold">
            Decent Sync
          </Link>
          <nav aria-label="Main" className="flex flex-1 items-center gap-4 text-sm">
            <NavLink to="/shots" className={navLinkClass}>
              Shots
            </NavLink>
            <NavLink to="/machines" className={navLinkClass}>
              Machines
            </NavLink>
            <NavLink to="/locations" className={navLinkClass}>
              Locations
            </NavLink>
            {isAdmin && (
              <NavLink to="/accounts" className={navLinkClass}>
                Accounts
              </NavLink>
            )}
          </nav>
          {account && (
            <span className="text-sm text-muted-foreground" data-testid="signed-in-account">
              {account.name}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={handleSignOut} disabled={signingOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return isActive ? "font-medium" : "text-muted-foreground hover:text-foreground";
}

export function HomePage() {
  const { state } = useAuth();
  const name = state.status === "signed-in" ? state.account.name : "";

  return (
    <section className="grid gap-2">
      <h1 className="text-2xl font-semibold">Welcome, {name}</h1>
      <p className="text-muted-foreground">Locations, Machines and Shots will appear here.</p>
    </section>
  );
}
