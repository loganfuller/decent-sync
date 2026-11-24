import { Injectable } from "@nestjs/common";
import type { CollectionName } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import { takesSoftwareActions } from "./software-actions.service.js";
import { type PluginSourceView, type SkinSourceView, type TabletSoftwareView, pluginSources, skinSources, tabletSoftwareView } from "./tablet-software.js";

const REPORTS = ["plugins", "pluginSettings", "skins", "skinPage", "decaidUpdate", "appSettings"] as const satisfies readonly CollectionName[];

/** A Machine's Tablet Software, from what its Tablet last reported (ADR-0034). */
@Injectable()
export class TabletSoftwareService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Decaid, the plugins and the Skins on the Machine's Tablet, each with how
   * it updates. Everyone who reads the Machine reads them; the values of the
   * plugins' settings go to Admins alone, as they may name an account on
   * another service.
   */
  async get(machineId: string, scope: Scope): Promise<TabletSoftwareView> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { decaidVersion: true, wireRevision: true } });
    if (!machine) throw machineNotFound();
    const rows = await this.prisma.reportedCollection.findMany({
      where: { machineId, name: { in: [...REPORTS] } },
      select: { name: true, available: true, reportedAt: true, value: true, receivedAt: true },
    });
    const report = (name: (typeof REPORTS)[number]) => rows.find((row) => row.name === name) ?? null;
    return tabletSoftwareView(
      { plugins: report("plugins"), pluginSettings: report("pluginSettings"), skins: report("skins"), skinPage: report("skinPage"), decaidUpdate: report("decaidUpdate"), appSettings: report("appSettings") },
      // A Machine that has not connected since the revision was kept is not said to need an update.
      { decaidVersion: machine.decaidVersion, pluginMustUpdate: machine.wireRevision !== null && !takesSoftwareActions(machine.wireRevision) },
      scope.kind === "everything",
    );
  }

  /**
   * The sources the plugins on the other Machines were installed from,
   * which the install form offers, most used first: an Admin's read, as
   * the form is.
   */
  async sources(machineId: string): Promise<PluginSourceView[]> {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const rows = await this.prisma.reportedCollection.findMany({
      where: { name: "plugins", machineId: { not: machineId }, receivedAt: { not: null } },
      select: { value: true },
    });
    return pluginSources(rows.map((row) => row.value));
  }

  /** The sources the Skins on the other Machines were installed from, which the Skin install form offers, most used first: an Admin's read. */
  async skinSources(machineId: string): Promise<SkinSourceView[]> {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const rows = await this.prisma.reportedCollection.findMany({
      where: { name: "skins", machineId: { not: machineId }, receivedAt: { not: null } },
      select: { value: true },
    });
    return skinSources(rows.map((row) => row.value));
  }
}
