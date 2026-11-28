import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { BatchCell, BatchCode } from "@/components/batch-name";
import { BatchPicker } from "@/components/batch-picker";
import { FormError, failure } from "@/components/library-forms";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { api, type BeanBatch, type BeanBatchSummary, type BeanSummary, type ItemHistory, type Recipe } from "@/lib/api";
import { batchBean, batchCodeOf, batchWords, roastedText } from "@/lib/batch-name";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { dateIn } from "@/lib/machine-activity";
import { daysSinceRoast } from "@/lib/overview";
import { agoText, batchEdit, batchValueOf, hereText, nextRoasts, offeredBatches, recipeBatchGroups, usedBatch, usedBatchText, weightAt } from "@/lib/recipe-batch";
import { leftHereText, weightText } from "@/lib/remaining-weight";

// A Recipe's Bean Batch on its page (#733): the strip under its title, which
// says what is left of the batch at the Recipe's Location; the Change batch
// dialog, which is the batch picker and nothing else; and, for a batch
// finished at the Location, the strip that offers the next roast of the same
// Bean in one press.

/** What names a Recipe a dialog or a line is about. */
const recipeName = (recipe: Pick<Recipe, "name">) => recipe.name ?? "Unnamed Recipe";

/** The edit of a Recipe's batch and nothing else, as its form's Save makes it. */
const saveBatch = (recipe: Recipe, value: string) => api("PATCH", `/recipes/${encodeURIComponent(recipe.id)}`, { content: batchEdit(value) });

/**
 * The strip between a Recipe's title and how it is pulling: its Bean Batch
 * in large text, its Bean the link to the batch, with its Batch Code, over
 * its roast day, how long ago that was by the Location's days, and its
 * roaster; at its right what is left of it at the Recipe's Location, or "Not
 * tracked", a plain number with no mark for a low one; and Change batch, for
 * whoever may change the Recipe. A Recipe naming a Bean with no batch has
 * the Bean's name over "No batch", and one naming neither "No Bean Batch".
 *
 * A Recipe whose batch is finished at its Location has the finished strip in
 * its place (`FinishedStrip`).
 *
 * `batches` and `beans` are the Library's, read with the Recipe, undefined
 * until they are: the weight is left out until then, and where the server
 * says none of it (ADR-0025). `readError` says why they could not be read,
 * which the Change batch dialog and the finished strip show in their place,
 * and `onReread` reads them again, as the dialog opens.
 */
export function RecipeBatchStrip({
  recipe,
  batches,
  beans,
  readError,
  onReread,
  mayChange,
  onChanged,
}: {
  recipe: Recipe;
  batches: BeanBatchSummary[] | undefined;
  beans: BeanSummary[] | undefined;
  readError?: string;
  onReread(): void;
  mayChange: boolean;
  onChanged(): void;
}) {
  const [changing, setChanging] = useState(false);
  const { location } = recipe;
  const batch = usedBatch(recipe);
  const offered = batches && beans ? offeredBatches(batches, beans) : undefined;

  // The Change batch dialog has no trigger of its own, and Use this batch is gone once its save redraws the strip: the
  // keyboard's focus goes back to the button that opened the dialog, or, where a save has replaced it, to the strip's
  // first button, never to the page.
  const wrapper = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const saved = useRef(false);
  const refocus = () => (opener.current?.isConnected ? opener.current : wrapper.current?.querySelector<HTMLElement>("button"))?.focus();
  useEffect(() => {
    if (!saved.current) return;
    saved.current = false;
    if (document.activeElement === null || document.activeElement === document.body) refocus();
  }, [recipe]);
  const onSaved = () => {
    saved.current = true;
    onChanged();
  };

  const dialog = changing && location && (
    <ChangeBatchDialog
      recipe={recipe}
      location={location}
      batches={offered}
      readError={readError}
      onSaved={onSaved}
      onClose={() => setChanging(false)}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        refocus();
      }}
    />
  );
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    opener.current = event.currentTarget;
    if (readError) onReread();
    setChanging(true);
  };
  const change = (label: string) =>
    mayChange &&
    location && (
      <Button variant="outline" onClick={open}>
        {label}
      </Button>
    );

  if (recipe.batchFinished && batch) {
    return (
      <div ref={wrapper} className="contents">
        <FinishedStrip recipe={recipe} batch={batch} next={offered && nextRoasts(recipe, offered, location?.id)} readError={readError} mayChange={mayChange} another={change("Another batch…")} onChanged={onSaved} />
        {dialog}
      </div>
    );
  }

  const { bean } = recipe.uses;
  const days = batch && daysSinceRoast(batch.roastDate, dateIn(location?.timeZone));
  const weight = batch && location ? weightAt(batches?.find((held) => held.id === batch.id), location.id) : undefined;
  return (
    <div ref={wrapper} className="contents">
      <section aria-label="Bean Batch" className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10">
        <div className="grid min-w-0 gap-1">
          <span className="text-[0.8125rem] text-muted-foreground">Bean Batch</span>
          {batch ? (
            <BatchCell batch={batch} id={batch.id} large also={`${days === undefined ? "" : `, ${agoText(days)}`}${batch.bean.roaster ? ` · ${batch.bean.roaster}` : ""}`} />
          ) : bean ? (
            <>
              <div className="text-xl font-semibold wrap-anywhere">
                <Link to={`${LIBRARY_KINDS.bean.pages}/${bean.id}`} className="underline-offset-4 hover:underline">
                  {bean.name ?? "Unnamed Bean"}
                </Link>
              </div>
              <div className="text-muted-foreground">
                No batch
                {bean.roaster && ` · ${bean.roaster}`}
              </div>
            </>
          ) : (
            <div className="text-xl font-semibold text-muted-foreground">No Bean Batch</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {weight !== undefined && location && (
            <dl className="grid gap-0.5">
              <dt className="text-[0.8125rem] text-muted-foreground">Remaining at {location.name}</dt>
              <dd className={`text-2xl leading-tight tracking-tight tabular-nums ${weight === null ? "font-medium text-muted-foreground" : "font-bold"}`}>{weightText(weight)}</dd>
            </dl>
          )}
          {change("Change batch")}
        </div>
        {dialog}
      </section>
    </div>
  );
}

/**
 * What a Recipe's page says of the Location its finished batch left, after
 * the batch's roast day, as the batch's own page says it: "finished here 26
 * Nov", or "moved to Riverside 26 Nov" where a Batch Move of all took it.
 * Read from the batch and its history; nothing until both are read, where
 * neither can be, and where they don't give the day, as for a batch that is
 * Archived, or was never at the Location.
 */
function useLeftHere(recipe: Recipe): string | undefined {
  const batchId = recipe.batchFinished ? recipe.uses.beanBatch?.id : undefined;
  const locationId = recipe.location?.id;
  const [read, setRead] = useState<{ batchId: string; locationId: string; text: string | undefined }>();
  useEffect(() => {
    if (batchId === undefined || locationId === undefined) return;
    let current = true;
    const path = `/bean-batches/${encodeURIComponent(batchId)}`;
    Promise.all([api<{ batch: BeanBatch }>("GET", path), api<ItemHistory>("GET", `${path}/history`).catch(() => undefined)]).then(
      ([{ batch }, history]) => {
        const left = batch.finished.find((each) => each.location.id === locationId);
        if (current) setRead({ batchId, locationId, text: left && leftHereText(left, history?.versions) });
      },
      () => current && setRead({ batchId, locationId, text: undefined }),
    );
    return () => {
      current = false;
    };
  }, [batchId, locationId]);
  return read && read.batchId === batchId && read.locationId === locationId ? read.text : undefined;
}

/**
 * The strip of a Recipe whose Bean Batch is finished at its Location, in
 * the place of the alert it replaces and in its colours: that the batch is
 * finished there, the batch, and when it was finished or where it was moved
 * to; then each other batch of the same Bean at the Location, the latest
 * roasted first, with its weight there and Use this batch, which changes
 * the Recipe's batch at once, as Save does in the Change batch dialog, or
 * one line where there is none; and Another batch…, which opens that
 * dialog. Whoever may not change the Recipe sees it without its buttons. A
 * failure is shown in the strip, and changes nothing.
 */
function FinishedStrip({
  recipe,
  batch,
  next,
  readError,
  mayChange,
  another,
  onChanged,
}: {
  recipe: Recipe;
  batch: NonNullable<ReturnType<typeof usedBatch>>;
  /** The next roasts offered; undefined until the Library's batches are read. */
  next: BeanBatchSummary[] | undefined;
  /** Why they could not be read, said in their place. */
  readError: string | undefined;
  mayChange: boolean;
  another: ReactNode;
  onChanged(): void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const here = recipe.location?.name ?? "its Location";
  const left = useLeftHere(recipe);

  async function use(next: BeanBatchSummary) {
    setSaving(true);
    setError(undefined);
    try {
      await saveBatch(recipe, next.id);
      onChanged();
    } catch (caught) {
      setError(failure(caught, "The Recipe's Bean Batch could not be changed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Bean Batch" className="grid gap-4 rounded-xl border border-destructive/40 bg-card p-4 text-sm">
      <div className="grid min-w-0 gap-1">
        <span className="font-medium text-destructive">Its Bean Batch is finished at {here}</span>
        <BatchCell batch={batch} id={batch.id} large also={left === undefined ? undefined : ` · ${left}`} />
      </div>
      {error && <FormError error={error} />}
      <div className="grid gap-2">
        <p className="font-medium">Pick the next roast of {batchBean(batch)} here</p>
        {!next && readError && <p className="text-destructive">{readError}</p>}
        {next?.length === 0 && (
          <p className="text-muted-foreground">
            No other batch of {batchBean(batch)} is at {here}.
          </p>
        )}
        {next && next.length > 0 && (
          <ul aria-label={`Other batches of ${batchBean(batch)} at ${here}`} className="grid gap-2">
            {next.map((roast, index) => {
              const code = batchCodeOf(roast);
              const weight = weightAt(roast, recipe.location?.id);
              return (
                <li key={roast.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border bg-background px-3 py-2">
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {code !== undefined && <BatchCode code={code} />}
                    <span>{roastedText(roast)}</span>
                    {weight !== undefined && <span className="text-muted-foreground tabular-nums">{weight === null ? "not tracked here" : hereText(weight)}</span>}
                  </span>
                  {mayChange && (
                    <Button variant={index === 0 ? "default" : "outline"} disabled={saving} aria-label={`Use ${batchWords(roast)}`} onClick={() => void use(roast)}>
                      Use this batch
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {another && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {another}
          <span className="text-muted-foreground">The change reaches every tablet at {here}, as an edit does.</span>
        </div>
      )}
    </section>
  );
}

/**
 * Change batch: the batch picker in a dialog, titled for the Recipe, its
 * list in view under the field, with Cancel and Save in its foot. Saving is
 * an edit of the Recipe's batch and nothing else, with everything such an
 * edit does: a batch from elsewhere is added at the Location with no
 * weight, the change reaches the Location's tablets and any Machine with
 * the Recipe loaded, and the Recipe's History keeps it. Cancel changes
 * nothing. It is shown open, by the button that asks for it, each time
 * afresh from the Recipe as it is then. `batches` are those a Recipe is
 * offered (`offeredBatches`), undefined until read, and `readError` why
 * they could not be, shown while Save waits for them.
 */
function ChangeBatchDialog({
  recipe,
  location,
  batches,
  readError,
  onSaved,
  onClose,
  onCloseAutoFocus,
}: {
  recipe: Recipe;
  location: NonNullable<Recipe["location"]>;
  batches: BeanBatchSummary[] | undefined;
  readError: string | undefined;
  onSaved(): void;
  onClose(): void;
  /** Where the keyboard's focus goes as it closes, as it has no trigger of its own. */
  onCloseAutoFocus(event: Event): void;
}) {
  const [initial] = useState(() => batchValueOf(recipe.content));
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const groups = recipeBatchGroups({ batches: batches ?? [], here: location, value: initial, own: usedBatch(recipe), kept: usedBatchText(recipe) });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value === initial) return onClose();
    setSaving(true);
    setError(undefined);
    try {
      await saveBatch(recipe, value);
      onClose();
      onSaved();
    } catch (caught) {
      setError(failure(caught, "The Recipe's Bean Batch could not be changed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Change the Bean Batch of {recipeName(recipe)}</DialogTitle>
          <DialogDescription>A Recipe at {location.name}. The change reaches every tablet there.</DialogDescription>
        </DialogHeader>
        <form aria-label="Change the Bean Batch" className="grid min-w-0 gap-4" onSubmit={save}>
          {error && <FormError error={error} />}
          {!batches && readError && <FormError error={readError} />}
          <div className="grid min-w-0 gap-2">
            <Label htmlFor={`${id}-batch`}>Bean Batch</Label>
            <BatchPicker id={`${id}-batch`} groups={groups} value={value} onChange={setValue} listed />
          </div>
          <ElsewhereNote location={location} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !batches}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The one line under the picker's list wherever a Recipe's batch is picked: what picking a batch from elsewhere does. */
export function ElsewhereNote({ location }: { location: { name: string } }) {
  return (
    <p className="text-sm text-muted-foreground">
      A batch picked from elsewhere is added at {location.name} with no weight. To bring its weight, move it on the batch's page.
    </p>
  );
}
