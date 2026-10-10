import { experimental_upgradeWebSocket } from "@vercel/functions";
import type { WebSocketData } from "@vercel/functions";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { agentIdentity, currentUser, validOrigin } from "@/lib/security";
import {
  relayAttach,
  relayPublish,
  serverChannel,
  sessionChannel,
  terminalRelayAvailable,
} from "@/lib/terminal-relay";

export const runtime = "nodejs";
export const maxDuration = 300;

const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function payload(data: WebSocketData): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data.toString());
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function validData(data: unknown, maximum: number): data is string {
  return (
    typeof data === "string" &&
    data.length <= Math.ceil((maximum * 4) / 3) + 4 &&
    base64Pattern.test(data) &&
    Buffer.from(data, "base64").length > 0 &&
    Buffer.from(data, "base64").length <= maximum
  );
}

export async function GET(request: NextRequest) {
  if (!terminalRelayAvailable())
    return new Response("Terminal relay unavailable", { status: 503 });
  const params = request.nextUrl.searchParams;
  const role = params.get("role");

  if (role === "browser") {
    if (!(await validOrigin(request)))
      return new Response("Invalid origin", { status: 403 });
    const user = await currentUser();
    if (!user) return new Response("Sign in required", { status: 401 });
    const sessionId = params.get("sessionId") ?? "";
    if (!idPattern.test(sessionId))
      return new Response("Invalid session", { status: 400 });
    const session = await prisma.terminal_sessions.findFirst({
      where: {
        id: sessionId,
        user_id: user.id,
        status: { in: ["pending", "active"] },
        expires_at: { gt: new Date() },
      },
      select: {
        id: true,
        server_id: true,
        expires_at: true,
        cols: true,
        rows: true,
        shell_user: true,
      },
    });
    if (!session) return new Response("Session closed", { status: 404 });
    return experimental_upgradeWebSocket(
      (ws) => {
        const expiry = setTimeout(
          () => ws.close(1000, "Session expired"),
          Math.max(0, session.expires_at.getTime() - Date.now()),
        );
        ws.once("close", () => clearTimeout(expiry));
        ws.on("message", (raw: WebSocketData) => {
          const event = payload(raw);
          if (!event) return ws.close(1008);
          if (event.type === "input" && validData(event.data, 4096)) {
            void relayPublish(serverChannel(session.server_id), {
              type: "input",
              sessionId,
              data: event.data,
            }).catch(() => ws.close(1011));
          } else if (
            event.type === "resize" &&
            Number.isInteger(event.cols) &&
            Number.isInteger(event.rows) &&
            Number(event.cols) >= 20 &&
            Number(event.cols) <= 300 &&
            Number(event.rows) >= 5 &&
            Number(event.rows) <= 100
          ) {
            void relayPublish(serverChannel(session.server_id), {
              type: "resize",
              sessionId,
              cols: event.cols,
              rows: event.rows,
            }).catch(() => ws.close(1011));
          } else if (event.type === "close") {
            void relayPublish(serverChannel(session.server_id), {
              type: "close",
              sessionId,
            }).catch(() => {});
            ws.close(1000);
          } else if (
            event.type === "rtc-offer" &&
            typeof event.sdp === "string" &&
            event.sdp.length > 0 &&
            event.sdp.length <= 32000
          ) {
            void relayPublish(serverChannel(session.server_id), {
              type: "rtc-offer",
              sessionId,
              sdp: event.sdp,
            }).catch(() => ws.close(1011));
          } else if (
            event.type === "ping" &&
            Number.isSafeInteger(event.nonce) &&
            Math.abs(Date.now() - Number(event.nonce)) < 5000
          ) {
            void relayPublish(serverChannel(session.server_id), {
              type: "ping",
              sessionId,
              nonce: event.nonce,
            }).catch(() => ws.close(1011));
          } else ws.close(1008);
        });
        void (async () => {
          await relayAttach(sessionChannel(sessionId), ws);
          await relayPublish(serverChannel(session.server_id), {
            type: "open",
            sessionId,
            expiresAt: session.expires_at,
            cols: session.cols,
            rows: session.rows,
            shellUser: session.shell_user,
          });
          ws.send(
            JSON.stringify({ type: "ready", expiresAt: session.expires_at }),
          );
        })().catch(() => ws.close(1011));
      },
      { maxPayload: 65536 },
    );
  }

  if (role === "agent") {
    const agent = await agentIdentity(request);
    if (!agent || agent.pending)
      return new Response("Invalid agent credential", { status: 401 });
    const server = await prisma.servers.findUnique({
      where: { id: agent.server_id },
      select: { terminal_available: true },
    });
    if (!server?.terminal_available)
      return new Response("Terminal unavailable", { status: 403 });
    const sessions = await prisma.terminal_sessions.findMany({
      where: {
        server_id: agent.server_id,
        status: { in: ["pending", "active"] },
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: "asc" },
      take: 1,
      select: {
        id: true,
        expires_at: true,
        cols: true,
        rows: true,
        shell_user: true,
      },
    });
    return experimental_upgradeWebSocket(
      (ws) => {
        const allowed = new Set(sessions.map((session) => session.id));
        const pending = new Map<string, Promise<boolean>>();
        ws.on("message", (raw: WebSocketData) => {
          const event = payload(raw);
          if (
            !event ||
            typeof event.sessionId !== "string" ||
            !idPattern.test(event.sessionId)
          )
            return ws.close(1008);
          const sessionId = event.sessionId;
          if (event.type === "output" && validData(event.data, 8192)) {
            const data = event.data;
            void (async () => {
              if (!allowed.has(sessionId) && !(await pending.get(sessionId)))
                return ws.close(1008);
              await relayPublish(sessionChannel(sessionId), {
                type: "output",
                data,
              });
            })().catch(() => ws.close(1011));
          } else if (event.type === "started") {
            const check = (async () => {
              const session = await prisma.terminal_sessions.findFirst({
                where: {
                  id: sessionId,
                  server_id: agent.server_id,
                  status: { in: ["pending", "active"] },
                  expires_at: { gt: new Date() },
                },
                select: { id: true },
              });
              if (!session) return false;
              allowed.add(sessionId);
              await prisma.terminal_sessions.updateMany({
                where: { id: sessionId, status: "pending" },
                data: { status: "active" },
              });
              await relayPublish(sessionChannel(sessionId), {
                type: "started",
              });
              return true;
            })();
            pending.set(sessionId, check);
            void check
              .then((ok) => {
                if (!ok) ws.close(1008);
              })
              .catch(() => ws.close(1011));
          } else if (
            event.type === "pong" &&
            Number.isSafeInteger(event.nonce)
          ) {
            void (async () => {
              if (!allowed.has(sessionId) && !(await pending.get(sessionId)))
                return ws.close(1008);
              await relayPublish(sessionChannel(sessionId), {
                type: "pong",
                nonce: event.nonce,
              });
            })().catch(() => ws.close(1011));
          } else if (
            event.type === "rtc-answer" &&
            typeof event.sdp === "string" &&
            event.sdp.length > 0 &&
            event.sdp.length <= 32000
          ) {
            const sdp = event.sdp;
            void (async () => {
              if (!allowed.has(sessionId) && !(await pending.get(sessionId)))
                return ws.close(1008);
              await relayPublish(sessionChannel(sessionId), {
                type: "rtc-answer",
                sdp,
              });
            })().catch(() => ws.close(1011));
          } else if (event.type === "closed") {
            void (async () => {
              if (!allowed.has(sessionId) && !(await pending.get(sessionId)))
                return ws.close(1008);
              allowed.delete(sessionId);
              await prisma.terminal_sessions.updateMany({
                where: {
                  id: sessionId,
                  server_id: agent.server_id,
                  status: { not: "closed" },
                },
                data: { status: "closed", closed_at: new Date() },
              });
              await relayPublish(sessionChannel(sessionId), { type: "closed" });
            })().catch(() => ws.close(1011));
          } else ws.close(1008);
        });
        void (async () => {
          await relayAttach(serverChannel(agent.server_id), ws);
          ws.send(JSON.stringify({ type: "ready" }));
          for (const session of sessions)
            ws.send(
              JSON.stringify({
                type: "open",
                sessionId: session.id,
                expiresAt: session.expires_at,
                cols: session.cols,
                rows: session.rows,
                shellUser: session.shell_user,
              }),
            );
        })().catch(() => ws.close(1011));
      },
      { maxPayload: 65536 },
    );
  }

  return new Response("Invalid role", { status: 400 });
}
