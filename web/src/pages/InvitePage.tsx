import { type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api, type Invite } from "@/lib/api";
import { AuthForm } from "./AuthForm";

type Offer =
  | { status: "loading" }
  | { status: "open"; invite: Invite; passwordMinLength: number }
  /** Used, expired, or naming no invite, with the server's reason. */
  | { status: "closed"; reason: string }
  | { status: "failed" };

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const LIST = new Intl.ListFormat(undefined, { type: "conjunction" });

/**
 * An invite link, opened by the person it was sent to: they choose a name
 * and password, and are signed in to the account the Admin chose. A link
 * that was used, has expired or names no invite says so.
 */
export function InvitePage() {
  const { secret = "" } = useParams();
  const { state, acceptInvite, signOut } = useAuth();
  const [offer, setOffer] = useState<Offer>({ status: "loading" });
  // Set while accepting, so the account it signs in goes on to the home page rather than the notice below.
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let current = true;
    api<{ invite: Invite; passwordMinLength: number }>("GET", `/invite-links/${encodeURIComponent(secret)}`).then(
      (open) => current && setOffer({ status: "open", ...open }),
      (error: unknown) => {
        if (!current) return;
        const closed = error instanceof ApiError && (error.status === 404 || error.status === 410);
        setOffer(closed ? { status: "closed", reason: error.message } : { status: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [secret]);

  if (state.status === "signed-in" && accepting) return <Navigate to="/" replace />;
  switch (offer.status) {
    case "loading":
      return null;
    case "failed":
      return (
        <InviteMessage title="The invite could not be loaded">
          <p role="alert">The Decent Sync server can't be reached. Reload the page to try again.</p>
        </InviteMessage>
      );
    case "closed":
      return (
        <InviteMessage title="This invite can no longer be used">
          <Alert variant="destructive">
            <AlertDescription>{offer.reason}</AlertDescription>
          </Alert>
          <Button variant="outline" asChild>
            {state.status === "signed-in" ? <Link to="/">Go to Decent Sync</Link> : <Link to="/sign-in">Sign in</Link>}
          </Button>
        </InviteMessage>
      );
  }

  if (state.status === "signed-in") {
    return (
      <InviteMessage
        title="You are already signed in"
        description={`You are signed in as ${state.account.name}. Sign out to accept this invite for ${offer.invite.email}.`}
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void signOut()}>Sign out</Button>
          <Button variant="outline" asChild>
            <Link to="/">Stay signed in</Link>
          </Button>
        </div>
      </InviteMessage>
    );
  }

  const { invite, passwordMinLength } = offer;
  return (
    <AuthForm
      title="Join Decent Sync"
      description={`${describeInvite(invite)} Choose your name and a password. The invite works once, until ${TIME.format(new Date(invite.expiresAt))}.`}
      submitLabel="Create account"
      fields={[
        { name: "name", label: "Name", type: "text", autoComplete: "name" },
        { name: "email", label: "Email", type: "email", autoComplete: "username", fixedValue: invite.email, hint: "You sign in with this email." },
        {
          name: "password",
          label: "Password",
          type: "password",
          autoComplete: "new-password",
          minLength: passwordMinLength,
          hint: `At least ${passwordMinLength} characters.`,
        },
      ]}
      onSubmit={async ({ name = "", password = "" }) => {
        setAccepting(true);
        try {
          await acceptInvite(secret, { name, password });
        } catch (error) {
          setAccepting(false);
          throw error;
        }
      }}
    />
  );
}

/** Who the invite makes its account. */
function describeInvite(invite: Invite): string {
  if (invite.role === "admin") return "You are invited as an Admin, who can change everything on this server.";
  return `You are invited as Staff at ${LIST.format(invite.locations.map((location) => location.name))}.`;
}

function InviteMessage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="grid gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}
