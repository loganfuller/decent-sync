import { type ProfileStep, type StepExit, stepTarget } from "@decent-sync/protocol";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useMayChange } from "@/auth";
import { ItemConflictsCard, ItemHistoryCard } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ItemShotsCard } from "@/components/item-shots";
import { formatTime } from "@/components/machines";
import { ArchiveButton, ContentForm, DeleteButton, PROFILE_FIELDS } from "@/components/library-forms";
import { ProfileBadges, ProfileLocationsCard, profilePath, profileTitle } from "@/components/profiles";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Profile } from "@/lib/api";

/** One Profile: the Locations showing it, which can be changed there, its title, author and notes, which can be edited here, what the machine follows, and where it came from. */
export function ProfilePage() {
  const { id = "" } = useParams();
  return <ProfileDetails key={id} id={id} />;
}

function ProfileDetails({ id }: { id: string }) {
  const mayChange = useMayChange();
  const [profile, setProfile] = useState<Profile>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
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

  const definition = profile.profile;
  const steps = definition?.steps ?? [];
  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {profileTitle(profile)} <ProfileBadges profile={profile} />
        </h1>
        <p className="font-mono text-sm text-muted-foreground">{profile.id}</p>
      </div>
      {mayChange && (
        <div className="flex flex-wrap items-start gap-2">
          <ArchiveButton path={path} name={profileTitle(profile)} archived={profile.archived} effect="hidden on every tablet that holds it" onDone={changed} />
          {!profile.bundled && <DeleteButton path={path} name={profileTitle(profile)} back="/library/profiles" />}
        </div>
      )}

      <ItemConflictsCard kind="profile" id={id} onResolved={changed} />

      <ProfileLocationsCard profile={profile} onChanged={changed} />

      <Card>
        <CardHeader>
          <CardTitleWithInfo title="Title, author and notes">
            {profile.bundled ? (
              <p>One of Decaid&apos;s bundled Profiles, which keep the title, author and notes Decaid gives them.</p>
            ) : (
              <p>
                Outside the steps that decide the Profile&apos;s id, so a change here keeps it the same Profile, and every tablet that holds it is written the change. Its title can&apos;t
                be cleared.
              </p>
            )}
          </CardTitleWithInfo>
        </CardHeader>
        <CardContent className="grid gap-4">
          {/* Closed if the account may no longer save it, as when an Admin made it a Viewer meanwhile. */}
          {editing && mayChange && !profile.bundled ? (
            <ContentForm
              label="Edit the title, author and notes"
              fields={PROFILE_FIELDS}
              content={{ title: definition?.title ?? profile.title, author: definition?.author ?? profile.author, notes: definition?.notes }}
              path={path}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                changed();
              }}
            />
          ) : (
            <>
              <Fields label="Title, author and notes">
                <Field term="Title">
                  <OrNone>{text(definition?.title ?? profile.title)}</OrNone>
                </Field>
                <Field term="Author">
                  <OrNone>{text(definition?.author ?? profile.author)}</OrNone>
                </Field>
                <Field term="Notes">
                  <OrNone>{text(definition?.notes)}</OrNone>
                </Field>
              </Fields>
              {mayChange && !profile.bundled && (
                <div>
                  <Button variant="outline" aria-label="Edit the title, author and notes" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitleWithInfo title="Profile">
              <p>As the tablet that created it recorded it, with the edits made since.</p>
            </CardTitleWithInfo>
          </CardHeader>
          <CardContent>
            <Fields label="Profile">
              <Field term="Beverage">
                <OrNone>{definition?.beverage_type}</OrNone>
              </Field>
              <Field term="Target weight">
                <OrNone>{target(definition?.target_weight, "g")}</OrNone>
              </Field>
              <Field term="Target volume">
                <OrNone>{target(definition?.target_volume, "ml")}</OrNone>
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
          <CardTitleWithInfo title="Steps">
            <p>What the machine follows, which decides the Profile's id: new steps make a new Profile.</p>
          </CardTitleWithInfo>
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
                  <TableCell>{`${step.temperature} °C`}</TableCell>
                  <TableCell>{`${step.seconds} s`}</TableCell>
                  <TableCell>{exitText(step.exit)}</TableCell>
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
function pumpText(step: ProfileStep): string {
  return step.pump === "pressure" ? `Pressure ${stepTarget(step)} bar` : `Flow ${stepTarget(step)} ml/s`;
}

/** A step's exit condition, such as "pressure over 3". */
function exitText(exit: StepExit | null): string {
  return exit ? `${exit.type} ${exit.condition} ${exit.value}` : "-";
}

/** A target, such as a weight to stop at, which Decaid records as 0 or null when there is none. */
function target(value: number | null | undefined, unit: string): string | undefined {
  return value === null || value === undefined || value === 0 ? undefined : `${value} ${unit}`;
}

function text(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
