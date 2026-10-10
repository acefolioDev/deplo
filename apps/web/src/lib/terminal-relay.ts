import Redis from "ioredis";
import type { WebSocket } from "ws";
import { decrypt, encrypt } from "./security";

const redisUrl = process.env.REDIS_URL;
const publisher = redisUrl
  ? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
    })
  : null;
const subscriber = redisUrl
  ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null })
  : null;
const listeners = new Map<string, Set<WebSocket>>();

publisher?.on("error", () => {});
subscriber?.on("error", () => {});

if (subscriber) {
  subscriber.on("message", (channel, sealed) => {
    const sockets = listeners.get(channel);
    if (!sockets) return;
    try {
      const message = decrypt(sealed);
      const type = (JSON.parse(message) as { type?: string }).type;
      for (const socket of sockets) {
        if (socket.readyState === 1 && socket.bufferedAmount < 1_000_000) {
          socket.send(message);
          if (type === "closed" || type === "revoke") socket.close(1000);
        } else if (socket.bufferedAmount >= 1_000_000) socket.close(1013);
      }
    } catch {
      // Reject malformed relay messages without exposing them to a terminal.
    }
  });
}

export function terminalRelayAvailable() {
  return Boolean(publisher && subscriber);
}

export const serverChannel = (id: string) => `deplo:terminal:server:${id}`;
export const sessionChannel = (id: string) => `deplo:terminal:session:${id}`;

export async function relayAttach(channel: string, socket: WebSocket) {
  if (!subscriber) throw new Error("Terminal relay unavailable");
  let sockets = listeners.get(channel);
  if (!sockets) {
    sockets = new Set<WebSocket>();
    listeners.set(channel, sockets);
    try {
      await subscriber.subscribe(channel);
    } catch (error) {
      listeners.delete(channel);
      throw error;
    }
  }
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
    if (!sockets.size) {
      listeners.delete(channel);
      void subscriber.unsubscribe(channel).catch(() => {});
    }
  });
}

export async function relayPublish(channel: string, event: object) {
  if (!publisher) throw new Error("Terminal relay unavailable");
  await publisher.publish(channel, encrypt(JSON.stringify(event)));
}
