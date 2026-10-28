import { Module } from "@nestjs/common";
import { SteamRecordsController } from "./steam-records.controller.js";
import { SteamRecordsService } from "./steam-records.service.js";

@Module({ controllers: [SteamRecordsController], providers: [SteamRecordsService], exports: [SteamRecordsService] })
export class SteamRecordsModule {}
