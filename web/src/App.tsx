import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ServerStatus = "checking" | "connected" | "unreachable";

// A placeholder until the milestone 1 screens arrive. It checks that the
// server answering this page can also reach its database.
export function App() {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((response) => setStatus(response.ok ? "connected" : "unreachable"))
      .catch(() => setStatus("unreachable"));
  }, []);

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Decent Sync</h1>
          </CardTitle>
          <CardDescription>The management interface is on its way.</CardDescription>
        </CardHeader>
        <CardContent>
          <p role="status">
            {status === "checking" && "Checking the server..."}
            {status === "connected" && "Server connected"}
            {status === "unreachable" && "Server unreachable"}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
