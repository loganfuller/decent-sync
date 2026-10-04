import { useLocation } from "react-router";
import { useAuth } from "@/auth";
import { AuthForm } from "./AuthForm";

export interface SignInState {
  notice?: string;
}

export function SignInPage() {
  const { signIn } = useAuth();
  const notice = (useLocation().state as SignInState | null)?.notice;

  return (
    <AuthForm
      title="Sign in to Decent Sync"
      description="Use the email and password of your account."
      submitLabel="Sign in"
      notice={notice}
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "username" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]}
      onSubmit={({ email = "", password = "" }) => signIn({ email, password })}
    />
  );
}
