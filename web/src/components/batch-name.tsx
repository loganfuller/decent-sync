import type { ReactNode } from "react";
import { Link } from "react-router";
import { type NamedBatch, batchCodeOf, batchLine, batchOfBean, batchWords, roastedLine, roastedText } from "@/lib/batch-name";
import { LIBRARY_KINDS } from "@/lib/library-kinds";

// A Bean Batch's name as the management interface draws it (#732), in each
// form `lib/batch-name.ts` words: in a line, in a table's cell, and where
// its Bean is already said. A name is a link to the batch's page wherever
// `id` is given: everywhere but on that page, in a dialog and in an option
// of a select, which name it in words (`batchWords`).

/** A batch's page. */
export function batchPath(id: string): string {
  return `${LIBRARY_KINDS.beanBatch.pages}/${encodeURIComponent(id)}`;
}

const LINK = "font-medium underline-offset-4 hover:underline";

/**
 * A Batch Code, set apart: the monospace chip a batch's page draws beside
 * its title, or plain monospace text (`plain`) where a chip is too heavy, as
 * in a list's small second line. `className` sizes the chip where the text
 * around it isn't the page's own size.
 */
export function BatchCode({ code, plain = false, className }: { code: string; plain?: boolean; className?: string }) {
  return (
    <span
      aria-label={`Batch Code ${code}`}
      className={plain ? "font-mono font-medium" : `rounded-md border bg-muted font-mono font-medium whitespace-nowrap text-foreground ${className ?? "px-1.5 py-px text-[0.8125rem]"}`}
    >
      {code}
    </span>
  );
}

/**
 * A batch's Bean, the link to the batch's page where `id` is given, the link
 * named in words, as its text alone doesn't tell two roasts of a Bean apart.
 */
function BeanOfBatch({ batch, bean, id, linkClassName = LINK }: { batch: NamedBatch; bean: string; id?: string; linkClassName?: string }) {
  if (id === undefined) return <>{bean}</>;
  return (
    <Link to={batchPath(id)} aria-label={batchWords(batch)} className={linkClassName}>
      {bean}
    </Link>
  );
}

/**
 * A batch in a line: its Bean, linked, with its Batch Code set apart, such
 * as House Espresso `LR-0411`, or "House Espresso, roasted 10 Nov" for a
 * batch with none. `roasted` writes the roast date after a code too, as a
 * Recipe's own card does: House Espresso `LR-0411` roasted 17 Nov.
 */
export function BatchInLine({
  batch,
  id,
  plain,
  roasted = false,
  linkClassName,
}: {
  batch: NamedBatch;
  /** The batch's id, where its name is the link to its page. */
  id?: string;
  /** Its code as plain monospace text, not a chip. */
  plain?: boolean;
  roasted?: boolean;
  linkClassName?: string;
}) {
  const { bean, code, after } = batchLine(batch);
  return (
    <span>
      <BeanOfBatch batch={batch} bean={bean} id={id} linkClassName={linkClassName} />
      {code === undefined ? (
        after
      ) : (
        <>
          {" "}
          <BatchCode code={code} plain={plain} />
          {roasted && ` ${roastedText(batch)}`}
        </>
      )}
    </span>
  );
}

/**
 * A batch in a table's cell, or wherever its name has a second line: its
 * Bean, linked, with its Batch Code and whatever is shown beside its name
 * (`beside`), such as "Batch finished here", over "Roasted 17 Nov" and what
 * follows that on its line (`also`). A table with a Batch Code column of its
 * own leaves the code out here (`code` false).
 */
export function BatchCell({ batch, id, code = true, beside, also }: { batch: NamedBatch; id?: string; code?: boolean; beside?: ReactNode; also?: ReactNode }) {
  const { bean } = batchLine(batch);
  const batchCode = code ? batchCodeOf(batch) : undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <BeanOfBatch batch={batch} bean={bean} id={id} />
        {batchCode !== undefined && <BatchCode code={batchCode} />}
        {beside}
      </div>
      <div className="text-sm text-muted-foreground">
        {roastedLine(batch)}
        {also}
      </div>
    </>
  );
}

/**
 * A batch where its Bean is already said: its Batch Code, set apart, with
 * "roasted 17 Nov" after it, or "Roasted 10 Nov" for a batch with none.
 * `brief`, between two batches of one Bean, as a Machine's Activity names
 * the next roast, is the code alone, or "roasted 10 Nov". Linked to the
 * batch's page where `id` is given, the link named in words, as its text
 * alone leaves the Bean out.
 */
export function BatchOfBean({ batch, id, brief = false, linkClassName }: { batch: NamedBatch; id?: string; brief?: boolean; linkClassName?: string }) {
  const { code, roasted } = batchOfBean(batch);
  const shown =
    code === undefined ? (
      brief ? (
        roastedText(batch)
      ) : (
        roasted
      )
    ) : (
      <>
        <BatchCode code={code} />
        {!brief && ` ${roasted}`}
      </>
    );
  if (id === undefined) return <span>{shown}</span>;
  return (
    <Link to={batchPath(id)} aria-label={batchWords(batch)} className={linkClassName ?? "underline-offset-4 hover:underline"}>
      {shown}
    </Link>
  );
}
