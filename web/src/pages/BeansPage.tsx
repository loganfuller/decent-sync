import { useCallback } from "react";
import { Link } from "react-router";
import { LibraryNav } from "@/components/bean-batches";
import { BeanBadges, beanName, offeredAtText } from "@/components/beans";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type BeanSummary } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** The Library's Beans and where each is offered. Beans join the Library from tablets; they are not edited here yet. */
export function BeansPage() {
  const load = useCallback(async () => (await api<{ beans: BeanSummary[] }>("GET", "/beans")).beans, []);
  const { data: beans, error } = usePolled(load, DETAILS_POLL_MS);

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Beans</h1>
        <p className="text-muted-foreground">
          The coffees in the Library. A Bean entered on a tablet joins the Library at that tablet's Location, or becomes
          the Bean already there with the same roaster and name, and is written to every tablet at that Location. Once it
          has a batch at a Location, it is offered there while one of its batches is.
        </p>
        <LibraryNav />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {beans?.length === 0 && <p className="text-muted-foreground">No Beans yet. They join the Library as tablets at a Location report them.</p>}
      {beans && beans.length > 0 && (
        <div className="rounded-lg border">
          <Table aria-label="Beans">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Roaster</TableHead>
                <TableHead>Offered at</TableHead>
                <TableHead>Created at</TableHead>
                <TableHead>Attention</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {beans.map((bean) => (
                <TableRow key={bean.id}>
                  <TableCell className="font-medium">
                    <Link to={`/library/beans/${bean.id}`} className="underline-offset-4 hover:underline">
                      {beanName(bean)}
                    </Link>
                  </TableCell>
                  <TableCell>{bean.roaster ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{offeredAtText(bean)}</TableCell>
                  <TableCell>{bean.createdLocation?.name ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    <BeanBadges bean={bean} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
