import { CheckIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BatchCode } from "@/components/batch-name";
import { Input } from "@/components/ui/input";
import { batchBean, batchCodeOf, roastedLine } from "@/lib/batch-name";
import { type BatchOption, type BatchOptionGroup, activeOption, batchCount, matchingGroups, optionName, optionText, typedInto } from "@/lib/batch-picker";
import { cn } from "@/lib/utils";

/**
 * The batch picker (#733): a field that is typed into, over a list of the
 * batches that match, each word typed looked for in a batch's Bean's name,
 * its roaster and its Batch Code, as the list of batches searches. Empty,
 * it lists every option it is given. The Recipe form, the copy dialog and
 * the Shots list's Bean Batch filter pick a batch with it, and it is the
 * whole of the Change batch dialog.
 *
 * Its options come in groups (`lib/batch-picker.ts`): a batch is two lines,
 * its Bean and its Batch Code over its roast day and its note, with its
 * weight at its right, and an entry that is no batch, such as "No batch",
 * one line, which no word typed hides.
 *
 * `listed` keeps the list in view under the field, as the Change batch
 * dialog does, the one chosen marked in it. Otherwise the field reads the
 * option chosen, and the list opens under it, in the page's own flow, so
 * nothing clips it, while the field is typed into, pressed, or arrowed
 * from, and closes on a choice, on Escape and as the keyboard's focus
 * leaves.
 *
 * It is a combo box to a screen reader, its list a list box of options, the
 * one chosen selected. From the keyboard, the arrows, Home and End move
 * through the options, Enter chooses the one they are on, and Escape closes
 * the list, or, where it is `listed`, clears what was typed. `id` is the
 * field's, which its label names.
 */
export function BatchPicker({
  id,
  groups,
  value,
  onChange,
  listed = false,
  className,
}: {
  id: string;
  groups: readonly BatchOptionGroup[];
  value: string;
  onChange(value: string): void;
  listed?: boolean;
  className?: string;
}) {
  // What is typed; null while nothing is, when the field reads the option chosen.
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>();
  const wrapper = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const search = typed ?? "";
  const shown = matchingGroups(groups, search);
  const options = shown.flatMap((group) => group.options);
  const chosen = groups.flatMap((group) => group.options).find((option) => option.value === value);
  const visible = listed || open;
  const shownValue = typed ?? (listed || !chosen ? "" : optionText(chosen));
  const at = activeOption(options, active, value, search);
  const optionId = (option: BatchOption) => `${id}-option-${options.indexOf(option)}`;
  const noMatch = search.trim() !== "" && batchCount(groups) > 0 && batchCount(shown) === 0;

  const close = () => {
    setOpen(false);
    setActive(undefined);
    if (!listed) setTyped(null);
  };
  const choose = (option: BatchOption) => {
    onChange(option.value);
    setActive(option.value);
    if (!listed) close();
  };

  // The option the arrows are on stays in view, the list alone scrolling to it, never the page or a dialog around it:
  // as it changes, and as the list opens or what is typed changes, not as a reader scrolls the list by hand.
  const atId = at && optionId(at);
  useLayoutEffect(() => {
    const box = list.current;
    const option = atId === undefined ? null : document.getElementById(atId);
    if (!visible || !box || !option) return;
    const [top, bottom] = [option.offsetTop, option.offsetTop + option.offsetHeight];
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }, [visible, atId, search]);

  // Escape closes the list alone, or clears what was typed: heard before a dialog or a popover around the picker hears
  // it, each of which listens on the document as the key goes down, and would close with the form it holds.
  const escapes = listed ? search !== "" : open;
  useEffect(() => {
    if (!escapes) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !wrapper.current?.contains(document.activeElement)) return;
      event.stopPropagation();
      event.preventDefault();
      if (listed) setTyped(null);
      else {
        setOpen(false);
        setActive(undefined);
        setTyped(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [escapes, listed]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // While the field reads the option chosen, a key that types or deletes replaces all of it, wherever the caret is:
    // after a choice, which leaves the caret at its end, as after a select on focus a browser didn't keep.
    const edits = event.key.length === 1 || event.key === "Backspace" || event.key === "Delete";
    if (typed === null && shownValue !== "" && edits && !event.ctrlKey && !event.metaKey && !event.altKey) event.currentTarget.select();
    const move = (to: BatchOption | undefined) => {
      event.preventDefault();
      if (!visible) return setOpen(true);
      if (to) setActive(to.value);
    };
    const index = at ? options.indexOf(at) : -1;
    if (event.key === "ArrowDown") move(options[Math.min(index + 1, options.length - 1)]);
    else if (event.key === "ArrowUp") move(options[Math.max(index - 1, 0)]);
    else if (event.key === "Home" && visible && typed === null) move(options[0]);
    else if (event.key === "End" && visible && typed === null) move(options.at(-1));
    else if (event.key === "Enter" && visible) {
      // Chooses the option, if the arrows or the words typed are on one, and leaves the form around the picker unsent.
      event.preventDefault();
      if (at) choose(at);
    }
  }

  return (
    <div
      ref={wrapper}
      className={cn("grid min-w-0 gap-1.5", className)}
      onBlur={(event) => {
        if (!listed && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <Input
        ref={field}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={visible}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={visible && at ? optionId(at) : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="Bean, roaster or Batch Code"
        className="w-full"
        value={shownValue}
        // What the field reads of the option chosen is replaced by the first key typed.
        onFocus={(event) => event.currentTarget.select()}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          // A browser that keeps no select on focus, as Safari may on a click or a tap, puts what is typed into what the
          // field read of the option chosen: that is taken alone, as the select would have had it.
          setTyped(typed === null ? typedInto(shownValue, event.target.value) : event.target.value);
          setOpen(true);
          setActive(undefined);
        }}
        onKeyDown={onKeyDown}
      />
      {visible && (
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={search.trim() === "" ? "Batches" : `Batches matching ${search.trim()}`}
          // Its options are pressed with the keyboard's focus left in the field.
          onMouseDown={(event) => event.preventDefault()}
          className={cn("relative overflow-y-auto overscroll-contain rounded-lg border bg-popover text-popover-foreground", listed ? "max-h-[min(24rem,45dvh)]" : "max-h-72")}
        >
          {shown.map((group, index) => (
            <div key={group.label ?? index} role="group" aria-label={group.label} className="border-t first:border-t-0">
              {group.label !== undefined && (
                <div aria-hidden="true" className="px-3 pt-2.5 pb-1 text-[0.8125rem] font-medium text-muted-foreground">
                  {group.label}
                </div>
              )}
              {group.options.map((option) => (
                <Option key={option.value} id={optionId(option)} option={option} chosen={option.value === value} active={option === at} onChoose={() => choose(option)} />
              ))}
            </div>
          ))}
          {noMatch && <p className="border-t px-3 py-2.5 text-sm text-muted-foreground first:border-t-0">No batch matches.</p>}
        </div>
      )}
    </div>
  );
}

/** An option of the list: a batch in two lines with its weight at its right, or an entry that is no batch in one, the one chosen marked. */
function Option({ id, option, chosen, active, onChoose }: { id: string; option: BatchOption; chosen: boolean; active: boolean; onChoose(): void }) {
  const { batch } = option;
  const code = batch && batchCodeOf(batch);
  return (
    <div
      id={id}
      role="option"
      aria-selected={chosen}
      aria-label={optionName(option)}
      onClick={onChoose}
      className={cn("flex min-h-11 cursor-default items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-muted/60", active && "bg-muted", chosen && "font-medium")}
    >
      {batch ? (
        <span className="grid min-w-0 gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium wrap-anywhere">{batchBean(batch)}</span>
            {code !== undefined && <BatchCode code={code} />}
          </span>
          <span className="font-normal text-muted-foreground">
            {roastedLine(batch)}
            {option.note !== undefined && ` · ${option.note}`}
          </span>
        </span>
      ) : (
        <span className="min-w-0 wrap-anywhere">{option.label}</span>
      )}
      <span className="flex shrink-0 items-center gap-2 font-normal whitespace-nowrap text-muted-foreground tabular-nums">
        {option.weight}
        {chosen && <CheckIcon aria-hidden="true" className="size-4 text-foreground" />}
      </span>
    </div>
  );
}
