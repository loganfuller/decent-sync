import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { type ProfileSummary, type ProfileView, ProfilesService, readProfileId } from "./profiles.service.js";

/** The Library's Profiles, and the Locations showing each. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/profiles")
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  async list(): Promise<{ profiles: ProfileSummary[] }> {
    return { profiles: await this.profiles.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ profile: ProfileView }> {
    return { profile: await this.profiles.get(readProfileId(id)) };
  }
}
