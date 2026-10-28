import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { SetAsideDeliveriesService } from "./set-aside-deliveries.service.js";

/** The deliveries from a Machine's tablet that could not be stored, as its page shows them. Staff read them too. */
@AllowStaff()
@Controller("api/machines")
export class SetAsideDeliveriesController {
  constructor(private readonly setAside: SetAsideDeliveriesService) {}

  /** The deliveries set aside for the Machine, latest first, each without its message. */
  @Get(":id/set-aside-deliveries")
  list(@Param("id") id: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const machineId = readMachineId(id);
    return this.setAside.list(machineId, readPage(limit, offset));
  }
}
