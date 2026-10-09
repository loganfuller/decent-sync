import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ItemConflictsCard, ItemHistoryCard } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { GrinderBadges, grinderLocationText, grinderName } from "@/components/grinders";
import { ArchiveButton, ContentForm, DeleteButton, GRINDER_FIELDS, useMayChangeAt } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api, type Grinder } from "@/lib/api";

/** The content fields a Grinder's page names after its model, in Decaid's order, with how each is shown. */
const CONTENT: [key: string, term: string, unit?: string][] = [
  ["burrs", "Burrs"],
  ["burrSize", "Burr size", "mm"],
  ["burrType", "Burr type"],
  ["notes", "Notes"],
];

/** The setting steps a Grinder's page names, in Decaid's order. */
const STEPS: [key: string, term: string][] = [
  ["settingSmallStep", "Small step"],
  ["settingBigStep", "Big step"],
  ["rpmSmallStep", "RPM small step"],
  ["rpmBigStep", "RPM big step"],
];

/** One Grinder: what it is, and the Location it belongs to. */
export function GrinderPage() {
  const { id = "" } = useParams();
  return <GrinderDetails key={id} id={id} />;
}

function GrinderDetails({ id }: { id: string }) {
  const [grinder, setGrinder] = useState<Grinder>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // Using a Conflict\'s value, or an edit here, changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const [editing, setEditing] = useState(false);
  const changed = () => setChanges((count) => count + 1);
  const mayChangeAt = useMayChangeAt();

  useEffect(() => {
    let current = true;
    api<{ grinder: Grinder }>("GET", `/grinders/${encodeURIComponent(id)}`).then(
      ({ grinder }) => current && setGrinder(grinder),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Grinder could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id, changes]);

  const back = (
    <Link to="/library/grinders" className="text-sm text-muted-foreground hover:text-foreground">
      ← Grinders
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Grinder.</p>
      </section>
    );
  }
  if (!grinder) {
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

  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {grinderName(grinder)} <GrinderBadges grinder={grinder} />
        </h1>
        <p className="text-muted-foreground">{grinderLocationText(grinder)}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <ArchiveButton path={`/grinders/${id}`} name={grinderName(grinder)} archived={grinder.archived} onDone={changed} />
        <DeleteButton path={`/grinders/${id}`} name={grinderName(grinder)} back="/library/grinders" />
      </div>

      <ItemConflictsCard kind="grinder" id={id} onResolved={changed} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>In the Library</h2>
            </CardTitle>
            <CardDescription>A Grinder belongs to the Location where it was created, and only that Location's tablets hold it.</CardDescription>
          </CardHeader>
          <CardContent>
            <Fields label="In the Library">
              <Field term="Location">
                <OrNone>{grinder.location?.name}</OrNone>
              </Field>
              <Field term="Offered">{grinder.archived ? "Nowhere: Archived" : grinder.location ? "Yes" : "Nowhere"}</Field>
              <Field term="Joined">{formatTime(grinder.createdAt)}</Field>
            </Fields>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Grinder</h2>
            </CardTitle>
            <CardDescription>As it was created, with the edits made since, on its Location's tablets or here.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {editing ? (
              <ContentForm
                label="Edit the Grinder"
                fields={GRINDER_FIELDS}
                content={grinder.content}
                path={`/grinders/${id}`}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  changed();
                }}
              />
            ) : (
            <>
            <Fields label="Grinder">
              <Field term="Model">
                <OrNone>{grinder.model ?? undefined}</OrNone>
              </Field>
              {CONTENT.map(([key, term, unit]) => (
                <Field key={key} term={term}>
                  <OrNone>{contentText(grinder.content[key], unit)}</OrNone>
                </Field>
              ))}
              <Field term="Setting">{settingText(grinder.content)}</Field>
              {STEPS.map(([key, term]) => (
                <Field key={key} term={term}>
                  <OrNone>{contentText(grinder.content[key])}</OrNone>
                </Field>
              ))}
            </Fields>
            {mayChangeAt(grinder.location?.id ?? null) && (
              <div>
                <Button variant="outline" aria-label="Edit the Grinder" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
            )}
            </>
            )}
          </CardContent>
        </Card>
      </div>

      <ItemHistoryCard key={changes} kind="grinder" id={id} />
    </section>
  );
}

/** A content field as text, with its unit, or undefined if it records nothing shown as text. */
function contentText(value: unknown, unit?: string): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number") return unit === undefined ? String(value) : `${value} ${unit}`;
  return undefined;
}

/** How the Grinder is set: a numbered dial, or named positions, listed. */
function settingText(content: Record<string, unknown>): string {
  if (content.settingType !== "preset") return "Numbered dial";
  const values = Array.isArray(content.settingValues) ? content.settingValues.filter((value) => typeof value === "string") : [];
  return values.length === 0 ? "Named positions" : `Named positions: ${values.join(", ")}`;
}
