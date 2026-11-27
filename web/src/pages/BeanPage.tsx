import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useMayChange } from "@/auth";
import { BatchCode } from "@/components/batch-name";
import { BeanBadges, beanName, offeredAtText } from "@/components/beans";
import { ItemHistoryCard } from "@/components/item-history";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ItemShotsCard } from "@/components/item-shots";
import { ArchiveButton, BEAN_FIELDS, ContentForm, DeleteButton, NewBatchDialog } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Bean } from "@/lib/api";
import { batchCodeOf, batchOfBeanText, recordedDayText } from "@/lib/batch-name";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { atLines, batchesCountText, totalText } from "@/lib/remaining-weight";

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

/**
 * One Bean: its batches first (#732), then what it is and where it is
 * offered, and other Beans that may be the same coffee. Its Batches card
 * says beside its title how many of them are at a Location and what they
 * hold in all, has New Batch in its heading, and lists each batch by the day
 * it was roasted, which links to it, its Batch Code, the Locations it is at,
 * a line each with its remaining weight there, and its remaining weight in
 * all: the Bean is said once, by the page.
 */
export function BeanPage() {
  const { id = "" } = useParams();
  return <BeanDetails key={id} id={id} />;
}

function BeanDetails({ id }: { id: string }) {
  const mayChange = useMayChange();
  const [bean, setBean] = useState<Bean>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // An edit here changes the item, so it is loaded again, with its history.
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
      {mayChange && (
        <div className="flex flex-wrap items-start gap-2">
          <ArchiveButton path={`/beans/${id}`} name={beanName(bean)} archived={bean.archived} onDone={changed} />
          <DeleteButton path={`/beans/${id}`} name={beanName(bean)} what="Its batches are deleted with it." back="/library/beans" />
        </div>
      )}

      <Card role="region" aria-label="Batches" className="min-w-0">
        <CardHeader>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <CardTitleWithInfo title="Batches">
              <p>Its roasts, the latest first, each with its Batch Code, the Locations it is at and its remaining weight at each.</p>
              <p>The line beside the title counts the batches at a Location, and adds up what the Locations that track them hold.</p>
            </CardTitleWithInfo>
            {/* An Archived Bean's batches are at no Location, whatever they were at. */}
            {bean.batches.length > 0 && <p className="text-sm text-muted-foreground tabular-nums">{batchesCountText(bean.archived ? [] : bean.batches)}</p>}
          </div>
          {mayChange && !bean.archived && (
            <CardAction>
              <NewBatchDialog bean={bean} />
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {bean.batches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No batches yet.</p>
          ) : (
            <div className="min-w-0 rounded-lg border">
              <Table aria-label="Batches">
                <TableHeader>
                  <TableRow>
                    <TableHead>Roasted</TableHead>
                    <TableHead>Batch Code</TableHead>
                    <TableHead>At</TableHead>
                    <TableHead className="text-right">Remaining in all</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bean.batches.map((batch) => {
                    const code = batchCodeOf(batch);
                    // An Archived batch, or one of an Archived Bean, is offered at no Location, whatever it was at.
                    const offered = !batch.archived && !bean.archived;
                    const total = offered ? totalText(batch) : undefined;
                    return (
                      <TableRow key={batch.id} className="align-top">
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {/* Named in full for a screen reader, as its day alone leaves its code out. */}
                            <Link to={`${LIBRARY_KINDS.beanBatch.pages}/${batch.id}`} aria-label={batchOfBeanText(batch)} className="font-medium underline-offset-4 hover:underline">
                              {recordedDayText(batch.roastDate) ?? "No roast date"}
                            </Link>
                            {batch.archived && <Badge variant="secondary">Archived</Badge>}
                          </div>
                        </TableCell>
                        <TableCell>{code === undefined ? <span className="text-muted-foreground">-</span> : <BatchCode code={code} plain />}</TableCell>
                        <TableCell className="whitespace-normal">
                          {!offered ? (
                            <span className="text-muted-foreground">-</span>
                          ) : batch.locations.length === 0 ? (
                            <span className="text-muted-foreground">At no Location</span>
                          ) : (
                            atLines(batch.locations).map((here) => (
                              <div key={here.id}>
                                {here.name}
                                {here.weight !== undefined && <span className="text-muted-foreground"> {here.weight}</span>}
                              </div>
                            ))
                          )}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums ${offered && batch.locations.some((here) => here.remainingWeight !== null) ? "" : "text-muted-foreground"}`}>{total ?? "-"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitleWithInfo title="In the Library">
              <p>
                Offered where one of its batches is, and, with no batch there yet, where a tablet created it or entered it
                too.
              </p>
            </CardTitleWithInfo>
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
            <CardTitleWithInfo title="Coffee">
              <p>As it was created, with the edits made since, on tablets or here.</p>
            </CardTitleWithInfo>
          </CardHeader>
          <CardContent className="grid gap-4">
            {/* Closed if the account may no longer save it, as when an Admin made it a Viewer meanwhile. */}
            {editing && mayChange ? (
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
            {mayChange && (
              <div>
                <Button variant="outline" aria-label="Edit the coffee" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
            )}
            </>
            )}
          </CardContent>
        </Card>
      </div>

      {bean.likelyDuplicates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitleWithInfo title="Likely duplicates">
              <p>
                Other Beans with the same roaster and name. Beans are matched only when a tablet first reports them, so these
                were kept apart.
              </p>
            </CardTitleWithInfo>
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
