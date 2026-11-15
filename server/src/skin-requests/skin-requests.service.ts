import { Injectable } from "@nestjs/common";
import { type NotServed, type SkinAnswer, type SkinReference, type SkinRefusal, type SkinRequest, type SkinShotEdited, type SkinStatus } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { INTAKE_TRANSACTION, lockHeldMachine } from "../library/intake.js";
import { RecipeEditsService } from "../library/recipe-edits.service.js";
import { PrismaService } from "../prisma.service.js";
import { type DueCopy, recipeReference, referenceCopiesDue } from "../shots/location-references.js";
import { type AskingTablet, locationShot, locationShots } from "../shots/location-shots.js";
import { ShotEditsService } from "../shots/shot-edits.service.js";
import type { ShotEditFields } from "../shots/shot-edits.js";
import { lockShot } from "../shots/shots.service.js";
import type { Identity } from "../sync/identity.js";

// What a plugin asks the server for a Skin on its tablet (ADR-0030,
// milestone 8). A Skin calls an HTTP endpoint of the plugin's, the plugin
// sends a `request` over its connection, and the sync gateway has it
// answered here, in its turn among the connection's frames, so after the
// deliveries that arrived before it are stored. A request is never stored or
// remembered: each is read afresh and answered once.
//
// Only a Machine that takes part in the Library is served: one at a
// Location, with sharing on, connected as itself. That is where the tablet
// writer writes (`tabletDue` in library/tablet-due.ts, and the gateway, which
// gives a mismatched connection no writer). `status` says so, and why not.
//
// And only the connection holding its Machine is answered, as only it is
// written to: each answer is read with that checked in the same statement,
// or the same snapshot, so it holds on any instance (ADR-0016).
//
// A served Machine's tablet reads its Location's Shots (ticket #509,
// shots/location-shots.ts): a page of them, and any one of them whole. A
// Machine that is not served is refused each with why `status` says it is
// not, and a served one a Shot its list does not list as no such Shot,
// whether or not the server holds it.
//
// It reads the Reference Shot of any Recipe of its Location too (ticket
// #510, shots/location-references.ts), whichever Location pulled it, and
// any other Recipe is refused as no such Recipe. And it keeps a copy of the
// Reference Shot of each Recipe in a slot there, which the connection's
// `ReferenceCopies` sends as `referenceCopiesDue` here finds them due.
//
// Two asks change something. `chooseReference` makes a Shot the tablet may
// read whole the Reference Shot of one of its Location's Recipes (ticket
// #511, amending ADR-0029), through the service the management interface
// and an assistant's tool choose one through (`RecipeEditsService`). And
// `editShot` sets the rating, the note or both of a Shot its list lists
// (ticket #515, ADR-0031), through the service the REST API's route and an
// assistant's tool edit one through (`ShotEditsService`), kept with its
// Machine and tablet and no account. Its plugin asks only for a Shot its
// tablet doesn't hold, and writes the ones it does through Decaid. Each is
// made while its request is handled or not at all: nothing of it is kept to
// make later. Its answer may still be lost on the way, as when the
// connection closes meanwhile, so a plugin that sent the request and has no
// answer can't tell its Skin whether it was made.

/** The connection a request arrived on: its session, its token's Machine, its tablet, and who that tablet is, as its hello settled it. */
export interface AskingConnection {
  sessionId: string;
  machineId: string;
  tabletId: string;
  identity: Identity;
}

@Injectable()
export class SkinRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipeEdits: RecipeEditsService,
    private readonly shotEdits: ShotEditsService,
  ) {}

  /**
   * Answers a request, as things stand now. Null where the connection no
   * longer holds its Machine, as once another hello has taken it and before
   * this instance is told: the request has no answer, and the connection is
   * to be ended.
   */
  async answer(connection: AskingConnection, request: SkinRequest): Promise<SkinAnswer | null> {
    const answer = { type: "answer", id: request.id } as const;
    switch (request.ask) {
      case "status": {
        const result = await this.status(this.prisma, connection);
        return result && { ...answer, ask: "status", result };
      }
      case "shots": {
        const outcome = await this.served(connection, async (db, asking) => {
          const result = await locationShots(db, asking, request.limit, request.cursor);
          return result ? { result } : { refused: "invalidCursor" as const };
        });
        return outcome && { ...answer, ask: "shots", ...outcome };
      }
      case "shot": {
        const outcome = await this.served(connection, async (db, asking) => {
          const result = await locationShot(db, asking, request.shotId);
          return result ? { result } : { refused: "noSuchShot" as const };
        });
        return outcome && { ...answer, ask: "shot", ...outcome };
      }
      case "reference": {
        const outcome = await this.served(connection, async (db, asking) => {
          const result = await recipeReference(db, asking, request.recipeId);
          return result ? { result } : { refused: "noSuchRecipe" as const };
        });
        return outcome && { ...answer, ask: "reference", ...outcome };
      }
      case "chooseReference": {
        const outcome = await this.chooseReference(connection, request.recipeId, request.shotId);
        return outcome && { ...answer, ask: "chooseReference", ...outcome };
      }
      case "editShot": {
        const { rating, note } = request;
        const outcome = await this.editShot(connection, request.shotId, { ...(rating !== undefined && { rating }), ...(note !== undefined && { note }) });
        return outcome && { ...answer, ask: "editShot", ...outcome };
      }
    }
  }

  /**
   * Sets the rating, the note or both of one of the Shots at the Location
   * the connection's Machine is served at, as a Skin on its tablet edited
   * it (ticket #515), and gives the Shot's rating and note as they then
   * are; or why the edit is refused, a Shot its list doesn't list as no
   * such Shot; or null as `answer` gives it. Whether the Machine is served
   * and where, and the edit, are of one transaction, which holds the
   * Machine's row as a choice of a Reference Shot does (`chooseReference`),
   * so an edit is made only by the connection holding a Machine that is
   * served at the Shot's Location as it commits. The Shot's lock is taken
   * before that row, as storing a Shot takes them, crediting it
   * (`ShotsService.store`), so the two never wait on each other.
   */
  private editShot(connection: AskingConnection, shotId: string, fields: ShotEditFields): Promise<{ result: SkinShotEdited } | { refused: SkinRefusal } | null> {
    return this.prisma.$transaction(async (tx) => {
      await lockShot(tx, shotId);
      if (!(await lockHeldMachine(tx, connection))) return null;
      const status = await this.status(tx, connection);
      if (status === null) return null;
      if (status.notServed !== undefined || status.location === null) return { refused: status.notServed ?? "captureOnly" };
      const result = await this.shotEdits.makeOnTablet(tx, shotId, fields, { locationId: status.location.id, machineId: connection.machineId, tabletId: connection.tabletId });
      return result ? { result } : { refused: "noSuchShot" };
    }, INTAKE_TRANSACTION);
  }

  /**
   * Makes the Shot the Reference Shot of one of the Recipes of the Location
   * the connection's Machine is served at, as its tablet chose it (ticket
   * #511), and gives the Recipe's reference as it then is, as `reference`
   * reads it; or why the choice is refused; or null as `answer` gives it.
   * Whether the Machine is served and where, the choice and the reference
   * read after it are of one transaction, which takes the locks every
   * change of a Recipe takes, so it reads each as committed then, where a
   * read's snapshot would fail the choice whenever another change came
   * first. It holds the Machine's row first, as a tablet's report does
   * (`lockHeldMachine`): a hello taking the Machine, a move and a sharing
   * switch each take that lock, so each waits for the choice or came before
   * it, and a choice is made only by the connection holding a Machine that
   * is served at the Recipe's Location as it commits.
   */
  private chooseReference(connection: AskingConnection, recipeId: string, shotId: string): Promise<{ result: SkinReference } | { refused: SkinRefusal } | null> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockHeldMachine(tx, connection))) return null;
      const status = await this.status(tx, connection);
      if (status === null) return null;
      if (status.notServed !== undefined || status.location === null) return { refused: status.notServed ?? "captureOnly" };
      const asking = { locationId: status.location.id, tabletId: connection.tabletId };
      const refused = await this.recipeEdits.chooseReferenceShotOnTablet(tx, recipeId, shotId, { ...asking, machineId: connection.machineId });
      if (refused) return { refused };
      const result = await recipeReference(tx, asking, recipeId);
      // The Recipe was found at this Location and is locked, and a Recipe never changes Location, so it is read. Were
      // it not, nothing is kept of the choice.
      if (!result) throw new Error("A Recipe whose Reference Shot was chosen is no longer its Location's");
      return { result };
    }, INTAKE_TRANSACTION);
  }

  /**
   * The Reference Shot copies the connection's tablet is due, given the
   * version it holds for each slot: those of the Location its Machine is
   * served at now, and nothing for every slot of a Machine that is not
   * served, as once it is made capture-only, read in one snapshot. Null
   * where the connection no longer holds its Machine.
   */
  referenceCopiesDue(connection: AskingConnection, held: ReadonlyMap<number, string>): Promise<DueCopy[] | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const status = await this.status(tx, connection);
        if (status === null) return null;
        const servedAt = status.notServed === undefined ? status.location : null;
        return referenceCopiesDue(tx, servedAt && { locationId: servedAt.id, tabletId: connection.tabletId }, held);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * What `read` gives of the Location the connection's Machine is served
   * at, for its tablet; or, for a Machine that is not served, why it is
   * refused; or null as `answer` gives it. Whether it is served, and what is
   * read, are of one snapshot, so a Machine moved meanwhile is answered as
   * of before or after, and never with one Location's Shots as another's.
   */
  private served<T>(connection: AskingConnection, read: (db: Prisma.TransactionClient, asking: AskingTablet) => Promise<T>): Promise<T | { refused: NotServed } | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const status = await this.status(tx, connection);
        if (status === null) return null;
        if (status.notServed !== undefined || status.location === null) return { refused: status.notServed ?? "captureOnly" };
        return read(tx, { locationId: status.location.id, tabletId: connection.tabletId });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Whether the connection's Machine is served, with its Machine and the
   * Location it is at now. A mismatched connection reports hardware that is
   * a Pending Machine's or another Machine's, so it is not its token's
   * Machine's own: it is told so, and named neither.
   */
  private async status(db: Prisma.TransactionClient, { sessionId, machineId, identity }: AskingConnection): Promise<SkinStatus | null> {
    const [machine] = await db.$queryRaw<{ name: string; sharing: boolean; locationId: string | null; locationName: string | null }[]>`
      SELECT machines.name, machines.sharing, locations.id AS "locationId", locations.name AS "locationName"
      FROM machines
      LEFT JOIN LATERAL (
        SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
      ) AS latest ON true
      LEFT JOIN locations ON locations.id = latest.location_id
      WHERE machines.id = ${machineId}::uuid AND machines.connected_session_id = ${sessionId}::uuid`;
    if (!machine) return null;
    if (identity.kind === "mismatch") return { served: false, notServed: "hardwareMismatch", machine: null, location: null };
    const location = machine.locationId === null || machine.locationName === null ? null : { id: machine.locationId, name: machine.locationName };
    const served = machine.sharing && location !== null;
    return { served, ...(served ? {} : { notServed: "captureOnly" as const }), machine: { id: machineId, name: machine.name }, location };
  }
}
