import { Link } from "react-router";
import { batchName, roastDateText } from "@/components/bean-batches";
import { CardTitleWithInfo } from "@/components/info-tip";
import { EnterWeightDialog, useMayChangeAt } from "@/components/library-forms";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BatchHere, Location } from "@/lib/api";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { grams, movedLine, startText, weightText } from "@/lib/remaining-weight";
import { shotsText } from "@/lib/shot-summary";

/** How many batches a Location has, and how many of them it tracks the weight of, such as "4 batches here, 3 with a weight". */
function countText(batches: BatchHere[]): string {
  const tracked = batches.filter((batch) => batch.remainingWeight !== null).length;
  return `${batches.length} ${batches.length === 1 ? "batch" : "batches"} here, ${tracked === 0 ? "none" : tracked} with a weight`;
}

/**
 * The Bean Batches at a Location, on its page (#707): each not finished
 * there or Archived, the latest roasted first, with its Batch Code, its
 * Remaining Weight there or "Not tracked", never zero for none, what its
 * count there starts from, the coffee and Shots there since and what was
 * moved in and away, and the Recipes here that name it. A row links to the
 * batch, each Recipe and the batch's Shots here. Everything in it is this
 * Location's: a batch at another Location too has its own weight there.
 * An Admin, and Staff who work here, have Enter weight in each row's last
 * column (#726), on untracked rows too, which is how tracking starts here:
 * the dialog and its rules are the batch's page's, so a weight of zero
 * finishes the batch here and its row leaves the list. Anyone else reads
 * the table without the column. A batch is moved, and finished without
 * weighing it, on the batch's page only.
 */
export function LocationBatchesCard({ location, batches, onChanged }: { location: Location; batches: BatchHere[]; onChanged(): Promise<void> | void }) {
  const mayEnter = useMayChangeAt()(location.id);
  return (
    <Card role="region" aria-label="Bean Batches">
      <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <CardTitleWithInfo title="Bean Batches">
          <p>The Bean Batches here now, the latest roasted first: none finished here, moved away entirely, or Archived.</p>
          <p>
            Each weight is what is left here: the weight entered or arrived, less what the Shots pulled here since have used, with what was moved
            here and away since. A batch may be at other Locations too, each with its own weight.
          </p>
          <p>
            {mayEnter
              ? "Enter weight sets what is left of a batch here, as weighed. Open a batch to move it or finish it here."
              : "Admins, and Staff who work here, enter a batch's weight here, and move or finish it on the batch's page."}
          </p>
        </CardTitleWithInfo>
        {batches.length > 0 && <p className="text-sm text-muted-foreground tabular-nums">{countText(batches)}</p>}
      </CardHeader>
      <CardContent>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Bean Batch is here.</p>
        ) : (
          <div className="min-w-0 rounded-lg border">
            <Table aria-label="Bean Batches here">
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Batch Code</TableHead>
                  <TableHead className="text-right">Remaining here</TableHead>
                  <TableHead>Since then</TableHead>
                  <TableHead>Recipes here</TableHead>
                  {mayEnter && (
                    <TableHead>
                      <span className="sr-only">Enter its weight</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <BatchHereRow key={batch.id} location={location} batch={batch} mayEnter={mayEnter} onChanged={onChanged} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BatchHereRow({ location, batch, mayEnter, onChanged }: { location: Location; batch: BatchHere; mayEnter: boolean; onChanged(): Promise<void> | void }) {
  const roasted = roastDateText(batch.roastDate);
  const shots = `/shots?${new URLSearchParams({ beanBatchId: batch.id, locationId: location.id })}`;
  const link = "underline underline-offset-4";
  return (
    <TableRow className="align-top">
      <TableCell className="whitespace-normal">
        <Link to={`${LIBRARY_KINDS.beanBatch.pages}/${batch.id}`} className="font-medium underline-offset-4 hover:underline">
          {batch.bean.name ?? "Unnamed Bean"}
        </Link>
        <div className="text-sm text-muted-foreground">{roasted === undefined ? "No roast date" : `Roasted ${roasted}`}</div>
      </TableCell>
      <TableCell>{batch.batchCode === null ? <span className="text-muted-foreground">-</span> : <span className="font-mono font-medium">{batch.batchCode}</span>}</TableCell>
      <TableCell className="text-right">
        <div className={batch.remainingWeight === null ? "text-muted-foreground" : "font-medium tabular-nums"}>{weightText(batch.remainingWeight)}</div>
        <div className="text-sm text-muted-foreground">{startText(batch)}</div>
      </TableCell>
      <TableCell className="whitespace-normal">
        {batch.used ? (
          <>
            <div>
              {batch.used.shots === 0 ? (
                "No Shots since"
              ) : (
                <>
                  {grams(batch.used.weight)} used,{" "}
                  <Link to={shots} className={link}>
                    {shotsText(batch.used.shots)}
                  </Link>
                </>
              )}
            </div>
            <div className="text-sm text-muted-foreground">{movedLine(batch.moved)}</div>
          </>
        ) : (
          <Link to={shots} className={`${link} text-muted-foreground`}>
            Shots
          </Link>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">
        {batch.recipes.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          batch.recipes.map((recipe) => (
            <div key={recipe.id}>
              <Link to={`${LIBRARY_KINDS.recipe.pages}/${recipe.id}`} className={link}>
                {recipe.name ?? "Unnamed Recipe"}
              </Link>{" "}
              <span className="text-muted-foreground">{recipe.slot === null ? "no slot" : `slot ${recipe.slot}`}</span>
            </div>
          ))
        )}
      </TableCell>
      {mayEnter && (
        <TableCell className="text-right">
          <EnterWeightDialog
            batch={batch}
            location={location}
            remainingWeight={batch.remainingWeight}
            ariaLabel={`Enter the weight of ${batchName(batch)}`}
            variant="outline"
            size="sm"
            onChanged={onChanged}
          />
        </TableCell>
      )}
    </TableRow>
  );
}
