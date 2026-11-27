import { Prisma } from "../generated/prisma/client.js";
import { isObject } from "./listed.js";

// A Bean Batch as whatever points at one names it (#732): a Shot's batch,
// the batches a filter offers, and the batch a Machine's Workflow or a change
// of it names. One shape, read one way, so each gives the batch's Bean, roast
// date and Batch Code as the Library holds them now.

/** A Library Bean Batch as what points at it names it: its Bean, its roast date as Decaid recorded it, and its Batch Code, null where it has none. */
export interface BatchLink {
  id: string;
  bean: { id: string; roaster: string | null; name: string | null };
  roastDate: string | null;
  batchCode: string | null;
}

/** What a `BatchLink` is read from. */
export const batchLink = { id: true, content: true, bean: { select: { id: true, content: true } } } as const satisfies Prisma.BeanBatchSelect;

export function viewBatchLink(batch: Prisma.BeanBatchGetPayload<{ select: typeof batchLink }>): BatchLink {
  const content = isObject(batch.content) ? batch.content : {};
  const bean = isObject(batch.bean.content) ? batch.bean.content : {};
  return {
    id: batch.id,
    bean: { id: batch.bean.id, roaster: text(bean.roaster), name: text(bean.name) },
    roastDate: text(content.roastDate),
    batchCode: text(content.batchCode),
  };
}

/** The Library's Bean Batches of these ids, by id: none for an id it holds no batch for. */
export async function batchLinksOf(db: Pick<Prisma.TransactionClient, "beanBatch">, ids: Iterable<string | null>): Promise<Map<string, BatchLink>> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const batches = await db.beanBatch.findMany({ where: { id: { in: wanted } }, select: batchLink });
  return new Map(batches.map((batch) => [batch.id, viewBatchLink(batch)]));
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
