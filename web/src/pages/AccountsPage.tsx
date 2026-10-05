import { type FormEvent, useId, useState } from "react";
import { CopyField } from "@/components/copy-field";
import { formatTime, useLocations } from "@/components/machines";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type CreatedInvite, type Invite } from "@/lib/api";

const LIST = new Intl.ListFormat(undefined, { type: "conjunction" });

/** Accounts: inviting people with one-time links an Admin sends them. */
export function AccountsPage() {
  // Kept here, not in the form, which clears for the next invite.
  const [created, setCreated] = useState<CreatedInvite>();

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-muted-foreground">
          The people who can sign in to this server. Invite someone with a one-time link that you send them yourself.
        </p>
      </div>

      {/* Keyed, so a new link never inherits the last one's "Copied". */}
      {created && <InviteLinkNotice key={created.link} created={created} onDone={() => setCreated(undefined)} />}

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>
            <h2>Invite someone</h2>
          </CardTitle>
          <CardDescription>
            Admins can change everything on this server. Staff can see everything except other people's accounts, and
            can move Machines between the Locations they work at.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InviteForm onCreated={setCreated} />
        </CardContent>
      </Card>
    </section>
  );
}

type Role = Invite["role"];

/** Who an invite is for: their email, their role and, for Staff, the Locations they work at. */
function InviteForm({ onCreated }: { onCreated(created: CreatedInvite): void }) {
  const id = useId();
  const { locations, error: locationsError } = useLocations();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function choose(locationId: string, chosen: boolean) {
    setLocationIds((current) => (chosen ? [...current, locationId] : current.filter((candidate) => candidate !== locationId)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      onCreated(await api<CreatedInvite>("POST", "/invites", { email, role, locationIds: role === "staff" ? locationIds : [] }));
      setEmail("");
      setLocationIds([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label="Invite someone" className="grid gap-4" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={`${id}-email-hint`}
          autoComplete="off"
          required
        />
        <p id={`${id}-email-hint`} className="text-sm text-muted-foreground">
          The email they will sign in with.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-role`}>Role</Label>
        <Select value={role} onValueChange={(value) => setRole(value as Role)}>
          <SelectTrigger id={`${id}-role`} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="staff">Staff</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {role === "staff" && (
        <FieldSet>
          <FieldLegend variant="label">Locations they work at</FieldLegend>
          {locationsError && <FieldError>{locationsError}</FieldError>}
          {locations?.length === 0 && (
            <FieldDescription>There are no Locations yet. Add one before inviting Staff.</FieldDescription>
          )}
          <FieldGroup data-slot="checkbox-group">
            {locations?.map((location) => (
              <Field key={location.id} orientation="horizontal">
                <Checkbox
                  id={`${id}-location-${location.id}`}
                  checked={locationIds.includes(location.id)}
                  onCheckedChange={(checked) => choose(location.id, checked === true)}
                />
                <FieldLabel htmlFor={`${id}-location-${location.id}`} className="font-normal">
                  {location.name}
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
      )}
      <div>
        <Button type="submit" disabled={submitting}>
          Create invite
        </Button>
      </div>
    </form>
  );
}

/**
 * A new invite's link, to copy and send. The server returns a link only
 * once, so this is the only time it is shown.
 */
function InviteLinkNotice({ created, onDone }: { created: CreatedInvite; onDone(): void }) {
  const titleId = useId();
  const { invite, link } = created;
  const as =
    invite.role === "admin" ? "an Admin" : `Staff at ${LIST.format(invite.locations.map((location) => location.name))}`;

  return (
    <Card role="region" aria-labelledby={titleId} className="max-w-2xl border-primary">
      <CardHeader>
        <CardTitle>
          <h2 id={titleId}>Invite for {invite.email}</h2>
        </CardTitle>
        <CardDescription>
          Send this link to {invite.email}. Opening it, they choose a name and password and are signed in as {as}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert>
          <AlertTitle>Copy the link now</AlertTitle>
          <AlertDescription>
            It will not be shown again. It works once, until {formatTime(invite.expiresAt)}; if it is lost, create another
            invite.
          </AlertDescription>
        </Alert>
        <CopyField label="Invite link" value={link} />
      </CardContent>
      <CardFooter>
        <Button onClick={onDone}>Done</Button>
      </CardFooter>
    </Card>
  );
}
