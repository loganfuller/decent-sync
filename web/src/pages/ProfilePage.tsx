import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ItemConflictsCard, ItemHistoryCard } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { ItemShotsCard } from "@/components/item-shots";
import { formatTime } from "@/components/machines";
import { ArchiveButton, DeleteButton } from "@/components/library-forms";
import { ProfileBadges, ProfileLocationsCard, profilePath, profileTitle } from "@/components/profiles";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Profile } from "@/lib/api";

/** One Profile: the Locations showing it, which can be changed there, what the machine follows, and where it came from. */
export function ProfilePage() {
  const { id = "" } = useParams();
  return <ProfileDetails key={id} id={id} />;
}

function ProfileDetails({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // Using a Conflict\'s value, or a change here, changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const changed = () => setChanges((count) => count + 1);
  const path = `/profiles/${encodeURIComponent(id)}`;

  useEffect(() => {
    let current = true;
    api<{ profile: Profile }>("GET", `/profiles/${encodeURIComponent(id)}`).then(
      ({ profile }) => current && setProfile(profile),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Profile could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id, changes]);

  const back = (
    <Link to="/library/profiles" className="text-sm text-muted-foreground hover:text-foreground">
      ← Profiles
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Profile.</p>
      </section>
    );
  }
  if (!profile) {
    return (
      <section className="grid gap-4">
        {back}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    );
  }

  const content = object(profile.content.profile);
  const steps = Array.isArray(content.steps) ? content.steps.map(object) : [];
  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {profileTitle(profile)} <ProfileBadges profile={profile} />
        </h1>
        <p className="font-mono text-sm text-muted-foreground">{profile.id}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <ArchiveButton path={path} name={profileTitle(profile)} archived={profile.archived} effect="hidden on every tablet that holds it" onDone={changed} />
        {!profile.bundled && <DeleteButton path={path} name={profileTitle(profile)} back="/library/profiles" />}
      </div>

      <ItemConflictsCard kind="profile" id={id} onResolved={changed} />

      <ProfileLocationsCard profile={profile} onChanged={changed} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Profile</h2>
            </CardTitle>
            <CardDescription>As the tablet that created it recorded it, with the edits made since.</CardDescription>
          </CardHeader>
          <CardContent>
            <Fields label="Profile">
              <Field term="Author">
                <OrNone>{text(content.author)}</OrNone>
              </Field>
              <Field term="Beverage">
                <OrNone>{text(content.beverage_type)}</OrNone>
              </Field>
              <Field term="Target weight">
                <OrNone>{target(content.target_weight, "g")}</OrNone>
              </Field>
              <Field term="Target volume">
                <OrNone>{target(content.target_volume, "ml")}</OrNone>
              </Field>
              <Field term="Notes">
                <OrNone>{text(content.notes)}</OrNone>
              </Field>
            </Fields>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>In the Library</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Fields label="In the Library">
              <Field term="Created at">
                <OrNone>{profile.createdLocation?.name}</OrNone>
              </Field>
              <Field term="Joined">{formatTime(profile.createdAt)}</Field>
              <Field term="Saved from">
                {profile.parent ? (
                  <Link to={profilePath(profile.parent.id)} className="underline-offset-4 hover:underline">
                    {profileTitle(profile.parent)}
                  </Link>
                ) : (
                  <OrNone>{undefined}</OrNone>
                )}
              </Field>
            </Fields>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Steps</h2>
          </CardTitle>
          <CardDescription>What the machine follows, which decides the Profile's id: new steps make a new Profile.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table aria-label="Steps">
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Pump</TableHead>
                <TableHead>Temperature</TableHead>
                <TableHead>Up to</TableHead>
                <TableHead>Exit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((step, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">{text(step.name) ?? `Step ${index + 1}`}</TableCell>
                  <TableCell>{pumpText(step)}</TableCell>
                  <TableCell>{number(step.temperature) === undefined ? "-" : `${number(step.temperature)} °C`}</TableCell>
                  <TableCell>{number(step.seconds) === undefined ? "-" : `${number(step.seconds)} s`}</TableCell>
                  <TableCell>{exitText(object(step.exit))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ItemShotsCard kind="profile" id={id} />

      <ItemHistoryCard key={changes} kind="profile" id={id} />
    </section>
  );
}

/** A step's pump target, such as "Pressure 9 bar" or "Flow 4 ml/s". */
function pumpText(step: Record<string, unknown>): string {
  if (step.pump === "pressure") return number(step.pressure) === undefined ? "Pressure" : `Pressure ${number(step.pressure)} bar`;
  if (step.pump === "flow") return number(step.flow) === undefined ? "Flow" : `Flow ${number(step.flow)} ml/s`;
  return "-";
}

/** A step's exit condition, such as "pressure over 3". */
function exitText(exit: Record<string, unknown>): string {
  const [type, condition, value] = [text(exit.type), text(exit.condition), number(exit.value)];
  return type && condition && value !== undefined ? `${type} ${condition} ${value}` : "-";
}

/** A target, such as a weight to stop at, which Decaid records as 0 or null when there is none. */
function target(value: unknown, unit: string): string | undefined {
  const amount = number(value);
  return amount === undefined || amount === 0 ? undefined : `${amount} ${unit}`;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
