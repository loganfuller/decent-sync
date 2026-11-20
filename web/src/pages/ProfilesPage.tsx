import { useCallback } from "react";
import { Link } from "react-router";
import { useMayChange } from "@/auth";
import { LibraryNav } from "@/components/bean-batches";
import { DraftsCard } from "@/components/drafts";
import { PageTitleWithInfo } from "@/components/info-tip";
import { ProfileBadges, profilePath, profileTitle } from "@/components/profiles";
import { shownAtText } from "@/components/shown-locations";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type ProfileSummary } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/**
 * The Library's Profiles and the Locations showing each, with the Drafts
 * being written or changed here above them (#579), and New Profile, which
 * starts one. A Viewer sees no Drafts and starts none.
 */
export function ProfilesPage() {
  const mayChange = useMayChange();
  const load = useCallback(async () => (await api<{ profiles: ProfileSummary[] }>("GET", "/profiles")).profiles, []);
  const { data: profiles, error } = usePolled(load, DETAILS_POLL_MS);

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <PageTitleWithInfo title="Profiles">
          <p>
            The programs the machines follow, each shown or hidden at each Location. A Profile created on a tablet joins the
            Library shown at that tablet's Location only, and is written to every tablet there. Hiding, deleting or changing
            its steps on a tablet hides it at that tablet's Location only; new steps make a new Profile. A Profile is written
            here as a Draft, which is on no tablet until it is published.
          </p>
        </PageTitleWithInfo>
        <LibraryNav />
        {mayChange && (
          <div className="mt-2">
            <Button asChild>
              <Link to="/library/profiles/new">New Profile</Link>
            </Button>
          </div>
        )}
      </div>

      {mayChange && <DraftsCard />}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {profiles?.length === 0 && <p className="text-muted-foreground">No Profiles yet. They join the Library as tablets at a Location report them.</p>}
      {profiles && profiles.length > 0 && (
        <div className="min-w-0 rounded-lg border">
          <Table aria-label="Profiles">
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Shown at</TableHead>
                <TableHead>Created at</TableHead>
                <TableHead>Kind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <TableRow key={profile.id}>
                  <TableCell className="font-medium">
                    <Link to={profilePath(profile.id)} className="underline-offset-4 hover:underline">
                      {profileTitle(profile)}
                    </Link>
                  </TableCell>
                  <TableCell>{profile.author || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{shownAtText(profile)}</TableCell>
                  <TableCell>{profile.createdLocation?.name ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    <ProfileBadges profile={profile} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
