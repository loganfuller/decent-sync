import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { readMachineId } from "../machines/input.js";
import { type CollectionSummary, type CollectionView, CollectionsService } from "./collections.service.js";
import type { PairedDevicesView } from "./paired-devices.js";

/**
 * Each Machine's library, settings and paired devices, as its tablet last
 * reported them. Staff see those of the Machines at their Locations.
 */
@AllowStaff()
@Controller("api/machines")
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  /** The collections the Machine's tablet has reported, without their values. */
  @Get(":id/collections")
  async list(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ collections: CollectionSummary[] }> {
    return { collections: await this.collections.list(readMachineId(id), scope) };
  }

  /** One collection with its latest value, or null until the Machine's tablet reports it. */
  @Get(":id/collections/:name")
  async get(@Param("id") id: string, @Param("name") name: string, @CurrentScope() scope: Scope): Promise<{ collection: CollectionView | null }> {
    return { collection: await this.collections.get(readMachineId(id), name, scope) };
  }

  /** The Machine's paired scale, auxiliary scale and sensors, with their model, firmware and battery level. */
  @Get(":id/paired-devices")
  async pairedDevices(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ pairedDevices: PairedDevicesView }> {
    return { pairedDevices: await this.collections.pairedDevices(readMachineId(id), scope) };
  }
}
