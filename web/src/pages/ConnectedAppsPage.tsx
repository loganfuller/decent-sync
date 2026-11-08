import { useCallback, useEffect, useState } from "react";
import { ConnectedAppTable } from "@/components/connected-apps";
import { PageTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, type ConnectedApp } from "@/lib/api";

/**
 * The signed-in person's Connected Apps, reached from the account menu: the assistant apps they allowed to act as
 * them, each of which they disconnect here.
 */
export function ConnectedAppsPage() {
  const [apps, setApps] = useState<ConnectedApp[]>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setApps((await api<{ connectedApps: ConnectedApp[] }>("GET", "/connected-apps")).connectedApps);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Your Connected Apps could not be loaded");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function disconnect(app: ConnectedApp) {
    setActionError(undefined);
    try {
      await api("POST", `/connected-apps/${app.id}/disconnect`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong");
    }
    await reload();
  }

  return (
    <section className="grid gap-6">
      <PageTitleWithInfo title="Connected Apps">
        <p>
          Assistant apps, such as Claude or ChatGPT, that you allowed to read, or to read and change, what you can in Decent
          Sync, as you. Each approval is a Connected App of its own, so the same app on two devices is listed twice.
        </p>
        <p>
          Disconnecting one stops it at once. An app not used for 30 days stops working by itself, and leaves this list.
          When each was last used is recorded at most once an hour.
        </p>
      </PageTitleWithInfo>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {apps?.length === 0 && <p className="text-muted-foreground">No apps are connected to your account.</p>}
      {apps && apps.length > 0 && <ConnectedAppTable label="Connected Apps" apps={apps} onDisconnect={disconnect} />}
    </section>
  );
}
