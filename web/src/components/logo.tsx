import logo from "@/assets/decent-sync-logo.svg";
import logoDark from "@/assets/decent-sync-logo-dark.svg";
import logomark from "@/assets/decent-sync-logomark.svg";
import { cn } from "@/lib/utils";

/**
 * The full logo: the bean and "Decent Sync". Its lettering is black in the light theme and white in the dark, each a
 * drawing of its own, so it is two images, and the theme in effect shows one. Size it by its height, in `className`.
 */
export function Logo({ className }: { className: string }) {
  return (
    <>
      <img src={logo} alt="Decent Sync" width={2030} height={443} className={cn("block w-auto dark:hidden", className)} />
      <img src={logoDark} alt="Decent Sync" width={2030} height={443} className={cn("hidden w-auto dark:block", className)} />
    </>
  );
}

/** The bean alone, the same in both themes, beside text that names Decent Sync, so a screen reader passes over it. */
export function Logomark({ className }: { className: string }) {
  return <img src={logomark} alt="" width={442} height={443} className={cn("shrink-0", className)} />;
}
