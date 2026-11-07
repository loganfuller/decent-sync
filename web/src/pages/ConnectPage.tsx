import { type ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useAuth } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ApiError, api } from "@/lib/api";
import { CentredPage } from "./AuthForm";

/** An app's request to connect, as the server shows it to the signed-in account. */
interface ConnectRequest {
  client: { id: string; host: string; name: string; logoUri: string | null };
  /** What the account may allow it: `read`, and `change` if the app asked for it and the account is not a Viewer. */
  scopes: string[];
}

type Offer =
  | { status: "loading" }
  | { status: "open"; request: ConnectRequest }
  /** Expired, answered already, or naming no request, with the server's reason. */
  | { status: "closed"; reason: string }
  | { status: "failed" };

type Access = "read" | "change";

const ACCESS: Record<Access, { label: string; description: string }> = {
  read: { label: "Read", description: "See what you can see in Decent Sync." },
  change: { label: "Read and change", description: "Also change what you can change, but never accounts, and never delete anything for good." },
};

/**
 * The consent page of the authorization server (ADR-0027), where an app such
 * as Claude sends the person connecting it: the host its client id is
 * published at, above the name and logo it gives itself, which any page
 * could make "Claude"; the account it will act as; and whether it may only
 * read, or read and change, which a Viewer is not offered. Allowing it makes
 * a Connected App; either answer sends the browser back to the app. Someone
 * not signed in signs in first and comes back (`Gate`).
 */
export function ConnectPage() {
  const { id = "" } = useParams();
  const { state } = useAuth();
  const [offer, setOffer] = useState<Offer>({ status: "loading" });
  const [access, setAccess] = useState<Access>("read");
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    api<{ request: ConnectRequest }>("GET", `/oauth/requests/${encodeURIComponent(id)}`).then(
      ({ request }) => current && setOffer({ status: "open", request }),
      (caught: unknown) => {
        if (!current) return;
        setOffer(caught instanceof ApiError && caught.status === 404 ? { status: "closed", reason: caught.message } : { status: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  async function respond(choice: "approve" | "deny") {
    setAnswering(true);
    setError(undefined);
    try {
      const body = choice === "approve" ? { scopes: access === "change" ? ["read", "change"] : ["read"] } : {};
      const { redirect } = await api<{ redirect: string }>("POST", `/oauth/requests/${encodeURIComponent(id)}/${choice}`, body);
      window.location.assign(redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
      setAnswering(false);
    }
  }

  if (state.status !== "signed-in") return null;
  const { account } = state;
  switch (offer.status) {
    case "loading":
      return null;
    case "failed":
      return (
        <Message title="The app's request could not be loaded">
          <p role="alert">The Decent Sync server can't be reached. Reload the page to try again.</p>
        </Message>
      );
    case "closed":
      return (
        <Message title="This request to connect can no longer be used">
          <Alert variant="destructive">
            <AlertDescription>{offer.reason}</AlertDescription>
          </Alert>
          <Button variant="outline" asChild>
            <Link to="/">Go to Decent Sync</Link>
          </Button>
        </Message>
      );
  }

  const { client, scopes } = offer.request;
  const mayChange = scopes.includes("change");
  return (
    <CentredPage>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-sm font-medium wrap-anywhere text-muted-foreground">{client.host}</p>
          <div className="flex items-center gap-3">
            {client.logoUri && <AppLogo src={client.logoUri} />}
            <CardTitle className="min-w-0">
              <h1 className="wrap-anywhere">Connect {client.name}?</h1>
            </CardTitle>
          </div>
          <CardDescription>
            It will act as you, {account.name} ({account.email}), within what your account may do.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {mayChange ? (
            <RadioGroup aria-label="What it may do" value={access} onValueChange={(value) => setAccess(value as Access)}>
              {(["read", "change"] as const).map((choice) => (
                <div key={choice} className="flex items-start gap-3">
                  <RadioGroupItem id={`access-${choice}`} value={choice} aria-describedby={`access-${choice}-description`} className="mt-0.5" />
                  <div className="grid gap-1">
                    <Label htmlFor={`access-${choice}`}>{ACCESS[choice].label}</Label>
                    <p id={`access-${choice}-description`} className="text-sm text-muted-foreground">
                      {ACCESS[choice].description}
                    </p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          ) : (
            <section aria-label="What it may do" className="grid gap-1">
              <p className="text-sm font-medium">{ACCESS.read.label}</p>
              <p className="text-sm text-muted-foreground">
                {ACCESS.read.description} {account.role === "viewer" ? "As a Viewer, you can allow an app only to read." : "It asked only to read."}
              </p>
            </section>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void respond("approve")} disabled={answering}>
              Allow
            </Button>
            <Button variant="outline" onClick={() => void respond("deny")} disabled={answering}>
              Deny
            </Button>
          </div>
        </CardContent>
      </Card>
    </CentredPage>
  );
}

/** The logo the app gives itself, left out if it doesn't load. */
function AppLogo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt="" className="size-10 shrink-0 rounded-md object-contain" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <CentredPage>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">{children}</CardContent>
      </Card>
    </CentredPage>
  );
}
