import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type Account, ApiError, api, lastRequestSent, onRefusal } from "@/lib/api";

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

  const refresh = useCallback(async () => {
    try {
      const { account } = await authApi<{ account: Account }>("GET", "/session");
      setState({ status: "signed-in", account });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setState({ status: "unreachable" });
        return;
      }
      try {
        const setup = await authApi<{ required: boolean; passwordMinLength: number }>("GET", "/setup");
        setState(
          setup.required
            ? { status: "signed-out", setupRequired: true, passwordMinLength: setup.passwordMinLength }
            : { status: "signed-out", setupRequired: false },
        );
      } catch {
        setState({ status: "unreachable" });
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signedIn = state.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    // Refusals that arrive together, such as a page's polls, share one read: it answers those that arrive
    // while it is under way, and those of requests sent before it that arrive after.
    let reading: Promise<void> | undefined;
    let sentBeforeRead = 0;
    return onRefusal((request) => {
      if (reading) return reading;
      if (request <= sentBeforeRead) return undefined;
      sentBeforeRead = lastRequestSent();
      reading = refresh().finally(() => {
        reading = undefined;
      });
      return reading;
    });
  }, [signedIn, refresh]);

  const auth = useMemo<Auth>(
    () => ({
      state,
      async setUp(input) {
        try {
          const { account } = await authApi<{ account: Account }>("POST", "/setup", input);
          setState({ status: "signed-in", account });
        } catch (error) {
          // Someone else finished setup first, so sign-in replaces this screen.
          if (error instanceof ApiError && error.status === 409) setState({ status: "signed-out", setupRequired: false });
          throw error;
        }
      },
      async signIn(input) {
        const { account } = await authApi<{ account: Account }>("POST", "/session", input);
        setState({ status: "signed-in", account });
      },
      async acceptInvite(secret, input) {
        const { account } = await authApi<{ account: Account }>("POST", `/invite-links/${encodeURIComponent(secret)}/accept`, input);
        setState({ status: "signed-in", account });
      },
      async redeemPasswordReset(secret, input) {
        const { account } = await authApi<{ account: Account }>(
          "POST",
          `/password-reset-links/${encodeURIComponent(secret)}/redeem`,
          input,
        );
        setState({ status: "signed-in", account });
      },
      async signOut() {
        try {
          await authApi("DELETE", "/session");
        } catch (error) {
          // Already signed out on the server, for example after it expired.
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
        setState({ status: "signed-out", setupRequired: false });
      },
      refresh,
    }),
    [state, refresh],
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
