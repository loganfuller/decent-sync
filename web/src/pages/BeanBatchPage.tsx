import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { BatchBadges, batchName, roastDateText, weightText } from "@/components/bean-batches";
import { Field, Fields } from "@/components/fields";
import { formatTime } from "@/components/machines";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type BeanBatch } from "@/lib/api";

/** The content fields a batch's page names, in Decaid's order, after its roast date, with how each is shown. */
const CONTENT: [key: string, term: string, show: (value: unknown, content: Record<string, unknown>) => string | undefined][] = [
  ["roastLevel", "Roast level", text],
  ["harvestDate", "Harvest", text],
  ["qualityScore", "Quality score", (value) => (number(value) === undefined ? undefined : String(number(value)))],
  ["price", "Price", (value, content) => (number(value) === undefined ? undefined : `${number(value)}${text(content.currency) === undefined ? "" : ` ${text(content.currency)}`}`)],
  ["weight", "Weight", (value) => (number(value) === undefined ? undefined : `${number(value)} g`)],
  ["buyDate", "Bought", day],
  ["openDate", "Opened", day],
  ["bestBeforeDate", "Best before", day],
  ["frozen", "Frozen", (value) => (value === true ? "Yes" : "No")],
  ["freezeDate", "Frozen on", day],
  ["unfreezeDate", "Thawed on", day],
  ["notes", "Notes", text],
];

/** One Bean Batch: what it is, the Locations it is at with its remaining weight at each, and where it was finished. */
export function BeanBatchPage() {
  const { id = "" } = useParams();
  return <BeanBatchDetails key={id} id={id} />;
}

function BeanBatchDetails({ id }: { id: string }) {
  const [batch, setBatch] = useState<BeanBatch>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();

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
  }, [id]);

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

  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {batchName(batch)} <BatchBadges batch={batch} />
        </h1>
        <p className="text-muted-foreground">
          A batch of{" "}
          <Link to={`/library/beans/${batch.bean.id}`} className="underline-offset-4 hover:underline">
            {batch.bean.name ?? "an unnamed Bean"}
          </Link>
          {batch.bean.roaster && `, by ${batch.bean.roaster}`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Locations</h2>
          </CardTitle>
          <CardDescription>
            Where it is, from when it was added there until it is finished there, and the remaining weight entered last at
            each. Each Location's tablets hold it with that Location's weight.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {batch.locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">It is at no Location.</p>
          ) : (
            <Table aria-label="Locations">
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>Remaining weight</TableHead>
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.locations.map((here) => (
                  <TableRow key={here.location.id}>
                    <TableCell className="font-medium">{here.location.name}</TableCell>
                    <TableCell>{weightText(here.remainingWeight)}</TableCell>
                    <TableCell>{formatTime(here.since)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {batch.finished.length > 0 && (
            <Fields label="Finished">
              {batch.finished.map((here) => (
                <Field key={here.location.id} term={here.location.name}>
                  Finished {formatTime(here.finishedAt)}, with {weightText(here.remainingWeight)}
                </Field>
              ))}
            </Fields>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Roast</h2>
            </CardTitle>
            <CardDescription>As the tablet that created it recorded it.</CardDescription>
          </CardHeader>
          <CardContent>
            <Fields label="Roast">
              <Field term="Roasted">
                <OrNone>{roastDateText(batch.roastDate)}</OrNone>
              </Field>
              {CONTENT.map(([key, term, show]) => (
                <Field key={key} term={term}>
                  <OrNone>{show(batch.content[key], batch.content)}</OrNone>
                </Field>
              ))}
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
                <OrNone>{batch.createdLocation?.name}</OrNone>
              </Field>
              <Field term="Joined">{formatTime(batch.createdAt)}</Field>
            </Fields>
          </CardContent>
        </Card>
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
