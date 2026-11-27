import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useMayChange } from "@/auth";
import { BatchBadges, batchName, roastDateText } from "@/components/bean-batches";
import { ItemHistoryCard } from "@/components/item-history";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ItemShotsCard } from "@/components/item-shots";
import { ArchiveDeleteMenu, BATCH_FIELDS, BatchLocationsCard, ContentForm } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BatchRecipesCard } from "@/components/recipes";
import { ApiError, api, type BeanBatch } from "@/lib/api";

/**
 * The content fields a batch's Roast card names, in Decaid's order, after its
 * Batch Code and roast date, with how each is shown: only those with a
 * value, and Frozen only when it is yes (#726).
 */
const CONTENT: [key: string, term: string, show: (value: unknown, content: Record<string, unknown>) => string | undefined][] = [
  ["roastLevel", "Roast level", text],
  ["harvestDate", "Harvest", text],
  ["qualityScore", "Quality score", (value) => (number(value) === undefined ? undefined : String(number(value)))],
  ["price", "Price", (value, content) => (number(value) === undefined ? undefined : `${number(value)}${text(content.currency) === undefined ? "" : ` ${text(content.currency)}`}`)],
  ["weight", "Roasted weight", (value) => (number(value) === undefined ? undefined : `${number(value)} g`)],
  ["buyDate", "Bought", day],
  ["openDate", "Opened", day],
  ["bestBeforeDate", "Best before", day],
  ["frozen", "Frozen", (value) => (value === true ? "Yes" : undefined)],
  ["freezeDate", "Frozen on", day],
  ["unfreezeDate", "Thawed on", day],
  ["notes", "Notes", text],
];

/**
 * One Bean Batch, in two columns on a wide screen (#726): where it is, with
 * its remaining weight in all and at each Location, the Recipes that name it
 * and its history on the left; its roast, its Shots and its place in the
 * Library on the right. One column below `lg`, the left column's cards first.
 */
export function BeanBatchPage() {
  const { id = "" } = useParams();
  return <BeanBatchDetails key={id} id={id} />;
}

function BeanBatchDetails({ id }: { id: string }) {
  const mayChange = useMayChange();
  const [batch, setBatch] = useState<BeanBatch>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // An edit here changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const [editing, setEditing] = useState(false);
  const changed = () => setChanges((count) => count + 1);

  useEffect(() => {
    let current = true;
    api<{ batch: BeanBatch }>("GET", `/bean-batches/${encodeURIComponent(id)}`).then(
      ({ batch }) => current && setBatch(batch),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Bean Batch could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id, changes]);

  const back = (
    <Link to="/library/bean-batches" className="text-sm text-muted-foreground hover:text-foreground">
      ← Bean Batches
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Bean Batch.</p>
      </section>
    );
  }
  if (!batch) {
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

  const roast = CONTENT.flatMap(([key, term, show]) => {
    const shown = show(batch.content[key], batch.content);
    return shown === undefined ? [] : [{ key, term, shown }];
  });

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="grid gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {batchName(batch)}
            {batch.batchCode !== null && (
              <span aria-label={`Batch Code ${batch.batchCode}`} className="rounded-md border bg-muted px-2 py-0.5 font-mono text-sm font-medium">
                {batch.batchCode}
              </span>
            )}
            <BatchBadges batch={batch} />
          </h1>
          <p className="text-muted-foreground">
            <Link to={`/library/beans/${batch.bean.id}`} className="underline underline-offset-4">
              {batch.bean.name ?? "An unnamed Bean"}
            </Link>
            {batch.bean.roaster && `, by ${batch.bean.roaster}`}
          </p>
        </div>
        <ArchiveDeleteMenu path={`/bean-batches/${id}`} name={batchName(batch)} archived={batch.archived} back="/library/bean-batches" onDone={changed} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:col-span-2">
          <BatchLocationsCard batch={batch} onChanged={changed} />

          {/* A server of the release before lists none, as during a deploy (ADR-0025): the page goes without the card. */}
          {batch.recipes && <BatchRecipesCard recipes={batch.recipes} />}

          <ItemHistoryCard key={changes} kind="beanBatch" id={id} />
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-6">
          <Card>
            <CardHeader>
              <CardTitleWithInfo title="Roast">
                <p>As it was created, with the edits made since, on tablets or here.</p>
              </CardTitleWithInfo>
              {mayChange && !editing && (
                <CardAction>
                  <Button variant="outline" aria-label="Edit the roast" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="grid gap-4">
              {/* Closed if the account may no longer save it, as when an Admin made it a Viewer meanwhile. */}
              {editing && mayChange ? (
                <ContentForm
                  label="Edit the roast"
                  fields={BATCH_FIELDS}
                  content={batch.content}
                  path={`/bean-batches/${id}`}
                  onCancel={() => setEditing(false)}
                  onSaved={() => {
                    setEditing(false);
                    changed();
                  }}
                />
              ) : (
                <Fields label="Roast">
                  <Field term="Batch Code">
                    {batch.batchCode === null ? <OrNone>{undefined}</OrNone> : <span className="font-mono font-medium">{batch.batchCode}</span>}
                  </Field>
                  <Field term="Roast date">
                    <OrNone>{roastDateText(batch.roastDate)}</OrNone>
                  </Field>
                  {roast.map(({ key, term, shown }) => (
                    <Field key={key} term={term}>
                      {shown}
                    </Field>
                  ))}
                </Fields>
              )}
            </CardContent>
          </Card>

          <ItemShotsCard kind="beanBatch" id={id} />

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>In the Library</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Fields label="In the Library">
                <Field term="Created at">
                  <OrNone>{batch.createdLocation?.name}</OrNone>
                </Field>
                <Field term="Joined">{formatTime(batch.createdAt)}</Field>
              </Fields>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A date Decaid recorded, as its day. */
function day(value: unknown): string | undefined {
  return typeof value === "string" ? roastDateText(value) : undefined;
}
