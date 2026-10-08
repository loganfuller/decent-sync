import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Field, Fields } from "@/components/fields";
import { formatTime } from "@/components/machines";
import { ProfileBadges, profilePath, profileTitle } from "@/components/profiles";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Profile } from "@/lib/api";

/** One Profile: the Locations showing it, what the machine follows, and where it came from. */
export function ProfilePage() {
  const { id = "" } = useParams();
  return <ProfileDetails key={id} id={id} />;
}

function ProfileDetails({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();

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
  }, [id]);

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

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Locations</h2>
          </CardTitle>
          <CardDescription>
            Where it is shown, each since the edit that showed it there, by the clock of the tablet that made it. Each
            Location's tablets hold it visible there, and hidden, never deleted, everywhere else they hold it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {profile.archived ? (
            <p className="text-sm text-muted-foreground">It is Archived, so it is shown nowhere.</p>
          ) : profile.shownAt.length === 0 ? (
            <p className="text-sm text-muted-foreground">It is shown at no Location.</p>
          ) : (
            <Table aria-label="Shown at">
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>Shown since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.shownAt.map((here) => (
                  <TableRow key={here.location.id}>
                    <TableCell className="font-medium">{here.location.name}</TableCell>
                    <TableCell>{formatTime(here.since)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Profile</h2>
            </CardTitle>
            <CardDescription>As the tablet that created it recorded it.</CardDescription>
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
