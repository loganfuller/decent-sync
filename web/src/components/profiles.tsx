import { ShownLocationsCard } from "@/components/shown-locations";
import { Badge } from "@/components/ui/badge";
import type { Profile, ProfileSummary } from "@/lib/api";

/** A Profile's title as lists show it. */
export function profileTitle(profile: Pick<ProfileSummary, "title">): string {
  return profile.title ?? "Untitled Profile";
}

/**
 * The address of a Profile's page (ADR-0038): at the Profile's own id, which
 * stays as it gains versions, or at Decaid's id of one of its versions,
 * which holds a colon and opens the Profile at that version.
 */
export function profilePath(id: string): string {
  return `/library/profiles/${encodeURIComponent(id)}`;
}

/** The address of the page of the Profile a row lists: its own id, or its version's where the server has given it none yet. */
export function profilePagePath(profile: Pick<ProfileSummary, "id" | "profileId">): string {
  return profilePath(profile.profileId ?? profile.id);
}

/** What sets a Profile apart: one of Decaid's bundled Profiles, or Archived. */
export function ProfileBadges({ profile }: { profile: ProfileSummary }) {
  return (
    <div className="flex flex-wrap gap-1">
      {profile.bundled && <Badge variant="outline">Bundled with Decaid</Badge>}
      {profile.archived && <Badge variant="secondary">Archived</Badge>}
    </div>
  );
}

/**
 * Whether each Location shows a Profile, changed there by an Admin or Staff
 * working there: hiding one hides it on that Location's tablets, never
 * deleting it.
 */
export function ProfileLocationsCard({ profile, onChanged }: { profile: Profile; onChanged(): Promise<void> | void }) {
  return (
    <ShownLocationsCard
      item={profile}
      path={`/profiles/${encodeURIComponent(profile.id)}`}
      description="Where it is shown. Showing it at a Location writes it to that Location's tablets, visible; hiding it there hides it on them, never deleting it, and changes no other Location."
      archivedNote="It is Archived, so it is shown nowhere and hidden on every tablet. Restoring it shows it again where it is shown below."
      onChanged={onChanged}
    />
  );
}
