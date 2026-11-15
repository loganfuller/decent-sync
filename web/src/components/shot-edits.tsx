import { StarIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Link } from "react-router";
import { CollapsibleCard } from "@/components/collapsible-card";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { recordTime } from "@/components/records";
import { MadeBy } from "@/components/settings-edit-log";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type Shot, type ShotEdit } from "@/lib/api";
import { MAX_STARS, ratingOf, ratingText, starsOf } from "@/lib/rating";
import { MAX_SHOT_RATING } from "@decent-sync/protocol";

// A Shot's rating and note on its page (#514, ADR-0031): shown to everyone,
// and edited by whoever may edit them, an Admin, or Staff for a Shot at a
// Location they work at. An edit is applied on the server at once and
// written to the tablet that holds the Shot, now or when it next connects,
// so the card says where the edits stand with that tablet, and a card of
// its own, closed until opened, lists each edit with who made it: an
// account, or the Machine whose tablet it was made on (#515), which is any
// tablet at the Shot's Location that doesn't hold the Shot: nearly always
// another Machine's.

/** A rating as the card and its form say it, in stars: 0, or none, is unrated. */
function ratingOrUnrated(rating: number | null): string {
  return ratingText(rating) ?? "Unrated";
}

/** Each star, in order, from 1. */
const STARS = Array.from({ length: MAX_STARS }, (_, index) => index + 1);

/** A star, filled where it counts toward a rating of that many stars, rounded to a whole one as DYE2 rounds one to show it (`enjoymentToStars`). */
function Star({ star, of }: { star: number; of: number }) {
  return <StarIcon aria-hidden className={star <= Math.round(of) ? "fill-current" : "text-muted-foreground"} />;
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
            How the Shot was judged. The rating is up to {MAX_STARS} stars, as DYE2 and a Skin show it on a tablet: each star is two points of
            the rating from 0 to {MAX_SHOT_RATING} that Decaid keeps, which the REST API and an assistant's tools give. Both are set on the
            tablet that holds the Shot, or edited away from it: here, through a Connected App, such as an assistant, or on a tablet at its
            Location that doesn't hold the Shot.
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
              <Field term="Rating">
                <span className="flex items-center gap-2">
                  <span className="flex [&_svg]:size-4">
                    {STARS.map((star) => (
                      <Star key={star} star={star} of={starsOf(shot.enjoyment)} />
                    ))}
                  </span>
                  {ratingOrUnrated(shot.enjoyment)}
                </span>
              </Field>
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

function RatingAndNoteForm({ shot, onCancel, onSaved }: { shot: Shot; onCancel(): void; onSaved(shot: Shot): void }) {
  const id = useId();
  // As the form opened: what the person saw, which what they change is told from, whatever the Shot reads as since.
  const [initial] = useState(() => ({ rating: shot.enjoyment ?? 0, note: shot.notes ?? "" }));
  // The stars pressed, none for unrated; null until one is pressed. Until then the form shows the Shot's rating as it
  // is, which may lie between two stars, as an assistant may set one: no star is pressed for such a rating, so that
  // pressing the one it rounds to sets it.
  const [pressed, setPressed] = useState<number | null>(null);
  const stars = pressed ?? starsOf(initial.rating);
  const rating = pressed === null ? initial.rating : ratingOf(pressed);
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
        <div className="flex items-center gap-1.5">
          <Label id={`${id}-rating`}>Rating</Label>
          <InfoTip label="About Rating">
            <p>Press a star to rate the Shot that many. Press the star chosen again to leave it unrated.</p>
          </InfoTip>
        </div>
        <div className="flex items-center gap-3">
          {/* One star pressed at a time, and none for unrated, or for a rating between two stars: pressing the star chosen again clears it. */}
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby={`${id}-rating`}
            value={Number.isInteger(stars) && stars > 0 ? String(stars) : ""}
            onValueChange={(chosen) => setPressed(Number(chosen))}
          >
            {STARS.map((star) => (
              <ToggleGroupItem key={star} value={String(star)} aria-label={`${star} ${star === 1 ? "star" : "stars"}`}>
                <Star star={star} of={stars} />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {ratingOrUnrated(rating)}
          </span>
        </div>
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
            Each edit of this Shot's rating or note made away from the tablet that holds it, newest first: here, through a Connected App,
            such as an assistant, or on a tablet at its Location that doesn't hold it, which names that tablet's Machine and no person. A
            change made on the tablet that holds it is not listed: it arrives with no person.
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
                    <EditMadeBy edit={edit} />
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

/**
 * Who made an edit: the Machine whose tablet it was made on, as a Library
 * item's history names one, or the account, with any Connected App
 * (`MadeBy`). An edit made on a tablet names no account.
 */
function EditMadeBy({ edit }: { edit: ShotEdit }) {
  if (edit.machine) {
    return (
      <Link to={`/machines/${edit.machine.id}`} className="underline-offset-4 hover:underline">
        {edit.machine.name}
      </Link>
    );
  }
  if (edit.account === null && edit.tabletId) return <span className="text-muted-foreground">A Machine since removed</span>;
  return <MadeBy account={edit.account} connectedApp={edit.connectedApp} />;
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
