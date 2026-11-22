import { CalendarIcon, ListFilterIcon, XIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { InfoTip } from "@/components/info-tip";
import { describeHardware, useLocations } from "@/components/machines";
import { Segmented, SegmentedItem } from "@/components/segmented";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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
import { api, type Machine, type PendingMachine } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";
import { useScreen } from "@/lib/use-screen";

// The Shots and Steam Records lists: pages of records, newest first, with
// filters that are the REST API's query parameters, kept in the page's
// address, so a filtered list can be reloaded or shared.

const PAGE_SIZE = 25;

/** The filters every record list has; a list may add its own. */
export const RECORD_FILTERS = ["locationId", "machineId", "pendingMachineId", "from", "to", "period"] as const;

/**
 * The date presets a record list offers (#544), as the REST API names its
 * periods: each is each record's own Location's days, counted back from its
 * own today, so they are the server's to work out.
 */
export const PERIODS = [
  { period: "today", label: "Today" },
  { period: "yesterday", label: "Yesterday" },
  { period: "7days", label: "7 days" },
  { period: "30days", label: "30 days" },
] as const;

/** What a record's page keeps of the list it was opened from, for its link back: the list's filters and page. */
export interface ListState {
  list?: string;
}

/** One page of a list as the REST API answers it, with how many records the whole list has. */
interface ListPage {
  total: number;
}

export interface RecordList<Page extends ListPage> {
  params: URLSearchParams;
  /** The list's address after its path, for a record's link back to it (`ListState`). */
  search: string;
  /** The filters the address has, as the REST API's query, without the page: what a summary of the whole list takes. */
  filterQuery: string;
  /** The page shown: the latest answer, which stays shown while the next loads. */
  data: Page | undefined;
  error: string | undefined;
  /** How many records the page shown has. */
  shown: number;
  offset: number;
  filtered: boolean;
  /** Changes filters, and goes back to the first page; what else the address holds, as the numbers a summary shows, stays. */
  filter(changes: Record<string, string | null>): void;
  /** The address of the page starting at `at`. */
  pageHref(at: number): string;
  /** Goes to the page starting at `at`, for a link to `pageHref(at)`. */
  goTo(at: number): (event: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * A list's page of records at `path`, narrowed by the filters named that the
 * address has, and polled, so new records appear. `rows` reads a page's
 * records. A page past the end, opened from an old link or emptied as records
 * leave the list, moves to the last page, judged only by an answer for this
 * page, never one for the page or filters shown before.
 */
export function useRecordList<Page extends ListPage>(path: string, filters: readonly string[], rows: (page: Page) => readonly unknown[]): RecordList<Page> {
  const [params, setParams] = useSearchParams();
  const { search } = useLocation();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const filterQuery = new URLSearchParams(filters.flatMap((name) => params.getAll(name).slice(0, 1).map((value) => [name, value]))).toString();
  const query = new URLSearchParams([...new URLSearchParams(filterQuery), ["limit", String(PAGE_SIZE)], ["offset", String(offset)]]).toString();
  // Each page loaded remembers what it answers: the last one is still shown while another loads.
  const load = useCallback(async () => ({ query, page: await api<Page>("GET", `${path}?${query}`) }), [path, query]);
  const { data: loaded, error } = usePolled(load);
  const data = loaded?.page;

  const lastPage = data && data.total > 0 ? Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0;
  const pastTheEnd = loaded?.query === query && rows(loaded.page).length === 0 && offset > lastPage;
  useEffect(() => {
    if (!pastTheEnd) return;
    const next = new URLSearchParams(params);
    if (lastPage > 0) next.set("offset", String(lastPage));
    else next.delete("offset");
    setParams(next, { replace: true });
  }, [pastTheEnd, lastPage, params, setParams]);

  function filter(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    next.delete("offset");
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) next.delete(name);
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

  return {
    params,
    search,
    filterQuery,
    data,
    error,
    shown: data ? rows(data).length : 0,
    offset,
    filtered: filters.some((name) => params.has(name)),
    filter,
    pageHref,
    goTo: (at) => (event) => {
      event.preventDefault();
      setParams(new URLSearchParams(pageHref(at)));
    },
  };
}

/** Which records of the list the page shows, such as "Shots 1–25 of 30", and links to the pages either side. */
export function ListPagination({ list, noun }: { list: RecordList<ListPage>; noun: string }) {
  const { data, offset, shown } = list;
  if (!data) return null;
  const first = data.total > 0 ? offset + 1 : 0;
  const last = Math.min(offset + shown, data.total);
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < data.total;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {noun} {first}–{last} of {data.total}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href={list.pageHref(Math.max(0, offset - PAGE_SIZE))}
              onClick={list.goTo(Math.max(0, offset - PAGE_SIZE))}
              aria-disabled={!hasPrevious}
              className={hasPrevious ? undefined : "pointer-events-none opacity-50"}
              tabIndex={hasPrevious ? undefined : -1}
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              href={list.pageHref(offset + PAGE_SIZE)}
              onClick={list.goTo(offset + PAGE_SIZE)}
              aria-disabled={!hasNext}
              className={hasNext ? undefined : "pointer-events-none opacity-50"}
              tabIndex={hasNext ? undefined : -1}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

// Every option of a Select needs a value, so these stand for no filter and for records with nothing recorded
// or no Location, as the REST API's `locationId=none` does. A list's own values must not be mistaken for them.
export const ANY = "any";
export const NONE = "none";

interface Machines {
  machines: Machine[];
  pendingMachines: PendingMachine[];
}

/**
 * One of a list's filters behind its Filters button (#544): what it is
 * `label`led, the address's parameters it holds, what it is set to, as its
 * chip above the list says it, and its control. It is set where the address
 * has any of its `names`; `value` may be missing while what names it loads.
 * One with no control is set only by an address that names it, as a Library
 * item's page opens the list with, and is its chip alone.
 */
export interface ListFilter {
  label: string;
  names: readonly string[];
  value?: string;
  control?: ReactNode;
}

/**
 * The filters every record list has behind its Filters button, by Location
 * and by Machine or Pending Machine, and what went wrong reading their
 * choices, if anything.
 */
export function useRecordFilters(list: RecordList<ListPage>): { filters: ListFilter[]; error: string | undefined } {
  const id = useId();
  const { locations, error: locationsError } = useLocations();
  const [choices, setChoices] = useState<Machines>();
  const [machinesError, setMachinesError] = useState<string>();
  useEffect(() => {
    let current = true;
    Promise.all([api<{ machines: Machine[] }>("GET", "/machines"), api<{ pendingMachines: PendingMachine[] }>("GET", "/pending-machines")]).then(
      ([{ machines }, { pendingMachines }]) => current && setChoices({ machines, pendingMachines }),
      (caught: unknown) => current && setMachinesError(caught instanceof Error ? caught.message : "The filters could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, []);

  const { params } = list;
  const locationId = params.get("locationId");
  const machineId = params.get("machineId");
  const pendingMachineId = params.get("pendingMachineId");
  // A dismissed Pending Machine's records are not listed, so it is no choice.
  const pendingMachines = choices?.pendingMachines.filter((pending) => !pending.dismissed) ?? [];
  const pending = pendingMachines.find((each) => each.id === pendingMachineId);

  const location: ListFilter = {
    label: "Location",
    names: ["locationId"],
    value: locationId === NONE ? "None (UTC)" : locations && (locations.find((each) => each.id === locationId)?.name ?? "Unknown"),
    control: (
      <Field>
        <FieldLabel htmlFor={`${id}-location`}>Location</FieldLabel>
        <Select value={locationId === null ? ANY : locationId} onValueChange={(choice) => list.filter({ locationId: choice === ANY ? null : choice })}>
          <SelectTrigger id={`${id}-location`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any Location</SelectItem>
            {locations?.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NONE}>No Location (UTC)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    ),
  };
  const machine: ListFilter = {
    label: "Machine",
    names: ["machineId", "pendingMachineId"],
    value: choices && (machineId !== null ? (choices.machines.find((each) => each.id === machineId)?.name ?? "Unknown") : pending ? describeHardware(pending) : "Unknown"),
    control: (
      <Field>
        <FieldLabel htmlFor={`${id}-machine`}>Machine</FieldLabel>
        <Select
          value={machineId !== null ? `machine:${machineId}` : pendingMachineId !== null ? `pending:${pendingMachineId}` : ANY}
          onValueChange={(choice) => {
            const [kind, chosen] = choice.split(":");
            list.filter({ machineId: kind === "machine" ? chosen! : null, pendingMachineId: kind === "pending" ? chosen! : null });
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
                {choices.machines.map((each) => (
                  <SelectItem key={each.id} value={`machine:${each.id}`}>
                    {each.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {pendingMachines.length > 0 && (
              <SelectGroup>
                <SelectLabel>Pending Machines</SelectLabel>
                {pendingMachines.map((each) => (
                  <SelectItem key={each.id} value={`pending:${each.id}`}>
                    {describeHardware(each)}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </Field>
    ),
  };
  return { filters: [location, machine], error: machinesError ?? locationsError };
}

/** Tailwind's `sm` breakpoint. */
const WIDE_SCREEN = "(min-width: 640px)";

/** Whether the screen is wide enough for the filters to open beside the list, in a popover, rather than over it, in a sheet. */
function useWideScreen(): boolean {
  return useScreen(WIDE_SCREEN);
}

/** The date preset standing for dates chosen by hand. */
const CUSTOM = "custom";

/**
 * What narrows a record list (#544), above it: its date presets, always in
 * view, of which Custom opens the From and To fields; a chip for each of
 * its other `filters` that is set, which names it and removes it, with a
 * way to clear them all; and the Filters button, which says how many are
 * set and opens them, in a sheet on a narrow screen and a popover on a wide
 * one. Each change is made at once, in the page's address. `noun` names
 * one of the list's records, and `description` says how dates are read, in
 * a tooltip beside the presets. `error` is what went wrong reading the
 * filters' choices, if anything.
 */
export function RecordFilterBar({
  list,
  noun,
  filters,
  error,
  description,
}: {
  list: RecordList<ListPage>;
  noun: "Shot" | "Steam Record";
  filters: readonly ListFilter[];
  error?: string;
  description: string;
}) {
  const id = useId();
  const wide = useWideScreen();
  const [open, setOpen] = useState(false);
  const { params } = list;
  const set = filters.filter((filter) => filter.names.some((name) => params.has(name)));
  const clear = () => list.filter(Object.fromEntries(filters.flatMap((filter) => filter.names.map((name) => [name, null]))));

  // Custom is chosen while the address holds a date, and from when it is pressed until a preset is.
  const [customOpen, setCustomOpen] = useState(false);
  const period = PERIODS.find((each) => each.period === params.get("period"))?.period;
  const dates = period ?? (params.has("from") || params.has("to") || customOpen ? CUSTOM : "");
  function chooseDates(chosen: string) {
    setCustomOpen(chosen === CUSTOM);
    // A preset takes the dates' place, and pressing the one chosen again clears it.
    if (chosen === CUSTOM) list.filter({ period: null });
    else list.filter({ period: chosen === "" ? null : chosen, from: null, to: null });
  }

  const trigger = (
    <Button variant="outline" className="max-sm:ml-auto">
      <ListFilterIcon data-icon="inline-start" />
      Filters
      {set.length > 0 && (
        <>
          <Badge aria-hidden="true" className="h-4.5 min-w-4.5 px-1 tabular-nums">
            {set.length}
          </Badge>
          <span className="sr-only">, {set.length} set</span>
        </>
      )}
    </Button>
  );
  const controls = filters.flatMap((filter) => (filter.control === undefined ? [] : [<div key={filter.label}>{filter.control}</div>]));

  return (
    <section aria-label="Filters" className="grid gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 max-sm:w-full">
          <Segmented label="Dates" value={dates} onValueChange={chooseDates} className="max-sm:flex-1">
            {PERIODS.map((each) => (
              <DatesItem key={each.period} value={each.period}>
                {each.label}
              </DatesItem>
            ))}
            <DatesItem value={CUSTOM} className="max-sm:flex-none">
              <CalendarIcon className="sm:hidden" />
              <span className="max-sm:sr-only">Custom</span>
            </DatesItem>
          </Segmented>
          <InfoTip label="About dates and times">
            <p>
              Today, Yesterday, 7 days and 30 days are each {noun}'s Location's own days, counted back from its own today, or UTC's for a {noun} with
              no Location. Custom chooses the dates.
            </p>
            <p>{description}</p>
          </InfoTip>
        </div>
        {set.length > 0 && (
          <ul aria-label="Filters set" className="flex min-w-0 flex-wrap items-center gap-2">
            {set.map((filter) => (
              <li key={filter.label} className="inline-flex h-8 max-w-full items-center gap-1 rounded-full border bg-muted/50 py-0 pr-1 pl-3 text-sm">
                {/* A phone has room for what it is set to alone, once that is known. */}
                <span className={filter.value === undefined ? "text-muted-foreground" : "text-muted-foreground max-sm:sr-only"}>{filter.value === undefined ? filter.label : `${filter.label}:`}</span>
                {filter.value !== undefined && <span className="truncate font-medium">{filter.value}</span>}
                <Button variant="ghost" size="icon-xs" className="shrink-0 rounded-full text-muted-foreground" aria-label={`Remove the ${filter.label} filter`} onClick={() => list.filter(Object.fromEntries(filter.names.map((name) => [name, null])))}>
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {wide ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent align="start" aria-label="Filters" className="w-[min(40rem,calc(100vw-2rem))] gap-4 p-4">
              <div className="grid grid-cols-2 gap-4">{controls}</div>
              <div>
                <Button variant="outline" onClick={clear} disabled={set.length === 0}>
                  Clear all
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>{trigger}</SheetTrigger>
            <SheetContent side="bottom" aria-describedby={undefined} className="max-h-[85dvh] gap-0 rounded-t-xl">
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
              </SheetHeader>
              <div className="grid gap-3 overflow-y-auto px-4 pb-4">{controls}</div>
              <SheetFooter className="flex-row border-t">
                <Button variant="outline" onClick={clear} disabled={set.length === 0}>
                  Clear all
                </Button>
                <SheetClose asChild>
                  <Button className="flex-1 tabular-nums">{list.data ? `Show ${list.data.total} ${list.data.total === 1 ? noun : `${noun}s`}` : "Done"}</Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        )}
        {/* On a narrow screen the sheet clears them. */}
        {set.length > 0 && (
          <Button variant="ghost" onClick={clear} className="max-sm:hidden">
            Clear
          </Button>
        )}
      </div>
      {dates === CUSTOM && (
        <div className="flex flex-wrap items-end gap-4">
          <DateFilter id={`${id}-from`} label="From" value={params.get("from")} onChange={(from) => list.filter({ from })} />
          <DateFilter id={`${id}-to`} label="To" value={params.get("to")} onChange={(to) => list.filter({ to })} />
        </div>
      )}
    </section>
  );
}

/** One of the date presets, in the segmented control they make: on a narrow screen they share its width. */
function DatesItem({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  return (
    <SegmentedItem value={value} className={`max-sm:flex-1 max-sm:px-1 ${className ?? ""}`}>
      {children}
    </SegmentedItem>
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
