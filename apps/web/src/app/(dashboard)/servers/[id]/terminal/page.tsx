"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, post } from "@/components/api";
import { Button, Card, Input, SectionHead } from "@/components/ui";
import "@xterm/xterm/css/xterm.css";

type Session = { sessionId: string; expiresAt: string };
type Output = { id: string; data: string };
type Snapshot = { status: string; expiresAt: string; output: Output[] };
type ServerInfo = {
  id: string;
  name: string;
  ip: string | null;
  connected: boolean;
  terminal_available: boolean;
};

function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decode(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export default function ServerTerminalPage() {
  const params = useParams<{ id: string }>();
  const serverId = params.id;
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [loadingServer, setLoadingServer] = useState(true);
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{ servers: ServerInfo[] }>("servers")
      .then((result) =>
        setServer(result.servers.find((item) => item.id === serverId) ?? null),
      )
      .catch((cause) => setError((cause as Error).message))
      .finally(() => setLoadingServer(false));
  }, [serverId]);

  async function open(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const started = await post<Session>(`servers/${serverId}/terminal`, {
        password,
      });
      setPassword("");
      setSession(started);
      setStatus("Connecting to server…");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (!session) return;
    try {
      await post(`servers/${serverId}/terminal/${session.sessionId}/close`, {});
    } catch (cause) {
      setError((cause as Error).message);
    }
    setSession(null);
    setStatus("Session closed");
  }

  useEffect(() => {
    if (!session || !terminalRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let dispose: (() => void) | undefined;
    let cursor = 0;
    const sessionId = session.sessionId;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !terminalRef.current) return;
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        theme: {
          background: "#070d18",
          foreground: "#e2e8f0",
          cursor: "#34d399",
        },
        scrollback: 1000,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(terminalRef.current);
      const resize = terminal.onResize(({ cols, rows }) => {
        if (cols >= 20 && cols <= 300 && rows >= 5 && rows <= 100)
          void post(`servers/${serverId}/terminal/${sessionId}/resize`, {
            cols,
            rows,
          }).catch((cause) => setError((cause as Error).message));
      });
      fit.fit();
      terminal.focus();
      let inputQueue = Promise.resolve();
      const subscription = terminal.onData((data) => {
        inputQueue = inputQueue
          .then(async () => {
            if (!cancelled)
              await post(`servers/${serverId}/terminal/${sessionId}/input`, {
                data: encode(data),
              });
          })
          .catch((cause) => {
            if (!cancelled) setError((cause as Error).message);
          });
      });
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(terminalRef.current);
      dispose = () => {
        subscription.dispose();
        resize.dispose();
        observer.disconnect();
        terminal.dispose();
      };
      async function poll() {
        if (cancelled) return;
        try {
          const snapshot = await api<Snapshot>(
            `servers/${serverId}/terminal/${sessionId}?after=${cursor}`,
          );
          if (cancelled) return;
          for (const chunk of snapshot.output) {
            terminal.write(decode(chunk.data));
            cursor = Number(chunk.id);
          }
          if (snapshot.status === "closed") {
            setStatus("Session closed");
            setSession(null);
            return;
          }
          setStatus(
            snapshot.status === "active"
              ? `Root shell active · expires ${new Date(snapshot.expiresAt).toLocaleTimeString()}`
              : "Connecting to server…",
          );
        } catch (cause) {
          if (!cancelled) setError((cause as Error).message);
        }
        if (!cancelled) timer = setTimeout(() => void poll(), 500);
      }
      await poll();
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      dispose?.();
    };
  }, [serverId, session]);

  return (
    <>
      <SectionHead
        eyebrow="Infrastructure"
        title="Root terminal"
        description={`Run commands as root on ${server?.name ?? "this server"}${server?.ip ? ` (${server.ip})` : ""}. This session expires after 10 minutes.`}
      />
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-900/40 bg-red-950/30 p-3 text-sm text-red-300"
        >
          {error}
        </p>
      )}
      {!loadingServer && (!server?.connected || !server.terminal_available) ? (
        <Card className="max-w-lg p-6">
          <h2 className="font-semibold">Terminal unavailable</h2>
          <p className="mt-2 text-sm text-slate-400">
            The server must be online with the root terminal option enabled
            during agent setup. Return to Servers to check its status.
          </p>
        </Card>
      ) : !session ? (
        <Card className="max-w-lg p-6">
          <h2 className="font-semibold">Open a root shell</h2>
          <p className="mt-2 text-sm text-slate-400">
            Enter your Deplo password to start a new session. Commands run as
            root on the selected server.
          </p>
          <form onSubmit={open} className="mt-5 space-y-4">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Deplo password"
            />
            <Button type="submit" disabled={busy}>
              {busy ? "Opening…" : "Open root terminal"}
            </Button>
          </form>
          {status && <p className="mt-4 text-xs text-slate-400">{status}</p>}
        </Card>
      ) : (
        <Card className="p-3">
          <div className="mb-3 flex items-center justify-between gap-3 px-2 text-xs text-slate-400">
            <span role="status">{status}</span>
            <Button variant="secondary" onClick={() => void close()}>
              Close session
            </Button>
          </div>
          <div
            ref={terminalRef}
            className="h-[min(70vh,720px)] min-h-80 overflow-hidden rounded-lg bg-[#070d18] p-2"
          />
        </Card>
      )}
    </>
  );
}
