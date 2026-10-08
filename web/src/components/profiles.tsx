import { Badge } from "@/components/ui/badge";
import type { ProfileSummary } from "@/lib/api";

/** A Profile's title as lists show it. */
export function profileTitle(profile: Pick<ProfileSummary, "title">): string {
  return profile.title ?? "Untitled Profile";
}

/** Where a Profile is shown, by Location name. */
export function shownAtText(profile: ProfileSummary): string {
  if (profile.archived) return "Nowhere: Archived";
  return profile.shownAt.length === 0 ? "Nowhere" : profile.shownAt.map((here) => here.location.name).join(", ");
}

/** The address of a Profile's page: its id holds a colon, as Decaid's do. */
export function profilePath(id: string): string {
  return `/library/profiles/${encodeURIComponent(id)}`;
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
