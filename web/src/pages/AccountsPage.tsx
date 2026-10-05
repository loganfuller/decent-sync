import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/auth";
import { CopyField } from "@/components/copy-field";
import { ConfirmButton, formatTime, useLocations } from "@/components/machines";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type CreatedInvite, type Invite, type IssuedPasswordReset, type ManagedAccount } from "@/lib/api";

const LIST = new Intl.ListFormat(undefined, { type: "conjunction" });

/**
 * Accounts: the people who can sign in and the invites waiting to be used.
 * An Admin changes an account's role and Locations, deactivates it, issues
 * a password reset link, revokes an invite, and invites someone new.
 */
export function AccountsPage() {
  const { state, refresh } = useAuth();
  const me = state.status === "signed-in" ? state.account.id : undefined;
  const [accounts, setAccounts] = useState<ManagedAccount[]>();
  const [invites, setInvites] = useState<Invite[]>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  // Kept here, not in the forms, which clear for the next one.
  const [created, setCreated] = useState<CreatedInvite>();
  const [reset, setReset] = useState<IssuedPasswordReset>();

  const reload = useCallback(async () => {
    try {
      const [listed, waiting] = await Promise.all([
        api<{ accounts: ManagedAccount[] }>("GET", "/accounts"),
        api<{ invites: Invite[] }>("GET", "/invites"),
      ]);
      setAccounts(listed.accounts);
      setInvites(waiting.invites);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The accounts could not be loaded");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs a change from a row, showing why it failed if it does, then lists what changed. */
  async function act(change: () => Promise<void>, accountId?: string) {
    setActionError(undefined);
    try {
      await change();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong");
    }
    // A change to the signed-in account may sign them out, or leave them Staff, who cannot see this page.
    if (accountId !== undefined && accountId === me) await refresh();
    await reload();
  }

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
      {reset && <PasswordResetNotice key={reset.link} reset={reset} onDone={() => setReset(undefined)} />}

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {accounts && (
        <AccountTable
          accounts={accounts}
          me={me}
          onSaved={(account) => act(async () => undefined, account.id)}
          onResetPassword={(account) =>
            act(async () => setReset(await api<IssuedPasswordReset>("POST", `/accounts/${account.id}/password-reset`)))
          }
          onDeactivate={(account) => act(() => api("POST", `/accounts/${account.id}/deactivate`), account.id)}
          onReactivate={(account) => act(() => api("POST", `/accounts/${account.id}/reactivate`), account.id)}
        />
      )}

      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">Invites</h2>
        {invites?.length === 0 && <p className="text-muted-foreground">No invites are waiting to be used.</p>}
        {invites && invites.length > 0 && (
          <InviteTable invites={invites} onRevoke={(invite) => act(() => api("POST", `/invites/${invite.id}/revoke`))} />
        )}
      </div>

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
          <InviteForm
            onCreated={(invite) => {
              setCreated(invite);
              void reload();
            }}
          />
        </CardContent>
      </Card>
    </section>
  );
}

type Role = ManagedAccount["role"];

/** Who an account or invite is for: "an Admin", or Staff at the Locations they work at. */
function describeRole({ role, locations }: { role: Role; locations: { name: string }[] }): string {
  return role === "admin" ? "Admin" : `Staff at ${LIST.format(locations.map((location) => location.name))}`;
}

function AccountTable({
  accounts,
  me,
  onSaved,
  onResetPassword,
  onDeactivate,
  onReactivate,
}: {
  accounts: ManagedAccount[];
  me: string | undefined;
  onSaved(account: ManagedAccount): Promise<void>;
  onResetPassword(account: ManagedAccount): Promise<void>;
  onDeactivate(account: ManagedAccount): Promise<void>;
  onReactivate(account: ManagedAccount): Promise<void>;
}) {
  return (
    <div className="rounded-lg border">
      <Table aria-label="Accounts">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => (
            <TableRow key={account.id}>
              <TableCell className="font-medium">
                <span className="flex items-center gap-2">
                  {account.name}
                  {account.id === me && <Badge variant="secondary">You</Badge>}
                </span>
              </TableCell>
              <TableCell>{account.email}</TableCell>
              <TableCell className="whitespace-normal">{describeRole(account)}</TableCell>
              <TableCell>
                {account.deactivatedAt ? (
                  <span className="grid gap-0.5">
                    <Badge variant="outline">Deactivated</Badge>
                    <span className="text-xs text-muted-foreground">{formatTime(account.deactivatedAt)}</span>
                  </span>
                ) : (
                  <Badge variant="secondary">Active</Badge>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-2">
                  <EditAccess account={account} onSaved={onSaved} />
                  {account.deactivatedAt ? (
                    <Button variant="outline" aria-label={`Reactivate ${account.name}`} onClick={() => void onReactivate(account)}>
                      Reactivate
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        aria-label={`Reset ${account.name}'s password`}
                        onClick={() => void onResetPassword(account)}
                      >
                        Reset password
                      </Button>
                      <ConfirmButton
                        label="Deactivate"
                        ariaLabel={`Deactivate ${account.name}`}
                        title={account.id === me ? "Deactivate your own account?" : `Deactivate ${account.name}?`}
                        description={
                          account.id === me
                            ? "You are signed out everywhere, including here, and can no longer sign in. Another Admin can reactivate your account."
                            : `${account.name} is signed out everywhere and can no longer sign in. Their account is kept, and you can reactivate it later.`
                        }
                        confirmLabel="Deactivate"
                        variant="destructive"
                        onConfirm={() => void onDeactivate(account)}
                      />
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Changing an account's role and, for Staff, the Locations they work at, in a dialog. */
function EditAccess({ account, onSaved }: { account: ManagedAccount; onSaved(account: ManagedAccount): Promise<void> }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" aria-label={`Edit ${account.name}'s role`}>
          Edit role
        </Button>
      </DialogTrigger>
      {/* Its content mounts as it opens, so the form starts from the account as listed. */}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Role of {account.name}</DialogTitle>
          <DialogDescription>The change applies from their next request, on every device they are signed in on.</DialogDescription>
        </DialogHeader>
        <AccessForm
          account={account}
          onSaved={async (saved) => {
            setOpen(false);
            await onSaved(saved);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function AccessForm({ account, onSaved }: { account: ManagedAccount; onSaved(account: ManagedAccount): Promise<void> }) {
  const [role, setRole] = useState<Role>(account.role);
  const [locationIds, setLocationIds] = useState(account.locations.map((location) => location.id));
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const { account: saved } = await api<{ account: ManagedAccount }>("PUT", `/accounts/${account.id}/access`, {
        role,
        locationIds: role === "staff" ? locationIds : [],
      });
      await onSaved(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <form aria-label={`Role of ${account.name}`} className="grid gap-4" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <AccessFields role={role} onRoleChange={setRole} locationIds={locationIds} onLocationIdsChange={setLocationIds} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A role, and for Staff the Locations they work at: what an invite offers, and what an account may do. */
function AccessFields({
  role,
  onRoleChange,
  locationIds,
  onLocationIdsChange,
}: {
  role: Role;
  onRoleChange(role: Role): void;
  locationIds: string[];
  onLocationIdsChange(update: (current: string[]) => string[]): void;
}) {
  const id = useId();
  const { locations, error: locationsError } = useLocations();

  function choose(locationId: string, chosen: boolean) {
    onLocationIdsChange((current) => (chosen ? [...current, locationId] : current.filter((candidate) => candidate !== locationId)));
  }

  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-role`}>Role</Label>
        <Select value={role} onValueChange={(value) => onRoleChange(value as Role)}>
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
    </>
  );
}

function InviteTable({ invites, onRevoke }: { invites: Invite[]; onRevoke(invite: Invite): Promise<void> }) {
  return (
    <div className="rounded-lg border">
      <Table aria-label="Invites">
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invites.map((invite) => (
            <TableRow key={invite.id}>
              <TableCell className="font-medium">{invite.email}</TableCell>
              <TableCell className="whitespace-normal">{describeRole(invite)}</TableCell>
              <TableCell>{formatTime(invite.expiresAt)}</TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <ConfirmButton
                    label="Revoke"
                    ariaLabel={`Revoke the invite for ${invite.email}`}
                    title={`Revoke the invite for ${invite.email}?`}
                    description="Its link will say it was revoked. You can invite them again later."
                    confirmLabel="Revoke"
                    variant="destructive"
                    onConfirm={() => void onRevoke(invite)}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Who an invite is for: their email, their role and, for Staff, the Locations they work at. */
function InviteForm({ onCreated }: { onCreated(created: CreatedInvite): void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

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
      <AccessFields role={role} onRoleChange={setRole} locationIds={locationIds} onLocationIdsChange={setLocationIds} />
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
  const { invite, link } = created;
  const as = invite.role === "admin" ? "an Admin" : describeRole(invite);

  return (
    <LinkNotice
      title={`Invite for ${invite.email}`}
      description={`Send this link to ${invite.email}. Opening it, they choose a name and password and are signed in as ${as}.`}
      expiry={`It will not be shown again. It works once, until ${formatTime(invite.expiresAt)}; if it is lost, create another invite.`}
      label="Invite link"
      link={link}
      onDone={onDone}
    />
  );
}

/**
 * A new password reset link, to copy and send. The server returns a link
 * only once, so this is the only time it is shown.
 */
function PasswordResetNotice({ reset, onDone }: { reset: IssuedPasswordReset; onDone(): void }) {
  const { account, link, expiresAt } = reset;

  return (
    <LinkNotice
      title={`Password reset link for ${account.name}`}
      description={`Send this link to ${account.name}. Opening it, they choose a new password and are signed in; their other sessions end.`}
      expiry={`It will not be shown again. It works once, until ${formatTime(expiresAt)}; if it is lost, reset their password again, which replaces this link.`}
      label="Password reset link"
      link={link}
      onDone={onDone}
    />
  );
}

/** A one-time link the server shows once, brought into view since the button that made it may be far down the page. */
function LinkNotice({
  title,
  description,
  expiry,
  label,
  link,
  onDone,
}: {
  title: string;
  description: string;
  expiry: string;
  label: string;
  link: string;
  onDone(): void;
}) {
  const titleId = useId();
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    card.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return (
    <Card ref={card} role="region" aria-labelledby={titleId} className="max-w-2xl border-primary">
      <CardHeader>
        <CardTitle>
          <h2 id={titleId}>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert>
          <AlertTitle>Copy the link now</AlertTitle>
          <AlertDescription>{expiry}</AlertDescription>
        </Alert>
        <CopyField label={label} value={link} />
      </CardContent>
      <CardFooter>
        <Button onClick={onDone}>Done</Button>
      </CardFooter>
    </Card>
  );
}
