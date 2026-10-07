import { Module } from "@nestjs/common";
import { CollectionsModule } from "../collections/collections.module.js";
import { MachineEventsModule } from "../machine-events/machine-events.module.js";
import { MachinesModule } from "../machines/machines.module.js";
import { SetAsideDeliveriesModule } from "../set-aside-deliveries/set-aside-deliveries.module.js";
import { ShotsModule } from "../shots/shots.module.js";
import { SteamRecordsModule } from "../steam-records/steam-records.module.js";
import { SyncGateway } from "./sync.gateway.js";

/** The plugin's WebSocket endpoint. It authenticates with Machine tokens, not sessions. */
@Module({
  imports: [MachinesModule, ShotsModule, SteamRecordsModule, MachineEventsModule, CollectionsModule, SetAsideDeliveriesModule],
  providers: [SyncGateway],
})
export class SyncModule {}
