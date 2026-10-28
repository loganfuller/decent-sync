import { useId } from "react";
import { CopyField } from "@/components/copy-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { IssuedToken } from "@/lib/api";

/**
 * A Machine's new token and the server URL to enter beside it in the
 * plugin's settings. The server returns a token only once, so this is the
 * only time it is shown.
 */
export function TokenNotice({ issued, onDone }: { issued: IssuedToken; onDone(): void }) {
  const titleId = useId();

  return (
    <Card role="region" aria-labelledby={titleId} className="max-w-2xl border-primary">
      <CardHeader>
        <CardTitle>
          <h2 id={titleId}>Token for {issued.machine.name}</h2>
        </CardTitle>
        <CardDescription>
          On the Machine's tablet, enter the server URL and this token in the Decent Sync plugin's settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert>
          <AlertTitle>Copy the token now</AlertTitle>
          <AlertDescription>
            It will not be shown again. If it is lost, issue a new token from the Machine's page.
          </AlertDescription>
        </Alert>
        <CopyField label="Server URL" value={issued.serverUrl} />
        <CopyField label="Token" value={issued.token} />
      </CardContent>
      <CardFooter>
        <Button onClick={onDone}>Done</Button>
      </CardFooter>
    </Card>
  );
}
