import { CalendarIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { describeHardware, useLocations } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
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
import { api, type Machine, type PendingMachine } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

// The Shots and Steam Records lists: pages of records, newest first, with
// filters that are the REST API's query parameters, kept in the page's
// address, so a filtered list can be reloaded or shared.

const PAGE_SIZE = 25;

/** The filters every record list has; a list may add its own. */
export const RECORD_FILTERS = ["locationId", "machineId", "pendingMachineId", "from", "to"] as const;

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
  /** The page shown: the latest answer, which stays shown while the next loads. */
  data: Page | undefined;
  error: string | undefined;
  /** How many records the page shown has. */
  shown: number;
  offset: number;
  filtered: boolean;
  /** Changes filters, and goes back to the first page. */
  filter(changes: Record<string, string | null>): void;
  clear(): void;
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
  const query = new URLSearchParams([...filters.flatMap((name) => params.getAll(name).slice(0, 1).map((value) => [name, value])), ["limit", String(PAGE_SIZE)], ["offset", String(offset)]]).toString();
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
    data,
    error,
    shown: data ? rows(data).length : 0,
    offset,
    filtered: filters.some((name) => params.has(name)),
    filter,
    clear: () => setParams(new URLSearchParams()),
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
 * The filters every record list has: by Location, by Machine or Pending
 * Machine, and by dates and times, with `children` for a list's own.
 * `description` says how dates are read.
 */
export function RecordFilters({
  list,
  error,
  description,
  children,
}: {
  list: RecordList<ListPage>;
  /** A list's own filters' problem, such as their choices failing to load. */
  error?: string;
  description: string;
  children?: ReactNode;
}) {
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
  const problem = machinesError ?? locationsError ?? error;

  return (
    <section aria-label="Filters" className="grid gap-4 rounded-lg border p-4">
      {problem && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field>
          <FieldLabel htmlFor={`${id}-location`}>Location</FieldLabel>
          <Select value={locationId === null ? ANY : locationId} onValueChange={(choice) => list.filter({ locationId: choice === ANY ? null : choice })}>
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

        {children}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <DateFilter id={`${id}-from`} label="From" value={params.get("from")} onChange={(from) => list.filter({ from })} />
        <DateFilter id={`${id}-to`} label="To" value={params.get("to")} onChange={(to) => list.filter({ to })} />
        {list.filtered && (
          <Button variant="outline" onClick={list.clear}>
            Clear filters
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </section>
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
