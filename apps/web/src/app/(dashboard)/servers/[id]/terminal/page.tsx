"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, post } from "@/components/api";
import { Button, Card, Input, SectionHead } from "@/components/ui";
import "@xterm/xterm/css/xterm.css";

type Session = {
  sessionId: string;
  expiresAt: string;
  transport: "http" | "websocket";
  shellUser: string;
};
type Output = { id: string; data: string };
type Snapshot = { status: string; expiresAt: string; output: Output[] };
type ServerInfo = {
  id: string;
  name: string;
  ip: string | null;
  connected: boolean;
  terminal_available: boolean;
};

function encode(bytes: Uint8Array) {
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
  const [shellUser, setShellUser] = useState("root");
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
        shellUser,
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
    let socket: WebSocket | undefined;
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
        if (cols < 20 || cols > 300 || rows < 5 || rows > 100) return;
        if (session.transport === "websocket") {
          if (socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "resize", cols, rows }));
        } else
          void post(`servers/${serverId}/terminal/${sessionId}/resize`, {
            cols,
            rows,
          }).catch((cause) => setError((cause as Error).message));
      });
      fit.fit();
      terminal.focus();
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(terminalRef.current);

      if (session.transport === "websocket") {
        let retry = 250;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let pingTimer: ReturnType<typeof setInterval> | undefined;
        let directTimer: ReturnType<typeof setTimeout> | undefined;
        let peer: RTCPeerConnection | undefined;
        let channel: RTCDataChannel | undefined;
        let direct = false;
        let queued = "";
        let connected = false;
        const statusText = (rtt?: number) =>
          `${direct ? "Direct LAN shell" : "Root shell"} active${rtt === undefined ? "" : ` · ${rtt} ms round trip`} · expires ${new Date(session.expiresAt).toLocaleTimeString()}`;
        const ping = () => {
          if (direct && channel?.readyState === "open")
            channel.send(`ping:${Date.now()}`);
          else if (connected && socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "ping", nonce: Date.now() }));
        };
        const sendInput = (value: string) => {
          const bytes = new TextEncoder().encode(value);
          for (let offset = 0; offset < bytes.length; offset += 4096) {
            const chunk = bytes.subarray(offset, offset + 4096);
            if (direct && channel?.readyState === "open") channel.send(chunk);
            else
              socket?.send(
                JSON.stringify({ type: "input", data: encode(chunk) }),
              );
          }
        };
        const closeDirect = () => {
          clearTimeout(directTimer);
          direct = false;
          channel?.close();
          peer?.close();
          channel = undefined;
          peer = undefined;
        };
        const connectDirect = async () => {
          if (peer || typeof RTCPeerConnection === "undefined") return;
          const candidate = new RTCPeerConnection({ iceServers: [] });
          peer = candidate;
          const dataChannel = candidate.createDataChannel("terminal", {
            ordered: true,
          });
          channel = dataChannel;
          dataChannel.binaryType = "arraybuffer";
          dataChannel.onopen = () => {
            clearTimeout(directTimer);
            direct = true;
            setStatus(statusText());
            ping();
          };
          dataChannel.onclose = () => {
            direct = false;
            if (!cancelled) setStatus(statusText());
          };
          dataChannel.onmessage = (message) => {
            if (typeof message.data === "string") {
              if (message.data.startsWith("pong:")) {
                const nonce = Number(message.data.slice(5));
                if (Number.isSafeInteger(nonce))
                  setStatus(statusText(Date.now() - nonce));
              }
            } else if (message.data instanceof ArrayBuffer)
              terminal.write(new Uint8Array(message.data));
          };
          candidate.onconnectionstatechange = () => {
            if (candidate.connectionState === "failed") closeDirect();
          };
          const offer = await candidate.createOffer();
          await candidate.setLocalDescription(offer);
          if (candidate.iceGatheringState !== "complete") {
            const complete = await new Promise<boolean>((resolve) => {
              const timeout = setTimeout(() => {
                candidate.removeEventListener("icegatheringstatechange", done);
                resolve(false);
              }, 3000);
              const done = () => {
                if (candidate.iceGatheringState !== "complete") return;
                clearTimeout(timeout);
                candidate.removeEventListener("icegatheringstatechange", done);
                resolve(true);
              };
              candidate.addEventListener("icegatheringstatechange", done);
            });
            if (!complete) {
              closeDirect();
              return;
            }
          }
          if (
            peer === candidate &&
            socket?.readyState === WebSocket.OPEN &&
            candidate.localDescription
          )
            socket.send(
              JSON.stringify({
                type: "rtc-offer",
                sdp: candidate.localDescription.sdp,
              }),
            );
          directTimer = setTimeout(() => {
            if (!direct) closeDirect();
          }, 6000);
        };
        const subscription = terminal.onData((data) => {
          if (connected && socket?.readyState === WebSocket.OPEN)
            sendInput(data);
          else queued += data;
        });
        const connect = () => {
          if (cancelled || Date.now() >= new Date(session.expiresAt).getTime())
            return;
          const url = new URL("/api/terminal/ws", window.location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          url.searchParams.set("role", "browser");
          url.searchParams.set("sessionId", sessionId);
          socket = new WebSocket(url);
          socket.onmessage = (message) => {
            const event = JSON.parse(message.data as string) as {
              type: string;
              data?: string;
              sdp?: string;
              expiresAt?: string;
              nonce?: number;
            };
            if (event.type === "ready") {
              connected = true;
              retry = 250;
              setStatus("Connecting to server…");
              socket?.send(
                JSON.stringify({
                  type: "resize",
                  cols: terminal.cols,
                  rows: terminal.rows,
                }),
              );
              if (queued) {
                sendInput(queued);
                queued = "";
              }
            } else if (event.type === "started") {
              setStatus(statusText());
              ping();
              if (!pingTimer) pingTimer = setInterval(ping, 30_000);
              void connectDirect().catch(closeDirect);
            } else if (event.type === "rtc-answer" && event.sdp && peer) {
              void peer
                .setRemoteDescription({ type: "answer", sdp: event.sdp })
                .catch(closeDirect);
            } else if (event.type === "output" && event.data) {
              terminal.write(decode(event.data));
            } else if (event.type === "pong" && event.nonce) {
              const rtt = Date.now() - event.nonce;
              if (!direct) setStatus(statusText(rtt));
            } else if (event.type === "closed") {
              setStatus("Session closed");
              setSession(null);
            }
          };
          socket.onclose = () => {
            connected = false;
            closeDirect();
            clearInterval(pingTimer);
            pingTimer = undefined;
            if (cancelled) return;
            if (Date.now() >= new Date(session.expiresAt).getTime()) {
              setStatus("Session expired");
              setSession(null);
              return;
            }
            setStatus("Reconnecting to server…");
            reconnectTimer = setTimeout(connect, retry);
            retry = Math.min(retry * 2, 5000);
          };
          socket.onerror = () => socket?.close();
        };
        connect();
        dispose = () => {
          subscription.dispose();
          resize.dispose();
          observer.disconnect();
          clearTimeout(reconnectTimer);
          clearInterval(pingTimer);
          closeDirect();
          socket?.close();
          terminal.dispose();
        };
        return;
      }
      let pendingInput = "";
      let sendingInput = false;
      let inputTimer: ReturnType<typeof setTimeout> | undefined;
      async function sendInput() {
        if (sendingInput || cancelled) return;
        sendingInput = true;
        try {
          while (pendingInput && !cancelled) {
            const bytes = new TextEncoder().encode(pendingInput);
            pendingInput = "";
            for (let offset = 0; offset < bytes.length; offset += 4096) {
              await post(`servers/${serverId}/terminal/${sessionId}/input`, {
                data: encode(bytes.subarray(offset, offset + 4096)),
              });
            }
          }
        } catch (cause) {
          pendingInput = "";
          if (!cancelled) setError((cause as Error).message);
        } finally {
          sendingInput = false;
          if (pendingInput && !cancelled) void sendInput();
        }
      }
      const subscription = terminal.onData((data) => {
        pendingInput += data;
        if (!inputTimer)
          inputTimer = setTimeout(() => {
            inputTimer = undefined;
            void sendInput();
          }, 25);
      });
      dispose = () => {
        subscription.dispose();
        resize.dispose();
        observer.disconnect();
        clearTimeout(inputTimer);
        terminal.dispose();
      };
      async function poll() {
        if (cancelled) return;
        let retryDelay = 0;
        try {
          const snapshot = await api<Snapshot>(
            `servers/${serverId}/terminal/${sessionId}?after=${cursor}&wait=1`,
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
          retryDelay = 500;
        }
        if (!cancelled) timer = setTimeout(() => void poll(), retryDelay);
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
        description={`Run commands as root on ${server?.name ?? "this server"}${server?.ip ? ` (${server.ip})` : ""}. The shell starts in /root on that machine and expires after 10 minutes.`}
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
            root on the selected server. Run{" "}
            <code className="text-slate-200">pwd</code> to check your location,
            or <code className="text-slate-200">cd /home/your-username</code> to
            work in your normal Linux home folder.
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
            <label className="block text-sm text-slate-300">
              Run as Linux user
              <Input
                className="mt-2"
                value={shellUser}
                onChange={(event) => setShellUser(event.target.value)}
                placeholder="root or your Linux username"
                pattern="[a-z_][a-z0-9_-]{0,31}"
                required
              />
              <span className="mt-1 block text-xs text-slate-500">
                Use <code>root</code> for administration or your normal Mint
                username for user-owned files.
              </span>
            </label>
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
