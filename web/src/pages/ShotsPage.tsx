import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { LocationCredit, MachineCredit, OrNone, numberText, secondsText } from "@/components/records";
import { ANY, ListPagination, type ListState, NONE, RECORD_FILTERS, RecordFilters, type RecordList, useRecordList } from "@/components/record-lists";
import { beanText, gramsText, shotTime } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type ShotFilterOptions, type ShotPage } from "@/lib/api";

/** The list's query parameters, which are the REST API's: the page's address is a list anyone can share. */
const FILTERS = [...RECORD_FILTERS, "coffeeRoaster", "coffeeName", "barista", "profileTitle"] as const;

/**
 * Every Shot, newest first, across every Location, with filters. Times are
 * each Shot's Location's, and dates are read in each Shot's own Location's
 * time zone; Shots with no Location use UTC. Staff see all of it.
 */
export function ShotsPage() {
  const list = useRecordList<ShotPage>("/shots", FILTERS, (page) => page.shots);
  const { data, error } = list;

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Shots</h1>
        <p className="text-muted-foreground">
          Every Shot pulled at every Location, newest first. Times are shown in each Shot's Location's time zone, and
          dates are read in it too; a Shot with no Location uses UTC.
        </p>
      </div>

      <ShotFilters list={list} />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data?.total === 0 && <p className="text-muted-foreground">{list.filtered ? "No Shots match these filters." : "No Shots yet."}</p>}
      {data && data.shots.length > 0 && (
        <>
          <div className="rounded-lg border">
            <Table aria-label="Shots">
              <TableHeader>
                <TableRow>
                  <TableHead>Pulled</TableHead>
                  <TableHead>Machine</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Profile</TableHead>
                  <TableHead>Bean</TableHead>
                  <TableHead>Dose</TableHead>
                  <TableHead>Yield</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Enjoyment</TableHead>
                  <TableHead>Barista</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.shots.map((shot) => (
                  <TableRow key={shot.id}>
                    <TableCell className="font-medium">
                      <Link
                        to={`/shots/${encodeURIComponent(shot.id)}`}
                        state={{ list: list.search } satisfies ListState}
                        className="underline-offset-4 hover:underline"
                      >
                        {shotTime(shot)}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <MachineCredit record={shot} />
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <LocationCredit record={shot} />
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <OrNone>{shot.profileTitle ?? undefined}</OrNone>
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <OrNone>{beanText(shot)}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{gramsText(shot.actualDose, shot.targetDose)}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{gramsText(shot.actualYield, shot.targetYield)}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{secondsText(shot.duration)}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{numberText(shot.enjoyment)}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{shot.barista ?? undefined}</OrNone>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ListPagination list={list} noun="Shots" />
        </>
      )}
    </section>
  );
}

// Recorded values are prefixed, so none can be mistaken for ANY or NONE.

/** A text filter's Select value: no filter, Shots that recorded none (an empty parameter), or a recorded value. */
function textChoice(value: string | null): string {
  if (value === null) return ANY;
  return value === "" ? NONE : `=${value}`;
}

function textFilter(choice: string): string | null {
  if (choice === ANY) return null;
  return choice === NONE ? "" : choice.slice(1);
}

/** A Bean as a Select value: its roaster and name, either null when the Shots recorded none. */
function beanChoice(roaster: string | null, name: string | null): string {
  return JSON.stringify([roaster, name]);
}

/** The filters every record list has, and those by what Shots recorded: Bean, Barista and profile. */
function ShotFilters({ list }: { list: RecordList<ShotPage> }) {
  const id = useId();
  const [options, setOptions] = useState<ShotFilterOptions>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api<ShotFilterOptions>("GET", "/shots/filters").then(
      (loaded) => current && setOptions(loaded),
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The filters could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, []);

  const { params } = list;
  const roaster = params.get("coffeeRoaster");
  const bean = params.get("coffeeName");

  return (
    <RecordFilters
      list={list}
      error={error}
      description="Dates and times are read in each Shot's Location's time zone, so 7:00 means 7:00 wherever it was pulled. To includes the whole of its day unless a time is given."
    >
      <Field>
        <FieldLabel htmlFor={`${id}-bean`}>Bean</FieldLabel>
        <Select
          value={roaster === null && bean === null ? ANY : beanChoice(roaster || null, bean || null)}
          onValueChange={(choice) => {
            if (choice === ANY) return list.filter({ coffeeRoaster: null, coffeeName: null });
            const [chosenRoaster, chosenName] = JSON.parse(choice) as [string | null, string | null];
            list.filter({ coffeeRoaster: chosenRoaster ?? "", coffeeName: chosenName ?? "" });
          }}
        >
          <SelectTrigger id={`${id}-bean`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any Bean</SelectItem>
            {options?.beans.map((option) => (
              <SelectItem key={beanChoice(option.coffeeRoaster, option.coffeeName)} value={beanChoice(option.coffeeRoaster, option.coffeeName)}>
                {beanText(option) ?? "No Bean recorded"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <TextFilter
        id={`${id}-barista`}
        label="Barista"
        any="Any Barista"
        value={params.get("barista")}
        options={options?.baristas}
        onChange={(barista) => list.filter({ barista })}
      />
      <TextFilter
        id={`${id}-profile`}
        label="Profile"
        any="Any profile"
        value={params.get("profileTitle")}
        options={options?.profiles}
        onChange={(profileTitle) => list.filter({ profileTitle })}
      />
    </RecordFilters>
  );
}

/** A filter by what Shots recorded as text: any, a value recorded, or none recorded. */
function TextFilter({
  id,
  label,
  any,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  any: string;
  value: string | null;
  options: (string | null)[] | undefined;
  onChange(value: string | null): void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={textChoice(value)} onValueChange={(choice) => onChange(textFilter(choice))}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{any}</SelectItem>
          {options?.map((option) => (
            <SelectItem key={textChoice(option ?? "")} value={textChoice(option ?? "")}>
              {option ?? "None recorded"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
