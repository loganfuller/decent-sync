import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { atText, batchName } from "@/components/bean-batches";
import { BeanBadges, beanName, offeredAtText } from "@/components/beans";
import { ItemConflictsCard, ItemHistoryCard } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { ItemShotsCard } from "@/components/item-shots";
import { ArchiveButton, BEAN_FIELDS, ContentForm, DeleteButton, NewBatchDialog } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Bean } from "@/lib/api";

/** The content fields a Bean's page names, in Decaid's order, with how each is shown. */
const CONTENT: [key: string, term: string][] = [
  ["species", "Species"],
  ["country", "Country"],
  ["region", "Region"],
  ["producer", "Producer"],
  ["variety", "Variety"],
  ["altitude", "Altitude"],
  ["processing", "Processing"],
  ["notes", "Notes"],
];

/** One Bean: what it is, where it is offered, its batches, and other Beans that may be the same coffee. */
export function BeanPage() {
  const { id = "" } = useParams();
  return <BeanDetails key={id} id={id} />;
}

function BeanDetails({ id }: { id: string }) {
  const [bean, setBean] = useState<Bean>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // Using a Conflict\'s value, or an edit here, changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const [editing, setEditing] = useState(false);
  const changed = () => setChanges((count) => count + 1);

  useEffect(() => {
    let current = true;
    api<{ bean: Bean }>("GET", `/beans/${encodeURIComponent(id)}`).then(
      ({ bean }) => current && setBean(bean),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Bean could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id, changes]);

  const back = (
    <Link to="/library/beans" className="text-sm text-muted-foreground hover:text-foreground">
      ← Beans
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Bean.</p>
      </section>
    );
  }
  if (!bean) {
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
          {beanName(bean)} <BeanBadges bean={bean} />
        </h1>
        <p className="text-muted-foreground">{bean.roaster ?? "No roaster recorded"}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {!bean.archived && <NewBatchDialog bean={bean} />}
        <ArchiveButton path={`/beans/${id}`} name={beanName(bean)} archived={bean.archived} onDone={changed} />
        <DeleteButton path={`/beans/${id}`} name={beanName(bean)} what="Its batches are deleted with it." back="/library/beans" />
      </div>

      <ItemConflictsCard kind="bean" id={id} onResolved={changed} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>In the Library</h2>
            </CardTitle>
            <CardDescription>
              Offered where one of its batches is, and, with no batch there yet, where a tablet created it or entered it
              too.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Fields label="In the Library">
              <Field term="Offered at">{offeredAtText(bean)}</Field>
              <Field term="Created at">
                <OrNone>{bean.createdLocation?.name}</OrNone>
              </Field>
              <Field term="Joined">{formatTime(bean.createdAt)}</Field>
            </Fields>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Coffee</h2>
            </CardTitle>
            <CardDescription>As it was created, with the edits made since, on tablets or here.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {editing ? (
              <ContentForm
                label="Edit the coffee"
                fields={BEAN_FIELDS}
                content={bean.content}
                path={`/beans/${id}`}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  changed();
                }}
              />
            ) : (
            <>
            <Fields label="Coffee">
              <Field term="Roaster">
                <OrNone>{bean.roaster ?? undefined}</OrNone>
              </Field>
              <Field term="Name">
                <OrNone>{bean.name ?? undefined}</OrNone>
              </Field>
              <Field term="Decaf">{decafText(bean.content)}</Field>
              {CONTENT.map(([key, term]) => (
                <Field key={key} term={term}>
                  <OrNone>{contentText(bean.content[key])}</OrNone>
                </Field>
              ))}
            </Fields>
            <div>
              <Button variant="outline" aria-label="Edit the coffee" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </div>
            </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Batches</h2>
          </CardTitle>
          <CardDescription>Its roasts, the latest first, and the Locations each is at.</CardDescription>
        </CardHeader>
        <CardContent>
          {bean.batches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No batches yet.</p>
          ) : (
            <Table aria-label="Batches">
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bean.batches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell className="font-medium">
                      <Link to={`/library/bean-batches/${batch.id}`} className="underline-offset-4 hover:underline">
                        {batchName(batch)}
                      </Link>
                    </TableCell>
                    <TableCell>{atText(batch.locations)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {bean.likelyDuplicates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Likely duplicates</h2>
            </CardTitle>
            <CardDescription>
              Other Beans with the same roaster and name. Beans are matched only when a tablet first reports them, so these
              were kept apart.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul aria-label="Likely duplicates" className="grid gap-1 text-sm">
              {bean.likelyDuplicates.map((other) => (
                <li key={other.id}>
                  <Link to={`/library/beans/${other.id}`} className="underline-offset-4 hover:underline">
                    {beanName(other)}
                  </Link>{" "}
                  <span className="text-muted-foreground">{other.roaster}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ItemShotsCard kind="bean" id={id} />

      <ItemHistoryCard key={changes} kind="bean" id={id} />
    </section>
  );
}

/** A content field as text: a list's items joined, or undefined if it records nothing shown as text. */
function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" || typeof item === "number")) {
    return value.join(", ");
  }
  return undefined;
}

function decafText(content: Record<string, unknown>): string {
  if (content.decaf !== true) return "No";
  return typeof content.decafProcess === "string" && content.decafProcess.trim() !== "" ? `Yes, ${content.decafProcess}` : "Yes";
}
