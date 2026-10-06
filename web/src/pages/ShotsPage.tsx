import { CalendarIcon } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useId, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { describeHardware, useLocations } from "@/components/machines";
import {
  LocationCredit,
  MachineCredit,
  OrNone,
  beanText,
  gramsText,
  numberText,
  secondsText,
  shotTime,
} from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Machine, type PendingMachine, type ShotFilterOptions, type ShotPage } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

const PAGE_SIZE = 25;

/** The list's query parameters, which are the REST API's: the page's address is a list anyone can share. */
const FILTERS = ["locationId", "machineId", "pendingMachineId", "coffeeRoaster", "coffeeName", "barista", "profileTitle", "from", "to"] as const;

/** What a Shot page's link back to the list keeps: the list's filters and page. */
export interface ShotListState {
  list?: string;
}

/**
 * Every Shot, newest first, across every Location, with filters. Times are
 * each Shot's Location's, and dates are read in each Shot's own Location's
 * time zone; Shots with no Location use UTC. Staff see all of it.
 */
export function ShotsPage() {
  const [params, setParams] = useSearchParams();
  const { search } = useLocation();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const query = new URLSearchParams([...FILTERS.flatMap((name) => params.getAll(name).slice(0, 1).map((value) => [name, value])), ["limit", String(PAGE_SIZE)], ["offset", String(offset)]]).toString();
  // Each page loaded remembers what it answers: the last one is still shown while another loads.
  const load = useCallback(async () => ({ query, page: await api<ShotPage>("GET", `/shots?${query}`) }), [query]);
  const { data: loaded, error } = usePolled(load);
  const data = loaded?.page;
  const filtered = FILTERS.some((name) => params.has(name));

  // A page past the end, opened from an old link or emptied as Shots leave the list, moves to the last page,
  // judged only by an answer for this page, never one for the page or filters shown before.
  const lastPage = data && data.total > 0 ? Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0;
  const pastTheEnd = loaded?.query === query && data!.shots.length === 0 && offset > lastPage;
  useEffect(() => {
    if (!pastTheEnd) return;
    const next = new URLSearchParams(params);
    if (lastPage > 0) next.set("offset", String(lastPage));
    else next.delete("offset");
    setParams(next, { replace: true });
  }, [pastTheEnd, lastPage, params, setParams]);

  /** Changes filters, and goes back to the first page. */
  function filter(changes: Partial<Record<(typeof FILTERS)[number], string | null>>) {
    const next = new URLSearchParams(params);
    next.delete("offset");
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === undefined) next.delete(name);
      else next.set(name, value);
    }
    setParams(next);
  }

  function pageHref(at: number): string {
    const next = new URLSearchParams(params);
    if (at > 0) next.set("offset", String(at));
    else next.delete("offset");
    const text = next.toString();
    return text ? `?${text}` : "?";
  }

  function goTo(at: number) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      setParams(new URLSearchParams(pageHref(at)));
    };
  }

  const first = data && data.total > 0 ? offset + 1 : 0;
  const last = data ? Math.min(offset + data.shots.length, data.total) : 0;
  const hasPrevious = offset > 0;
  const hasNext = data !== undefined && offset + PAGE_SIZE < data.total;

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

      <ShotFilters params={params} onChange={filter} onClear={() => setParams(new URLSearchParams())} filtered={filtered} />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data?.total === 0 && <p className="text-muted-foreground">{filtered ? "No Shots match these filters." : "No Shots yet."}</p>}
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
                        state={{ list: search } satisfies ShotListState}
                        className="underline-offset-4 hover:underline"
                      >
                        {shotTime(shot)}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <MachineCredit shot={shot} />
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <LocationCredit shot={shot} />
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Shots {first}–{last} of {data.total}
            </p>
            <Pagination className="mx-0 w-auto">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href={pageHref(Math.max(0, offset - PAGE_SIZE))}
                    onClick={goTo(Math.max(0, offset - PAGE_SIZE))}
                    aria-disabled={!hasPrevious}
                    className={hasPrevious ? undefined : "pointer-events-none opacity-50"}
                    tabIndex={hasPrevious ? undefined : -1}
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    href={pageHref(offset + PAGE_SIZE)}
                    onClick={goTo(offset + PAGE_SIZE)}
                    aria-disabled={!hasNext}
                    className={hasNext ? undefined : "pointer-events-none opacity-50"}
                    tabIndex={hasNext ? undefined : -1}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </>
      )}
    </section>
  );
}

// Every option of a Select needs a value, so these stand for no filter and for Shots that recorded nothing;
// recorded values are prefixed, so none can be mistaken for them.
const ANY = "any";
const NONE = "none";

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

interface Choices {
  machines: Machine[];
  pendingMachines: PendingMachine[];
  options: ShotFilterOptions;
}

function ShotFilters({
  params,
  onChange,
  onClear,
  filtered,
}: {
  params: URLSearchParams;
  onChange(changes: Partial<Record<(typeof FILTERS)[number], string | null>>): void;
  onClear(): void;
  filtered: boolean;
}) {
  const id = useId();
  const { locations, error: locationsError } = useLocations();
  const [choices, setChoices] = useState<Choices>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    Promise.all([
      api<{ machines: Machine[] }>("GET", "/machines"),
      api<{ pendingMachines: PendingMachine[] }>("GET", "/pending-machines"),
      api<ShotFilterOptions>("GET", "/shots/filters"),
    ]).then(
      ([{ machines }, { pendingMachines }, options]) => current && setChoices({ machines, pendingMachines, options }),
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The filters could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, []);

  const locationId = params.get("locationId");
  const machineId = params.get("machineId");
  const pendingMachineId = params.get("pendingMachineId");
  const roaster = params.get("coffeeRoaster");
  const bean = params.get("coffeeName");
  // A dismissed Pending Machine's Shots are not listed, so it is no choice.
  const pendingMachines = choices?.pendingMachines.filter((pending) => !pending.dismissed) ?? [];

  return (
    <section aria-label="Filters" className="grid gap-4 rounded-lg border p-4">
      {(error || locationsError) && (
        <Alert variant="destructive">
          <AlertDescription>{error ?? locationsError}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field>
          <FieldLabel htmlFor={`${id}-location`}>Location</FieldLabel>
          <Select
            value={locationId === null ? ANY : locationId}
            onValueChange={(choice) => onChange({ locationId: choice === ANY ? null : choice })}
          >
            <SelectTrigger id={`${id}-location`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any Location</SelectItem>
              {locations?.map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={NONE}>No Location (UTC)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-machine`}>Machine</FieldLabel>
          <Select
            value={machineId !== null ? `machine:${machineId}` : pendingMachineId !== null ? `pending:${pendingMachineId}` : ANY}
            onValueChange={(choice) => {
              const [kind, chosen] = choice.split(":");
              onChange({ machineId: kind === "machine" ? chosen! : null, pendingMachineId: kind === "pending" ? chosen! : null });
            }}
          >
            <SelectTrigger id={`${id}-machine`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any Machine</SelectItem>
              {choices && choices.machines.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Machines</SelectLabel>
                  {choices.machines.map((machine) => (
                    <SelectItem key={machine.id} value={`machine:${machine.id}`}>
                      {machine.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {pendingMachines.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Pending Machines</SelectLabel>
                  {pendingMachines.map((pending) => (
                    <SelectItem key={pending.id} value={`pending:${pending.id}`}>
                      {describeHardware(pending)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${id}-bean`}>Bean</FieldLabel>
          <Select
            value={roaster === null && bean === null ? ANY : beanChoice(roaster || null, bean || null)}
            onValueChange={(choice) => {
              if (choice === ANY) return onChange({ coffeeRoaster: null, coffeeName: null });
              const [chosenRoaster, chosenName] = JSON.parse(choice) as [string | null, string | null];
              onChange({ coffeeRoaster: chosenRoaster ?? "", coffeeName: chosenName ?? "" });
            }}
          >
            <SelectTrigger id={`${id}-bean`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any Bean</SelectItem>
              {choices?.options.beans.map((option) => (
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
          options={choices?.options.baristas}
          onChange={(barista) => onChange({ barista })}
        />
        <TextFilter
          id={`${id}-profile`}
          label="Profile"
          any="Any profile"
          value={params.get("profileTitle")}
          options={choices?.options.profiles}
          onChange={(profileTitle) => onChange({ profileTitle })}
        />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <DateFilter id={`${id}-from`} label="From" value={params.get("from")} onChange={(from) => onChange({ from })} />
        <DateFilter id={`${id}-to`} label="To" value={params.get("to")} onChange={(to) => onChange({ to })} />
        {filtered && (
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Dates and times are read in each Shot's Location's time zone, so 7:00 means 7:00 wherever it was pulled. To
        includes the whole of its day unless a time is given.
      </p>
    </section>
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

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * A local date, and optionally a time on it, as the list's `from` or `to`:
 * `2026-10-05` or `2026-10-05T06:00`. Dates are chosen as calendar days, not
 * moments, so the browser's own time zone plays no part.
 */
function DateFilter({ id, label, value, onChange }: { id: string; label: string; value: string | null; onChange(value: string | null): void }) {
  const [open, setOpen] = useState(false);
  const match = value ? /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d:\d\d))?/.exec(value) : null;
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
  const day = match ? value!.slice(0, 10) : undefined;
  const time = match?.[4] ?? "";

  function chooseDate(chosen: Date | undefined) {
    setOpen(false);
    if (!chosen) return onChange(null);
    const pad = (part: number) => String(part).padStart(2, "0");
    const chosenDay = `${chosen.getFullYear()}-${pad(chosen.getMonth() + 1)}-${pad(chosen.getDate())}`;
    onChange(time ? `${chosenDay}T${time}` : chosenDay);
  }

  return (
    <Field className="w-auto">
      <FieldLabel htmlFor={`${id}-date`}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button id={`${id}-date`} variant="outline" className="w-40 justify-start font-normal">
              <CalendarIcon data-icon="inline-start" />
              {date ? DATE.format(date) : "Any date"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              defaultMonth={date}
              captionLayout="dropdown"
              startMonth={new Date(2015, 0)}
              endMonth={new Date(new Date().getFullYear(), 11)}
              onSelect={chooseDate}
            />
          </PopoverContent>
        </Popover>
        <Input
          type="time"
          aria-label={`${label} time`}
          className="w-32"
          value={time}
          disabled={!day}
          onChange={(event) => onChange(event.target.value ? `${day}T${event.target.value}` : day!)}
        />
      </div>
    </Field>
  );
}
