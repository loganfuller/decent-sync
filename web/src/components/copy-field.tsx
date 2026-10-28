import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** A secret or address shown read-only, with a button that copies it, such as a Machine token or an invite link. */
export function CopyField({ label, value }: { label: string; value: string }) {
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
