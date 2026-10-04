import { useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function CopyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"copied" | "failed">();

  async function copy() {
    setStatus((await copyText(value, input.current)) ? "copied" : "failed");
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          ref={input}
          value={value}
          readOnly
          spellCheck={false}
          className="font-mono"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="button" variant="outline" aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}>
          {status === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {status === "copied" && `${label} copied.`}
        {status === "failed" && "Copying failed: select the text and copy it yourself."}
      </p>
    </div>
  );
}

/**
 * Copies text to the clipboard. Browsers offer the Clipboard API only to
 * secure origins, so a server on a LAN address over http:// copies the
 * selected field instead.
 */
async function copyText(text: string, field: HTMLInputElement | null): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused, for example by a permission policy: fall back to the selection.
    }
  }
  if (!field) return false;
  field.focus();
  field.select();
  return document.execCommand("copy");
}
