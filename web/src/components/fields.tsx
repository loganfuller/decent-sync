import type { ReactNode } from "react";

/** Terms and their values, such as a Machine's identity, as a labelled description list. */
export function Fields({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl aria-label={label} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {children}
    </dl>
  );
}

export function Field({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </>
  );
}
