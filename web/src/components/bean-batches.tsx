import { Link, NavLink } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BatchHere, BeanBatchSummary } from "@/lib/api";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { grams, movedLine, startText, weightText } from "@/lib/remaining-weight";
import { shotsText } from "@/lib/shot-summary";

/** The Library's lists, as links between them: Recipes first (#547), as the list most come for. */
export function LibraryNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? "font-medium" : "text-muted-foreground hover:text-foreground");
  return (
    <nav aria-label="Library" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {/* `end`, so a Recipe's own page, which is reached from many places, marks no list. */}
      <NavLink to="/library/recipes" end className={linkClass}>
        Recipes
      </NavLink>
      <NavLink to="/library/beans" className={linkClass}>
        Beans
      </NavLink>
      <NavLink to="/library/bean-batches" className={linkClass}>
        Bean Batches
      </NavLink>
      <NavLink to="/library/grinders" className={linkClass}>
        Grinders
      </NavLink>
      <NavLink to="/library/profiles" className={linkClass}>
        Profiles
      </NavLink>
      <NavLink to="/library/baskets" className={linkClass}>
        Baskets
      </NavLink>
      <NavLink to="/library/tools" className={linkClass}>
        Tools
      </NavLink>
    </nav>
  );
}

/** A roast date as Decaid recorded it, as its day: the date a barista picked, whatever time zone it was written in. */
export function roastDateText(roastDate: string | null): string | undefined {
  return roastDate !== null && /^\d{4}-\d\d-\d\d/.test(roastDate) ? roastDate.slice(0, 10) : undefined;
}

/** A batch as lists name it: its Bean and the day it was roasted. */
export function batchName(batch: Pick<BeanBatchSummary, "bean" | "roastDate">): string {
  const roasted = roastDateText(batch.roastDate);
  return `${batch.bean.name ?? "Unnamed Bean"}, ${roasted === undefined ? "no roast date" : `roasted ${roasted}`}`;
}

export { atText, totalText, weightText } from "@/lib/remaining-weight";

/** What may need someone's attention about a batch. */
export function BatchBadges({ batch }: { batch: BeanBatchSummary }) {
  return <div className="flex flex-wrap gap-1">{batch.archived && <Badge variant="secondary">Archived</Badge>}</div>;
}

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
 * Read only: a weight is entered and a batch moved on the batch's page.
 */
export function LocationBatchesCard({ locationId, batches }: { locationId: string; batches: BatchHere[] }) {
  return (
    <Card role="region" aria-label="Bean Batches">
      <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <CardTitleWithInfo title="Bean Batches">
          <p>The Bean Batches here now, the latest roasted first: none finished here, moved away entirely, or Archived.</p>
          <p>
            Each weight is what is left here: the weight entered or arrived, less what the Shots pulled here since have used, with what was moved
            here and away since. A batch may be at other Locations too, each with its own weight.
          </p>
          <p>Open a batch to enter its weight, move it or finish it here.</p>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <BatchHereRow key={batch.id} locationId={locationId} batch={batch} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BatchHereRow({ locationId, batch }: { locationId: string; batch: BatchHere }) {
  const roasted = roastDateText(batch.roastDate);
  const shots = `/shots?${new URLSearchParams({ beanBatchId: batch.id, locationId })}`;
  const link = "underline underline-offset-4";
  return (
    <TableRow className="align-top">
      <TableCell className="whitespace-normal">
        <Link to={`${LIBRARY_KINDS.beanBatch.pages}/${batch.id}`} className="font-medium underline-offset-4 hover:underline">
          {batch.bean.name ?? "Unnamed Bean"}
        </Link>
        <div className="text-sm text-muted-foreground">{roasted === undefined ? "No roast date" : `Roasted ${roasted}`}</div>
      </TableCell>
      <TableCell>{batch.batchCode === null ? <span className="text-muted-foreground">None</span> : <span className="font-mono font-medium">{batch.batchCode}</span>}</TableCell>
      <TableCell className="text-right">
        <div className={batch.remainingWeight === null ? "text-muted-foreground" : "font-medium tabular-nums"}>{weightText(batch.remainingWeight)}</div>
        <div className="text-sm text-muted-foreground">{startText(batch)}</div>
      </TableCell>
      <TableCell className="whitespace-normal">
        {batch.used ? (
          <>
            <div>
              {grams(batch.used.weight)} used,{" "}
              <Link to={shots} className={link}>
                {shotsText(batch.used.shots)}
              </Link>
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
    </TableRow>
  );
}
