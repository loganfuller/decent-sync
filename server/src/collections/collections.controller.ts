import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { type CollectionSummary, type CollectionView, CollectionsService } from "./collections.service.js";
import type { PairedDevicesView } from "./paired-devices.js";

/** Each Machine's library, settings and paired devices, as its tablet last reported them. Staff read them too. */
@AllowStaff()
@Controller("api/machines")
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  /** The collections the Machine's tablet has reported, without their values. */
  @Get(":id/collections")
  async list(@Param("id") id: string): Promise<{ collections: CollectionSummary[] }> {
    return { collections: await this.collections.list(readMachineId(id)) };
  }

  /** One collection with its latest value, or null until the Machine's tablet reports it. */
  @Get(":id/collections/:name")
  async get(@Param("id") id: string, @Param("name") name: string): Promise<{ collection: CollectionView | null }> {
    return { collection: await this.collections.get(readMachineId(id), name) };
  }

  /** The Machine's paired scale, auxiliary scale and sensors, with their model, firmware and battery level. */
  @Get(":id/paired-devices")
  async pairedDevices(@Param("id") id: string): Promise<{ pairedDevices: PairedDevicesView }> {
    return { pairedDevices: await this.collections.pairedDevices(readMachineId(id)) };
  }
}
