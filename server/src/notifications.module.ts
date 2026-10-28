import { Global, Module } from "@nestjs/common";
import { Notifications } from "./notifications.js";

/** Each instance's one connection listening for the changes other instances make (ADR-0016). */
@Global()
@Module({ providers: [Notifications], exports: [Notifications] })
export class NotificationsModule {}
