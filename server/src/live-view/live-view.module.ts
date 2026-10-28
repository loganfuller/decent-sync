import { Module } from "@nestjs/common";
import { LiveViewController } from "./live-view.controller.js";
import { LiveViews } from "./live-views.js";

/** The Live View's streams, leases and relay (ADR-0024); the sync gateway hands it the connections that may stream, and their frames. */
@Module({
  controllers: [LiveViewController],
  providers: [LiveViews],
  exports: [LiveViews],
})
export class LiveViewModule {}
