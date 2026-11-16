import { Prisma } from "../generated/prisma/client.js";
import { shotListedSql, shotRecipeSql } from "./links.js";
import { type ShotSpec, judgeShot } from "./spec.js";
import { LEFT_OUT, SHOT_VALUES, UNFINISHED } from "./summary.js";

// One Shot against the margins (#543; spec.ts, GLOSSARY.md), as a Shot's
// read, a Shots list's row and a Machine's last Shot give it: read by the
// expressions a Shot Summary reads each Shot's by, so a Shot and a group of
// it alone are judged alike.

/** A Shot's judgement, with what it is read with: the Recipe it was pulled with, and its duration as the Shots list shows it. */
export interface JudgedShot {
  recipe: { id: string; name: string | null } | null;
  duration: number | null;
  spec: ShotSpec;
}

/**
 * Each of the Shots' judgements, by its id, in one statement. Its duration
 * is read against the Reference Shot of the Recipe it was pulled with
 * (`shotRecipeSql`), where that Recipe has one the Shots list lists
 * (`shotListedSql`), as a summary reads a group's, so a Recipe's Reference
 * Shot pulled with that Recipe is at no difference from itself.
 */
export async function shotSpecs(db: Prisma.TransactionClient, ids: readonly string[]): Promise<Map<string, JudgedShot>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<
    {
      id: string;
      recipeId: string | null;
      recipeName: string | null;
      unfinished: boolean;
      leftOut: boolean;
      duration: number | null;
      referenceDuration: number | null;
      yieldAgainstTarget: number | null;
      yieldShare: number | null;
      stopReason: string | null;
    }[]
  >`
    SELECT shot.*, r.content ->> 'name' AS "recipeName", reference.duration AS "referenceDuration"
    FROM (
      SELECT s.id, ${shotRecipeSql("s")} AS "recipeId", ${UNFINISHED} AS unfinished, ${LEFT_OUT} AS "leftOut", ${SHOT_VALUES.duration} AS duration,
        ${SHOT_VALUES.yieldAgainstTarget} AS "yieldAgainstTarget", ${SHOT_VALUES.yieldShare} AS "yieldShare", ${SHOT_VALUES.stopReason} AS "stopReason"
      FROM shots s WHERE s.id = ANY(${ids}::text[])
    ) AS shot
    LEFT JOIN recipes r ON r.id = shot."recipeId"
    LEFT JOIN LATERAL (
      SELECT ${SHOT_VALUES.duration} AS duration FROM shots s WHERE s.id = r.reference_shot_id AND ${shotListedSql("s")}
    ) AS reference ON TRUE`;
  return new Map(
    rows.map(({ id, recipeId, recipeName, leftOut, ...measures }) => [
      id,
      {
        recipe: recipeId === null ? null : { id: recipeId, name: recipeName },
        duration: measures.duration,
        spec: judgeShot({ ...measures, cleaningOrCalibration: leftOut }),
      },
    ]),
  );
}
