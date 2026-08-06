/**
 * Minimal RFC6455 text-frame adapter that turns an HTTP upgrade socket into an
 * {@link EdgeGatewaySocket} without introducing a WebSocket dependency.
 * @pk
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { EdgeGatewaySocket } from "../../edge/gateway.js";

/** Complete the WebSocket handshake and return a text-frame gateway socket. @pk */
export function acceptEdgeGatewayWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): EdgeGatewaySocket {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    throw new Error("Missing Sec-WebSocket-Key");
  }
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + "\r\n",
  );

  const messageHandlers = new Set<(frame: string) => void>();
  const closeHandlers = new Set<() => void>();
  let closed = false;
  let buffer: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = consumeTextFrame(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      if (parsed.opcode === 0x8) {
        socket.end();
        emitClose();
        return;
      }
      if (parsed.opcode === 0x1) {
        for (const handler of messageHandlers) handler(parsed.payload.toString("utf8"));
      }
    }
  });
  socket.on("close", emitClose);
  socket.on("error", emitClose);

  return {
    get bufferedAmount() {
      return socket.writableLength;
    },
    send(frame: string) {
      if (closed) return;
      socket.write(encodeTextFrame(frame));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      const reasonBuffer = Buffer.from(reason.slice(0, 123), "utf8");
      const payload = Buffer.alloc(2 + reasonBuffer.length);
      payload.writeUInt16BE(code, 0);
      reasonBuffer.copy(payload, 2);
      socket.write(encodeFrame(0x8, payload));
      socket.end();
      emitClose();
    },
    onMessage(handler: (frame: string) => void) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onClose(handler: () => void) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
  };
}

function consumeTextFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    if (high !== 0 || low > 0xffffff) {
      throw new Error("WebSocket frame too large");
    }
    length = low;
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.alloc(length);
  buffer.copy(payload, 0, offset, offset + length);
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return {
    opcode,
    payload,
    rest: Buffer.from(buffer.subarray(offset + length)),
  };
}

function encodeTextFrame(payload: string): Buffer {
  return encodeFrame(0x1, Buffer.from(payload, "utf8"));
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Generate a random WebSocket key for tests. @pk */
export function randomWebSocketKey(): string {
  return randomBytes(16).toString("base64");
}
