import { useAuth } from "@/auth";
import { AuthForm } from "./AuthForm";

/** First-run setup: shown only while the server has no accounts. */
export function SetupPage({ passwordMinLength }: { passwordMinLength: number }) {
  const { setUp } = useAuth();

  return (
    <AuthForm
      title="Set up Decent Sync"
      description="Create the first Admin account. Admins can change everything on this server."
      submitLabel="Create Admin account"
      fields={[
        { name: "name", label: "Name", type: "text", autoComplete: "name" },
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        {
          name: "password",
          label: "Password",
          type: "password",
          autoComplete: "new-password",
          minLength: passwordMinLength,
          hint: `At least ${passwordMinLength} characters.`,
        },
      ]}
      onSubmit={({ name = "", email = "", password = "" }) => setUp({ name, email, password })}
    />
  );
}
