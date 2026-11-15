import { type FormEvent, useId, useState } from "react";
import { CollapsibleCard } from "@/components/collapsible-card";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { recordTime } from "@/components/records";
import { ratingText } from "@/components/shots";
import { MadeBy } from "@/components/settings-edit-log";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, type Shot, type ShotEdit } from "@/lib/api";
import { MAX_SHOT_RATING } from "@decent-sync/protocol";

// A Shot's rating and note on its page (#514, ADR-0031): shown to everyone,
// and edited by whoever may edit them, an Admin, or Staff for a Shot at a
// Location they work at. An edit is applied on the server at once and
// written to the tablet that holds the Shot, now or when it next connects,
// so the card says where the edits stand with that tablet, and a card of
// its own, closed until opened, lists each edit with who made it.

/** A rating as the card and its form say it: 0, or none, is unrated. */
function ratingOrUnrated(rating: number | null): string {
  return ratingText(rating) ?? "Unrated";
}

/** Where a Shot's edits stand with the tablet that holds it, as the card says it in plain sight, with what explains it in its tooltip. */
const STANDING = {
  awaitingTablet: {
    label: "Awaiting its tablet",
    tip: "An edit of its rating or note made away from the tablet that holds this Shot is not written there yet, as while that tablet is off or its plugin is older than this release. Its Skin and DYE2 show the Shot as it was until then. Where the same is changed on that tablet later than the edit, the tablet's stands. An edit whose tablet never connects again, as one replaced, waits for good.",
  },
  noTablet: {
    label: "No tablet to reach",
    tip: "The tablet that held this Shot answered that it no longer holds it, as when the Shot is deleted there. Its latest edit is kept here, and written to no tablet.",
  },
} as const;

/**
 * The Shot's rating and note, with where their edits stand with its tablet,
 * and, for whoever may edit them, a form that edits them: only what was
 * changed is sent, so an edit of the rating leaves the note alone, and the
 * reverse. `onEdited` is given the Shot as the server then reads it.
 */
export function RatingAndNoteCard({ shot, onEdited }: { shot: Shot; onEdited(shot: Shot): void }) {
  const mayEdit = useMayChangeAt()(shot.location?.id ?? null);
  const [editing, setEditing] = useState(false);
  const standing = shot.editStanding ? STANDING[shot.editStanding] : undefined;
  return (
    <Card role="region" aria-label="Rating and note">
      <CardHeader>
        <CardTitleWithInfo title="Rating and note">
          <p>
            How the Shot was judged. The rating runs from 1 to {MAX_SHOT_RATING}: DYE2 on a tablet shows it as five stars, two points a star. Both
            are set on the tablet that holds the Shot, or edited away from it: here, or through a Connected App, such as an assistant.
          </p>
          <p>
            An edit made away from that tablet shows here at once, and is written to that tablet, now if it is connected and otherwise when it
            next connects. An Admin edits any Shot, and Staff those at the Locations they work at.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-4">
        {standing && (
          <p role="status" aria-label="Edits and the tablet" className="flex items-center gap-1.5">
            <Badge variant="secondary">{standing.label}</Badge>
            <InfoTip label={`About ${standing.label}`}>
              <p>{standing.tip}</p>
            </InfoTip>
          </p>
        )}
        {/* Closed if the account may no longer edit it, as when an Admin made it a Viewer meanwhile. */}
        {editing && mayEdit ? (
          <RatingAndNoteForm
            shot={shot}
            onCancel={() => setEditing(false)}
            onSaved={(edited) => {
              setEditing(false);
              onEdited(edited);
            }}
          />
        ) : (
          <>
            <Fields label="Rating and note">
              <Field term="Rating">{ratingOrUnrated(shot.enjoyment)}</Field>
              <Field term="Note">
                {shot.notes ? <span className="whitespace-pre-wrap">{shot.notes}</span> : <span className="text-muted-foreground">None</span>}
              </Field>
            </Fields>
            {mayEdit && (
              <div>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit
                  <span className="sr-only"> its rating and note</span>
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A Select's value for each rating offered: unrated, then each whole number, and the Shot's own where it is none of those, as another Skin may set. */
function ratingChoices(current: number): number[] {
  const whole = Array.from({ length: MAX_SHOT_RATING + 1 }, (_, rating) => rating);
  return whole.includes(current) ? whole : [...whole, current].sort((a, b) => a - b);
}

function RatingAndNoteForm({ shot, onCancel, onSaved }: { shot: Shot; onCancel(): void; onSaved(shot: Shot): void }) {
  const id = useId();
  // As the form opened: what the person saw, which what they change is told from, whatever the Shot reads as since.
  const [initial] = useState(() => ({ rating: shot.enjoyment ?? 0, note: shot.notes ?? "" }));
  const [rating, setRating] = useState(initial.rating);
  const [note, setNote] = useState(initial.note);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const changed = { ...(rating !== initial.rating && { rating }), ...(note !== initial.note && { note }) };
    if (Object.keys(changed).length === 0) return onCancel();
    setSaving(true);
    try {
      const { shot: edited } = await api<{ shot: Shot }>("PATCH", `/shots/${encodeURIComponent(shot.id)}`, changed);
      onSaved(edited);
    } catch (caught) {
      setError(failure(caught, "The edit could not be saved"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Edit its rating and note" className="grid gap-4" onSubmit={(event) => void save(event)}>
      {error && <FormError error={error} />}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-rating`}>Rating</Label>
        <Select value={String(rating)} onValueChange={(chosen) => setRating(Number(chosen))}>
          <SelectTrigger id={`${id}-rating`} className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ratingChoices(initial.rating).map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {ratingOrUnrated(choice)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-note`}>Note</Label>
        <Textarea id={`${id}-note`} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The edits of the Shot's rating and note made through the server, newest
 * first, as its read lists them: when each was made, who made it, what it
 * set, and where it stands with the tablet that holds the Shot, one dropped
 * for a later change on that tablet marked so. Shown closed until opened,
 * as most who read the page do not need them.
 */
export function ShotEditsCard({ shot }: { shot: Shot }) {
  const edits = shot.edits ?? [];
  return (
    <CollapsibleCard
      title="Rating and note edits"
      info={
        <>
          <p>
            Each edit of this Shot's rating or note made away from the tablet that holds it, newest first: here, or through a Connected App,
            such as an assistant. A change made on that tablet is not listed: it arrives with no person.
          </p>
          <p>
            An edit awaits its tablet until it is written there. It is dropped where its rating or note was changed on that tablet later than
            the edit was made, so the tablet's stands. It has no tablet to reach where that tablet no longer holds the Shot.
          </p>
        </>
      }
    >
      <CardContent className="grid gap-3">
        {edits.length === 0 ? (
          <p className="text-sm text-muted-foreground">Its rating and note have not been edited away from its tablet.</p>
        ) : (
          <Table aria-label="Rating and note edits">
            <TableHeader>
              <TableRow>
                <TableHead>Made</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Tablet</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {edits.map((edit) => (
                <TableRow key={edit.id}>
                  <TableCell>{recordTime(edit.madeAt, shot)}</TableCell>
                  <TableCell>
                    <MadeBy account={edit.account} connectedApp={edit.connectedApp} />
                  </TableCell>
                  <TableCell className="min-w-48 whitespace-normal">
                    <ul className="grid gap-0.5">
                      {edit.fields.rating !== undefined && <li>Rating: {ratingOrUnrated(edit.fields.rating)}</li>}
                      {edit.fields.note !== undefined && (
                        <li className="wrap-anywhere whitespace-pre-wrap">Note: {edit.fields.note.trim() === "" ? "None" : edit.fields.note}</li>
                      )}
                    </ul>
                  </TableCell>
                  <TableCell className="min-w-48 whitespace-normal">{tabletText(edit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </CollapsibleCard>
  );
}

const STATES = {
  awaitingTablet: "Awaiting its tablet",
  written: "Written to its tablet",
  dropped: "Dropped for a later change on the tablet",
  noTablet: "No tablet to reach",
} as const;

/** Where an edit stands with its tablet, and, for one of both fields of which the tablet changed one later, which was dropped. */
function tabletText(edit: ShotEdit): string {
  if (edit.state === "dropped" || edit.dropped.length === 0) return STATES[edit.state];
  return `${STATES[edit.state]}; its ${edit.dropped.join(" and ")} dropped for a later change on the tablet`;
}
