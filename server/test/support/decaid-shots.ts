import { type DecaidAnswer, castError, decaidUtcNow } from "./decaid-beans.js";

// Decaid's Shot update, as the simulated tablet answers `PUT /shots/{id}`:
// `_updateShot` in decaid:lib/src/services/webserver/shots_handler.dart, with
// `ShotRecord` and `ShotAnnotations` in lib/src/models/data/, read at v0.9.1
// and v0.9.2, which differ here only in answering a malformed body with 400
// where v0.9.1 answers 500. Written from that source: no tablet's answers
// were recorded for it.
//
// - It refuses a body whose `id` is another Shot's, one holding
//   `measurements`, `createdAt` or `updatedAt`, and an
//   `annotations.enjoyment` that is not a number from 0 to 10 or null, each
//   with 400, and a Shot it does not hold with 404.
// - It merges the body into the Shot it holds, object by object, so a field
//   the body leaves out stays as it was, and null replaces a value. The
//   older names `shotNotes` and `metadata` stand for
//   `annotations.espressoNotes` and `annotations.extras` where the body's
//   annotations hold neither, and a note cleared with null is kept as empty
//   text.
// - It keeps the annotations it knows: the doses, TDS and extraction yield
//   and the enjoyment as numbers, the note as text and the extras as an
//   object, leaving out those that are null. `shotNotes` and `metadata`
//   repeat the note and the extras wherever the Shot has annotations.
// - It moves `updatedAt` to now, in UTC, only where the Shot's content
//   changed: anything but its times, `metadata` and the extras that keep
//   upload state.
// - It answers 200 with the Shot, and tells plugins of it in `shotUpdated`,
//   with the Shot without its measurements and the body as sent, whether or
//   not anything changed.
//
// The Workflow is kept as the Shot held it: Decaid reads and writes it
// through its model, which this does not repeat.

type Shot = Record<string, unknown>;

/** What Decaid tells plugins of a Shot it updated. */
export interface ShotUpdatedEvent {
  id: string;
  shot: Shot;
  patch: Shot;
}

/** The keys of `annotations.extras` that keep upload state, which are no content (`ShotRecord.bookkeepingExtrasKeys`). */
const BOOKKEEPING_EXTRAS = ["uploaded_to_decent", "decent_upload_rejected", "visualizerId"];
/** The annotations Decaid keeps as numbers, in ShotAnnotations.toJson's order, before the note and the extras. */
const NUMBERS = ["actualDoseWeight", "actualYield", "drinkTds", "drinkEy", "enjoyment"] as const;
const ENJOYMENT_MAX = 10;

class DartError extends Error {}

/** Updates the Shot the tablet holds, if it holds it, with a request's body, as `PUT /shots/{id}` does. */
export function updateShot(existing: Shot | undefined, id: string, body: unknown): { answer: DecaidAnswer; shot?: Shot; event?: ShotUpdatedEvent } {
  if (!isObject(body)) return { answer: serverError(castError(body, "Map<String, dynamic>")) };
  if (body.id !== undefined && body.id !== null && body.id !== id) return { answer: badRequest("ID in path does not match ID in body") };
  if ("measurements" in body) return { answer: badRequest("measurements is not editable via this endpoint") };
  if ("createdAt" in body || "updatedAt" in body) {
    return { answer: badRequest("createdAt and updatedAt are system-managed and cannot be modified via this endpoint") };
  }
  const enjoyment = isObject(body.annotations) && "enjoyment" in body.annotations ? body.annotations.enjoyment : null;
  if (enjoyment !== null && typeof enjoyment !== "number") return { answer: badRequest(`annotations.enjoyment must be a number between 0 and ${ENJOYMENT_MAX}`) };
  if (enjoyment !== null && (enjoyment < 0 || enjoyment > ENJOYMENT_MAX)) {
    return { answer: badRequest(`annotations.enjoyment must be between 0 and ${ENJOYMENT_MAX}, got ${enjoyment}`) };
  }
  if (!existing) return { answer: { status: 404, body: { error: "Shot not found" } } };
  try {
    const patch = normalizedPatch(body);
    const merged = deepMerge(existing, patch);
    if ("annotations" in patch && (patch.annotations === null || (isObject(patch.annotations) && "espressoNotes" in patch.annotations && patch.annotations.espressoNotes === null))) {
      merged.annotations = { ...(isObject(merged.annotations) ? merged.annotations : {}), espressoNotes: "" };
    }
    const changed = JSON.stringify(contentOf(recorded(merged, id))) !== JSON.stringify(contentOf(recorded(existing, id)));
    const shot = recorded({ ...merged, updatedAt: changed ? decaidUtcNow() : (existing.updatedAt ?? existing.createdAt ?? existing.timestamp) }, id);
    const { measurements: _measurements, ...withoutMeasurements } = shot;
    return { answer: { status: 200, body: shot }, shot, event: { id, shot: withoutMeasurements, patch: body } };
  } catch (error) {
    if (error instanceof DartError) return { answer: serverError(error.message) };
    throw error;
  }
}

/** The body with its older names moved into its annotations, where those hold neither (`_normalizeLegacyAnnotationPatch`). */
function normalizedPatch(body: Shot): Shot {
  const { shotNotes, metadata, ...patch } = body;
  const legacy = { ...("shotNotes" in body && { espressoNotes: shotNotes }), ...("metadata" in body && { extras: metadata }) };
  if (isObject(body.annotations)) return { ...patch, annotations: { ...legacy, ...body.annotations } };
  if (!("annotations" in body) && Object.keys(legacy).length > 0) return { ...patch, annotations: legacy };
  return patch;
}

function deepMerge(base: Shot, overrides: Shot): Shot {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) merged[key] = isObject(merged[key]) && isObject(value) ? deepMerge(merged[key], value) : value;
  return merged;
}

/** The Shot as Decaid's model writes it back (`ShotRecord.fromRecordedJson` and `toJson`), its Workflow as held. */
function recorded(shot: Shot, id: string): Shot {
  const { annotations: held, stopReason, shotNotes: _shotNotes, metadata: _metadata, measurements, workflow, timestamp, createdAt, updatedAt, ...others } = shot;
  const annotations = held === undefined || held === null ? null : annotationsOf(held);
  return {
    ...others,
    id,
    timestamp,
    createdAt,
    updatedAt,
    measurements,
    workflow,
    ...(annotations && { annotations }),
    ...(stopReason !== undefined && stopReason !== null && { stopReason }),
    ...(annotations?.espressoNotes !== undefined && { shotNotes: annotations.espressoNotes }),
    ...(annotations?.extras !== undefined && { metadata: annotations.extras }),
  };
}

/** The annotations Decaid keeps of those given (`ShotAnnotations.fromJson` and `toJson`). */
function annotationsOf(value: unknown): Shot {
  if (!isObject(value)) throw new DartError(castError(value, "Map<String, dynamic>"));
  const { espressoNotes, extras } = value;
  if (espressoNotes !== undefined && espressoNotes !== null && typeof espressoNotes !== "string") throw new DartError(castError(espressoNotes, "String?"));
  if (extras !== undefined && extras !== null && !isObject(extras)) throw new DartError(castError(extras, "Map<String, dynamic>?"));
  return {
    ...Object.fromEntries(NUMBERS.flatMap((key) => (typeof value[key] === "number" ? [[key, value[key]]] : []))),
    ...(typeof espressoNotes === "string" && { espressoNotes }),
    ...(isObject(extras) && { extras }),
  };
}

/** What of a Shot counts as its content (`ShotRecord.contentSignature`). */
function contentOf(shot: Shot): Shot {
  const { createdAt: _createdAt, updatedAt: _updatedAt, metadata: _metadata, measurements: _measurements, annotations, ...content } = shot;
  if (!isObject(annotations)) return content;
  const { extras, ...kept } = annotations;
  const cleaned = isObject(extras) ? Object.fromEntries(Object.entries(extras).filter(([key]) => !BOOKKEEPING_EXTRAS.includes(key))) : extras;
  const normalized = { ...kept, ...(isObject(cleaned) && Object.keys(cleaned).length === 0 ? {} : extras === undefined ? {} : { extras: cleaned }) };
  return Object.keys(normalized).length === 0 ? content : { ...content, annotations: normalized };
}

function isObject(value: unknown): value is Shot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(error: string): DecaidAnswer {
  return { status: 400, body: { error } };
}

/** What Decaid answers an error it did not expect, as its handler does a cast that fails. */
function serverError(error: string): DecaidAnswer {
  return { status: 500, body: { error } };
}
