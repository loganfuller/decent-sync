import { MenuIcon } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth, useIsAdmin } from "@/auth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** The signed-in frame: a header with the account and sign-out, in a menu on a narrow screen, and a page. */
export function Shell() {
  const { state, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
          {/* With an Admin's links the row needs about 650 px, more than sm's 640, so below md it is in a menu. */}
          <div className="hidden min-w-0 flex-1 items-center gap-4 md:flex">
            <MainNav className="flex flex-1 items-center gap-4 text-sm" />
            {account && (
              <span className="min-w-0 truncate text-sm text-muted-foreground" data-testid="signed-in-account">
                {account.name}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={handleSignOut} disabled={signingOut}>
              Sign out
            </Button>
          </div>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="ml-auto md:hidden">
                <MenuIcon />
                <span className="sr-only">Menu</span>
              </Button>
            </SheetTrigger>
            {/* Scrolls on a small phone held sideways, which still gets the menu, so Sign out stays in reach. */}
            <SheetContent className="overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Decent Sync</SheetTitle>
                {account && <SheetDescription className="wrap-anywhere">Signed in as {account.name}</SheetDescription>}
              </SheetHeader>
              <MainNav className="grid px-4 text-base *:py-2" onNavigate={() => setMenuOpen(false)} />
              <SheetFooter>
                <Button variant="outline" onClick={handleSignOut} disabled={signingOut}>
                  Sign out
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}

/** The pages every account reaches, and Accounts for an Admin: in the top bar, or in the menu on a narrow screen. */
function MainNav({ className, onNavigate }: { className: string; onNavigate?: () => void }) {
  const isAdmin = useIsAdmin();
  return (
    <nav aria-label="Main" className={className}>
      <NavLink to="/shots" className={navLinkClass} onClick={onNavigate}>
        Shots
      </NavLink>
      <NavLink to="/steam-records" className={navLinkClass} onClick={onNavigate}>
        Steam Records
      </NavLink>
      <NavLink to="/library" className={navLinkClass} onClick={onNavigate}>
        Library
      </NavLink>
      <NavLink to="/machines" className={navLinkClass} onClick={onNavigate}>
        Machines
      </NavLink>
      <NavLink to="/locations" className={navLinkClass} onClick={onNavigate}>
        Locations
      </NavLink>
      {isAdmin && (
        <NavLink to="/accounts" className={navLinkClass} onClick={onNavigate}>
          Accounts
        </NavLink>
      )}
    </nav>
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
      <h1 className="text-2xl font-semibold wrap-anywhere">Welcome, {name}</h1>
      <p className="text-muted-foreground">Locations, Machines and Shots will appear here.</p>
    </section>
  );
}
