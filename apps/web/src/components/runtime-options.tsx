"use client";
import { useState } from "react";
import { patch } from "./api";
import { Button, Card, Input } from "./ui";
export type RuntimeEnv = {
  id: string;
  volumePath?: string | null;
  registryUsername?: string | null;
  hasRegistryToken?: boolean;
};
export function RuntimeOptions({
  environment,
  onSaved,
}: {
  environment: RuntimeEnv;
  onSaved: () => Promise<void>;
}) {
  const [volumePath, setVolumePath] = useState(environment.volumePath ?? "");
  const [registryUsername, setRegistryUsername] = useState(
    environment.registryUsername ?? "",
  );
  const [registryToken, setRegistryToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await patch(`environments/${environment.id}`, {
        volumePath: volumePath || null,
        registryUsername: registryUsername || null,
        ...(registryToken ? { registryToken } : {}),
      });
      setRegistryToken("");
      setMessage("Runtime options saved. Deploy again to apply them.");
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-6">
      <h3 className="font-semibold">Runtime options</h3>
      <p className="mt-1 text-xs text-slate-500">
        Persistent data uses a dedicated Docker named volume. Private GHCR
        credentials are encrypted at rest.
      </p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <label className="text-xs text-slate-400">
          Container volume path
          <Input
            className="mt-2"
            placeholder="/app/data"
            value={volumePath}
            onChange={(e) => setVolumePath(e.target.value)}
          />
        </label>
        <label className="text-xs text-slate-400">
          GHCR username
          <Input
            className="mt-2"
            placeholder="github-user"
            value={registryUsername}
            onChange={(e) => setRegistryUsername(e.target.value)}
          />
        </label>
        <label className="text-xs text-slate-400">
          GHCR token{" "}
          {environment.hasRegistryToken && (
            <span className="text-emerald-300">(stored)</span>
          )}
          <Input
            className="mt-2"
            type="password"
            placeholder={
              environment.hasRegistryToken
                ? "Leave blank to keep current token"
                : "Fine-scoped token"
            }
            value={registryToken}
            onChange={(e) => setRegistryToken(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="secondary" disabled={busy} onClick={() => void save()}>
          Save runtime options
        </Button>
        {message && (
          <span role="status" className="text-xs text-emerald-300">
            {message}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-red-300">
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}
