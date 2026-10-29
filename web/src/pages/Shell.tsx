import { MenuIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth, useIsAdmin } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { chooseTheme, type ThemeChoice, useThemeChoice } from "@/lib/theme";

/**
 * The signed-in frame: a header with the account and sign-out, in a menu on a narrow screen, and a page. The theme
 * button stays in the header at every width.
 */
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
          {/* With an Admin's links, a short name and the theme button the row needs about 810 px, so below lg (1024),
              an iPad held upright included, it is in a menu. Its links don't wrap: a longer name truncates instead. */}
          <div className="hidden min-w-0 flex-1 items-center gap-4 lg:flex">
            <MainNav className="flex flex-1 items-center gap-4 text-sm whitespace-nowrap" />
            {account && (
              <span className="min-w-0 truncate text-sm text-muted-foreground" data-testid="signed-in-account">
                {account.name}
              </span>
            )}
          </div>
          <ThemeMenu className="ml-auto lg:ml-0 lg:size-7" />
          <Button variant="outline" size="sm" className="hidden lg:inline-flex" onClick={handleSignOut} disabled={signingOut}>
            Sign out
          </Button>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="lg:hidden">
                <MenuIcon />
                <span className="sr-only">Menu</span>
              </Button>
            </SheetTrigger>
            {/* Scrolls on a small phone held sideways, which still gets the menu, so Sign out stays in reach. Opens with
                focus on the first link, where Radix would pass over the links to Sign out. */}
            <SheetContent
              className="overflow-y-auto"
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                (event.currentTarget as HTMLElement).querySelector("a")?.focus();
              }}
            >
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

const THEMES: { choice: ThemeChoice; label: string; Icon: typeof SunIcon }[] = [
  { choice: "light", label: "Light", Icon: SunIcon },
  { choice: "dark", label: "Dark", Icon: MoonIcon },
  { choice: "system", label: "System", Icon: MonitorIcon },
];

/**
 * The theme button, whose icon shows the choice rather than the theme in effect, so someone on System sees that the
 * page follows their device. The choice is kept in this browser (`src/lib/theme.ts`).
 */
function ThemeMenu({ className }: { className: string }) {
  const choice = useThemeChoice();
  const { Icon } = THEMES.find((theme) => theme.choice === choice)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className={className}>
          <Icon />
          <span className="sr-only">Theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={choice} onValueChange={(value) => chooseTheme(value as ThemeChoice)}>
          {THEMES.map(({ choice, label, Icon }) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
