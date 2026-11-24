import type { ProfileTextField } from "@decent-sync/protocol";
import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import { SourceText } from "@/components/item-history";
import { CardTitleWithInfo } from "@/components/info-tip";
import { FormError, failure } from "@/components/library-forms";
import { ConfirmButton } from "@/components/machines";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ApiError, type DraftSummary, type StartedDraft, api } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// Drafts in the management interface (#579): starting one, what each will
// become, discarding one, and the Library's list of them, above its
// Profiles. A Viewer sees none, so the pages leave all of this out for one.

/** A Draft's page. */
export function draftPath(id: string): string {
  return `/library/drafts/${encodeURIComponent(id)}`;
}

/** What starting a Draft is asked from, as the REST API takes it. */
export type DraftStartBody = { profileId: string; as: "version" | "separate" } | { shape: string } | { file: unknown };

/** What a Draft's page is sent to, from where it was started: what of a file was held to the ranges. */
export interface DraftArrival {
  held?: StartedDraft["held"];
}

/** Starts a Draft and opens it, with what of a file was held to the ranges; a failure to start one, to show. */
export function useStartDraft(): { start(body: DraftStartBody): Promise<void>; starting: boolean; error: string | undefined } {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const start = useCallback(
    async (body: DraftStartBody) => {
      setStarting(true);
      setError(undefined);
      try {
        const { draft, held } = await api<StartedDraft>("POST", "/drafts", body);
        void navigate(draftPath(draft.id), { state: { held } satisfies DraftArrival });
      } catch (caught) {
        setError(failure(caught, "The Draft could not be started"));
      } finally {
        setStarting(false);
      }
    },
    [navigate],
  );
  return { start, starting, error };
}

/**
 * What a Draft will become when it is published, in words: for a new version
 * with the steps of the Profile it started from, given what it changes of
 * that Profile's title, author and notes, an edit of them (#667).
 */
export function draftBecomes(draft: DraftSummary, editsText?: readonly ProfileTextField[] | null): string {
  const from = draft.startedFrom?.title ?? "a Profile since deleted";
  if (draft.publishesAs === "version" && editsText && editsText.length > 0) return `An edit of ${from}'s ${textFieldsText(editsText)}`;
  if (draft.publishesAs === "version") return `A new version of ${from}`;
  if (draft.startedFrom) return `A new Profile, a copy of ${from}`;
  if (draft.shape) return `A new Profile, from ${draft.shape.title}`;
  return "A new Profile, from a file";
}

/** Some of a Profile's title, author and notes, in words: "notes", "title and notes", "title, author and notes". */
export function textFieldsText(fields: readonly ProfileTextField[]): string {
  if (fields.length <= 1) return fields.join("");
  return `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
}

/** When the Draft was saved last, and by whom. */
export function SavedBy({ draft }: { draft: Pick<DraftSummary, "savedAt" | "savedBy"> }) {
  return (
    <>
      saved <RelativeTime at={draft.savedAt} /> by <SourceText source={draft.savedBy} />
    </>
  );
}

/** Discards the Draft once confirmed, then `onDone`. */
export function DiscardDraftButton({ draft, label = "Discard", onDone }: { draft: DraftSummary; label?: string; onDone(): void }) {
  const [error, setError] = useState<string>();
  async function discard() {
    setError(undefined);
    try {
      await api("DELETE", `/drafts/${encodeURIComponent(draft.id)}`);
      onDone();
    } catch (caught) {
      setError(failure(caught, "The Draft could not be discarded"));
    }
  }
  return (
    <div className="grid gap-2">
      {error && <FormError error={error} />}
      <ConfirmButton
        label={label}
        ariaLabel={`Discard the Draft ${draft.title || "with no title"}`}
        title={`Discard ${draft.title ? `"${draft.title}"` : "this Draft"}?`}
        description="Nothing of it is kept, and it can't be brought back. It was never among a tablet's Profiles, so none changes; a Machine following it keeps the steps it has, and is written nothing more."
        confirmLabel="Discard"
        variant="destructive"
        onConfirm={() => void discard()}
      />
    </div>
  );
}

/** The Library's Drafts, above its Profiles, the one saved last first: each with what it will become and who saved it last. Nothing while there are none. */
export function DraftsCard() {
  // A server of the release before has no Drafts, as during a deploy (ADR-0025): the list is left out.
  const load = useCallback(
    () =>
      api<{ drafts: DraftSummary[] }>("GET", "/drafts").then(
        ({ drafts }) => drafts,
        (caught: unknown) => (caught instanceof ApiError && caught.status === 404 ? [] : Promise.reject(caught)),
      ),
    [],
  );
  const { data: drafts, error, reload } = usePolled(load, DETAILS_POLL_MS);
  if (error) return <FormError error={error} />;
  if (!drafts || drafts.length === 0) return null;
  return (
    <Card role="region" aria-label="Drafts">
      <CardHeader>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitleWithInfo title="Drafts">
            <p>
              Profiles being written or changed here, saved as they change. A Draft is on no tablet until it is published; anyone who may change the Library may open, change or
              discard any of them.
            </p>
          </CardTitleWithInfo>
          <span className="text-muted-foreground">· on no tablet until published</span>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid divide-y" aria-label="Drafts">
          {drafts.map((draft) => (
            <li key={draft.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="grid min-w-0 gap-0.5">
                <Link to={draftPath(draft.id)} className="font-semibold underline-offset-4 hover:underline">
                  {draft.title || "Untitled"}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {draftBecomes(draft)} · <SavedBy draft={draft} />
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Button variant="outline" asChild>
                  <Link to={draftPath(draft.id)} aria-label={`Open the Draft ${draft.title || "with no title"}`}>
                    Open
                  </Link>
                </Button>
                <DiscardDraftButton draft={draft} onDone={() => void reload()} />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
