import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth";
import { CardTitleWithInfo } from "@/components/info-tip";
import { SETTINGS } from "@/components/machine-collections";
import { formatTime } from "@/components/machines";
import { labelOf, outcomeText, scheduleSubject, shownValue } from "@/components/settings-edits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type SettingsEdit, type SettingsEditPage, api } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";
import { WAKE_SCHEDULE_FIELDS } from "@decent-sync/protocol";

const PAGE_SIZE = 20;

/**
 * The Machine's Settings Edits (ADR-0023), newest first, a page at a time:
 * when each was made, who made it, its section, each field's value before
 * and after, and what came of it. Loaded again whenever `answered` changes,
 * as an edit made on the page is answered.
 */
export function SettingsEditsCard({ machineId, answered }: { machineId: string; answered: number }) {
  const [offset, setOffset] = useState(0);
  // Each page loaded remembers where it starts: the last one is still shown while another loads.
  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    return { offset, page: await api<SettingsEditPage>("GET", `/machines/${encodeURIComponent(machineId)}/settings-edits?${query}`) };
  }, [machineId, offset]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  // Loaded again as an edit is answered; the first load is usePolled's.
  const seen = useRef(answered);
  useEffect(() => {
    if (seen.current === answered) return;
    seen.current = answered;
    void reload();
  }, [answered, reload]);

  const first = data ? data.offset + 1 : 0;
  const last = data ? data.offset + data.page.settingsEdits.length : 0;
  return (
    <Card role="region" aria-label="Settings Edits">
      <CardHeader>
        <CardTitleWithInfo title="Settings Edits">
          <p>
            Each change of the Machine's settings made here, newest first, with what came of it. Changes made on the Tablet are not
            listed: the Settings card shows what the Machine holds.
          </p>
        </CardTitleWithInfo>
        {data?.page.total === 0 && <CardDescription>None of its settings have been changed here.</CardDescription>}
      </CardHeader>
      {(error || (data && data.page.total > 0)) && (
        <CardContent className="grid gap-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>Could not read the Settings Edits: {error}</AlertDescription>
            </Alert>
          )}
          {data && data.page.settingsEdits.length > 0 && (
            <Table aria-label="Settings Edits">
              <TableHeader>
                <TableRow>
                  <TableHead>Made</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.page.settingsEdits.map((edit) => (
                  <TableRow key={edit.id}>
                    <TableCell>{formatTime(edit.madeAt)}</TableCell>
                    <TableCell>
                      <MadeBy account={edit.account} />
                    </TableCell>
                    <TableCell className="whitespace-normal">{SETTINGS[edit.collection as keyof typeof SETTINGS] ?? edit.collection}</TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      <Change edit={edit} />
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      <Outcome edit={edit} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data && data.page.total > PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                Edits {first}–{last} of {data.page.total}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
                  Newer
                </Button>
                <Button variant="outline" size="sm" disabled={last >= data.page.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
                  Older
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** Who made an edit: "You" for one's own; named to Admins; otherwise as the Library's history shows Staff another account. */
function MadeBy({ account }: { account: SettingsEdit["account"] }) {
  const { state } = useAuth();
  if (account === null) return <span className="text-muted-foreground">An account since removed</span>;
  if (state.status === "signed-in" && state.account.id === account.id) return <>You</>;
  return <>{account.name ?? "An account"}</>;
}

/**
 * Each field the edit set, with its value in the report it was made over and
 * the value it asked for; for a wake schedule, what was done to it first,
 * and a new schedule's fields as asked for.
 */
function Change({ edit }: { edit: SettingsEdit }) {
  const scheduled = edit.schedule !== null;
  const added = edit.schedule?.action === "add";
  // A wake schedule's fields in their order, as the server stores an edit's fields as jsonb, which does not keep it.
  const paths = scheduled ? WAKE_SCHEDULE_FIELDS.map((field) => field.path).filter((path) => path in edit.fields) : Object.keys(edit.fields);
  return (
    <div className="grid gap-0.5">
      {scheduled && <span>{scheduleSubject(edit)}</span>}
      {paths.length > 0 && (
        <ul className="grid gap-0.5">
          {paths.map((path) => [path, edit.fields[path]] as const).map(([path, value]) => (
            <li key={path}>
              {labelOf(edit.collection, path, scheduled)}:{" "}
              {added
                ? shownValue(edit.collection, path, value, null, scheduled)
                : `${shownValue(edit.collection, path, edit.expected[path], null, scheduled)} to ${shownValue(edit.collection, path, value, null, scheduled)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What came of an edit: pending, not confirmed, or its answer, marked if it came late. */
function Outcome({ edit }: { edit: SettingsEdit }) {
  if (edit.outcome === null) return <>Pending</>;
  if (edit.outcome === "notConfirmed") return <>Not confirmed</>;
  const { title, description } = outcomeText(edit);
  return (
    <div className="grid gap-0.5">
      <span>{edit.late ? `${title}, answered late` : title}</span>
      {/* An applied edit's values are those of its change. */}
      {edit.outcome !== "applied" && <span className="text-xs text-muted-foreground">{description}</span>}
    </div>
  );
}
