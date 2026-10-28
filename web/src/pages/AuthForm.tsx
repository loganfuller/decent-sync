import { type FormEvent, type ReactNode, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface Field {
  name: string;
  label: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  minLength?: number;
  hint?: string;
  /** A value that cannot be changed, such as the email an invite is for. */
  fixedValue?: string;
}

/**
 * A centred card with one form: first-run setup, sign-in, accepting an
 * invite and choosing a new password. Shows the server's message when
 * submitting fails.
 */
export function AuthForm({
  title,
  description,
  fields,
  submitLabel,
  notice,
  onSubmit,
}: {
  title: string;
  description: ReactNode;
  fields: Field[];
  submitLabel: string;
  notice?: string;
  onSubmit(values: Record<string, string>): Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map((field) => [field.name, String(data.get(field.name) ?? "")]));
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(values);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit}>
            {notice && !error && (
              <Alert>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {fields.map((field) => (
              <div key={field.name} className="grid gap-2">
                <Label htmlFor={field.name}>{field.label}</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type={field.type}
                  autoComplete={field.autoComplete}
                  minLength={field.minLength}
                  aria-describedby={field.hint ? `${field.name}-hint` : undefined}
                  defaultValue={field.fixedValue}
                  readOnly={field.fixedValue !== undefined}
                  required
                />
                {field.hint && (
                  <p id={`${field.name}-hint`} className="text-sm text-muted-foreground">
                    {field.hint}
                  </p>
                )}
              </div>
            ))}
            <Button type="submit" disabled={submitting}>
              {submitLabel}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

/** A centred card with a message instead of a form, such as a one-time link that can no longer be used. */
export function AuthMessage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="grid gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}
