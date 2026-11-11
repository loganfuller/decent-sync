import { useCallback } from "react";
import { Link } from "react-router";
import { PageTitleWithInfo } from "@/components/info-tip";
import { HomeOverviewBlock, OverviewAbout, PeriodChoice, PeriodTabs, useOverviewPeriod } from "@/components/overview";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TabsContent } from "@/components/ui/tabs";
import { api, type Location, type Machine } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

/**
 * The home page, the Overview (#471; GLOSSARY.md): a block for every
 * Location, by name, for the period chosen, which its address keeps. The
 * Locations and the Machines' status are read every 5 s, and each block
 * reads its own numbers (`OverviewBlock`). It shows Locations only: a
 * Machine at none stays on the Machines page. Staff and Viewers see all of
 * it.
 */
export function OverviewPage() {
  const [period, setPeriod] = useOverviewPeriod();
  const load = useCallback(async () => {
    const [{ locations }, { machines }] = await Promise.all([api<{ locations: Location[] }>("GET", "/locations"), api<{ machines: Machine[] }>("GET", "/machines")]);
    return { locations, machines };
  }, []);
  const { data, error } = usePolled(load);

  return (
    <PeriodTabs period={period} onPeriod={setPeriod} className="gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitleWithInfo title="Overview">
          <OverviewAbout />
        </PageTitleWithInfo>
        <PeriodChoice />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* One column no wider than the page, so a wide block scrolls rather than widening it. */}
      <TabsContent value={period} className="grid grid-cols-1 gap-6">
        {data?.locations.length === 0 && (
          <p className="text-muted-foreground">
            No Locations yet. Machines appear here once they are at a{" "}
            <Link to="/locations" className="underline underline-offset-4">
              Location
            </Link>
            .
          </p>
        )}
        {data?.locations.map((location) => (
          <HomeOverviewBlock key={location.id} location={location} machines={data.machines} period={period} />
        ))}
      </TabsContent>
    </PeriodTabs>
  );
}
