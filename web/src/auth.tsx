import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Account, ApiError, api, onRefusal } from "@/lib/api";

type AuthState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "signed-out"; setupRequired: false }
  | { status: "signed-out"; setupRequired: true; passwordMinLength: number }
  | { status: "signed-in"; account: Account };

interface Auth {
  state: AuthState;
  setUp(input: { name: string; email: string; password: string }): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<void>;
  /** Creates the account an invite link offers, and signs it in. */
  acceptInvite(secret: string, input: { name: string; password: string }): Promise<void>;
  /** Sets the new password a password reset link offers, and signs its account in. */
  redeemPasswordReset(secret: string, input: { password: string }): Promise<void>;
  signOut(): Promise<void>;
  /** Reads who is signed in again, such as after an Admin changes their own account. */
  refresh(): Promise<void>;
}

// The auth flows' own requests. A refusal answers the request alone, such as a wrong password at sign-in or
// nobody signed in at the session check, so it is not reported; the session check would otherwise wait for itself.
function authApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  return api<T>(method, path, body, { reportRefusal: false });
}

/** Who is signed in now, as the server says. */
async function readSession(): Promise<AuthState> {
  try {
    const { account } = await authApi<{ account: Account }>("GET", "/session");
    return { status: "signed-in", account };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) return { status: "unreachable" };
    try {
      const setup = await authApi<{ required: boolean; passwordMinLength: number }>("GET", "/setup");
      return setup.required
        ? { status: "signed-out", setupRequired: true, passwordMinLength: setup.passwordMinLength }
        : { status: "signed-out", setupRequired: false };
    } catch {
      return { status: "unreachable" };
    }
  }
}

const AuthContext = createContext<Auth | undefined>(undefined);

/**
 * Who is signed in, and whether the server still needs its first Admin.
 * While someone is signed in, any request the server refuses with 401 or 403
 * reads the session again before its caller sees the refusal. A session
 * that ended signs them out, so Gate sends them to sign-in; a changed role
 * or set of Locations applies at once.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  // Counts the session reads started and the sign-ins and sign-outs made here. A read's answer applies only if
  // nothing started or changed after it, so one the server answered before someone signed out can't sign them back in.
  const changes = useRef(0);

  const change = useCallback((next: AuthState) => {
    changes.current++;
    setState(next);
  }, []);

  const reread = useCallback(async () => {
    const started = ++changes.current;
    const read = await readSession();
    if (changes.current === started) setState(read);
    return read;
  }, []);

  useEffect(() => {
    void reread();
  }, [reread]);

  const signedIn = state.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    // The server may have answered a read already under way before it refused a request, even one sent first, so
    // only a read sent after a refusal arrives answers it. Refusals that arrive during a read share the next one.
    let reading: Promise<AuthState> | undefined;
    let following: Promise<AuthState> | undefined;
    let signedOut = false;
    const read = (): Promise<AuthState> => {
      if (!reading) {
        return (reading = reread().finally(() => {
          reading = undefined;
        }));
      }
      return (following ??= reading.then((found) => {
        following = undefined;
        // Finding nobody signed in, or the server unreachable, answers them all: Gate is leaving the page.
        return found.status === "signed-in" ? read() : found;
      }));
    };
    return onRefusal(async () => {
      // A read found nobody signed in, or the server unreachable, and Gate is leaving the page.
      if (signedOut) return;
      if ((await read()).status !== "signed-in") signedOut = true;
    });
  }, [signedIn, reread]);

  const auth = useMemo<Auth>(
    () => ({
      state,
      async setUp(input) {
        try {
          const { account } = await authApi<{ account: Account }>("POST", "/setup", input);
          change({ status: "signed-in", account });
        } catch (error) {
          // Someone else finished setup first, so sign-in replaces this screen.
          if (error instanceof ApiError && error.status === 409) change({ status: "signed-out", setupRequired: false });
          throw error;
        }
      },
      async signIn(input) {
        const { account } = await authApi<{ account: Account }>("POST", "/session", input);
        change({ status: "signed-in", account });
      },
      async acceptInvite(secret, input) {
        const { account } = await authApi<{ account: Account }>("POST", `/invite-links/${encodeURIComponent(secret)}/accept`, input);
        change({ status: "signed-in", account });
      },
      async redeemPasswordReset(secret, input) {
        const { account } = await authApi<{ account: Account }>(
          "POST",
          `/password-reset-links/${encodeURIComponent(secret)}/redeem`,
          input,
        );
        change({ status: "signed-in", account });
      },
      async signOut() {
        try {
          await authApi("DELETE", "/session");
        } catch (error) {
          // Already signed out on the server, for example after it expired.
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
        change({ status: "signed-out", setupRequired: false });
      },
      async refresh() {
        await reread();
      },
    }),
    [state, change, reread],
  );

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth needs an AuthProvider");
  return auth;
}

/**
 * Whether the signed-in account is an Admin. Staff read everything but other
 * accounts' personal information, and change only which of their Locations a
 * Machine is at; pages leave out what Staff cannot do.
 */
export function useIsAdmin(): boolean {
  const { state } = useAuth();
  return state.status === "signed-in" && state.account.role === "admin";
}

/** The ids of the Locations a signed-in Staff member works at; none for an Admin or while signed out. */
export function useStaffLocationIds(): Set<string> {
  const { state } = useAuth();
  const locations = state.status === "signed-in" ? state.account.locations : [];
  return useMemo(() => new Set(locations.map((location) => location.id)), [locations]);
}
