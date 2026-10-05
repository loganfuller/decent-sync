import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, api, type PasswordReset } from "@/lib/api";
import { AuthForm, AuthMessage } from "./AuthForm";

type Offer =
  | { status: "loading" }
  | { status: "open"; passwordReset: PasswordReset; passwordMinLength: number }
  /** Used, expired, replaced, or naming no link, with the server's reason. */
  | { status: "closed"; reason: string }
  | { status: "failed" };

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * A password reset link, opened by the person an Admin sent it to: they
 * choose a new password and are signed in, and their account's other
 * sessions end. A link that was used, has expired or names nothing says so.
 */
export function ResetPasswordPage() {
  const { secret = "" } = useParams();
  const { state, redeemPasswordReset, signOut } = useAuth();
  const [offer, setOffer] = useState<Offer>({ status: "loading" });
  // Set while redeeming, so the account it signs in goes on to the home page rather than the notice below.
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => {
    let current = true;
    api<{ passwordReset: PasswordReset; passwordMinLength: number }>(
      "GET",
      `/password-reset-links/${encodeURIComponent(secret)}`,
    ).then(
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

  if (state.status === "signed-in" && redeeming) return <Navigate to="/" replace />;
  switch (offer.status) {
    case "loading":
      return null;
    case "failed":
      return (
        <AuthMessage title="The link could not be loaded">
          <p role="alert">The Decent Sync server can't be reached. Reload the page to try again.</p>
        </AuthMessage>
      );
    case "closed":
      return (
        <AuthMessage title="This link can no longer be used">
          <Alert variant="destructive">
            <AlertDescription>{offer.reason}</AlertDescription>
          </Alert>
          <Button variant="outline" asChild>
            {state.status === "signed-in" ? <Link to="/">Go to Decent Sync</Link> : <Link to="/sign-in">Sign in</Link>}
          </Button>
        </AuthMessage>
      );
  }

  const { passwordReset, passwordMinLength } = offer;
  if (state.status === "signed-in") {
    return (
      <AuthMessage
        title="You are already signed in"
        description={`You are signed in as ${state.account.name}. Sign out to set a new password for ${passwordReset.email}.`}
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void signOut()}>Sign out</Button>
          <Button variant="outline" asChild>
            <Link to="/">Stay signed in</Link>
          </Button>
        </div>
      </AuthMessage>
    );
  }

  return (
    <AuthForm
      title="Choose a new password"
      description={`An Admin sent you this link to set a new password for ${passwordReset.name}. It works once, until ${TIME.format(new Date(passwordReset.expiresAt))}, and signs you out everywhere else.`}
      submitLabel="Set password"
      fields={[
        {
          name: "email",
          label: "Email",
          type: "email",
          autoComplete: "username",
          fixedValue: passwordReset.email,
          hint: "You sign in with this email.",
        },
        {
          name: "password",
          label: "New password",
          type: "password",
          autoComplete: "new-password",
          minLength: passwordMinLength,
          hint: `At least ${passwordMinLength} characters.`,
        },
      ]}
      onSubmit={async ({ password = "" }) => {
        setRedeeming(true);
        try {
          await redeemPasswordReset(secret, { password });
        } catch (error) {
          setRedeeming(false);
          throw error;
        }
      }}
    />
  );
}
