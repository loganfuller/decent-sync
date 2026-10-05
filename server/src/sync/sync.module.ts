import { Module } from "@nestjs/common";
import { MachinesModule } from "../machines/machines.module.js";
import { ShotsModule } from "../shots/shots.module.js";
import { SteamRecordsModule } from "../steam-records/steam-records.module.js";
import { SyncGateway } from "./sync.gateway.js";

/** The plugin's WebSocket endpoint. It authenticates with Machine tokens, not sessions. */
@Module({
  imports: [MachinesModule, ShotsModule, SteamRecordsModule],
  providers: [SyncGateway],
})
export class SyncModule {}
