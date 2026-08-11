import { connect } from "cloudflare:sockets";
import type { SmtpConfigInput } from "@/shared/contracts";

const SMTP_TIMEOUT_MS = 15_000;

export interface SmtpMessage {
  subject: string;
  text: string;
}

export async function sendSmtp(config: SmtpConfigInput, password: string, message: SmtpMessage): Promise<void> {
  validateSmtpConfig(config);
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.tlsMode === "implicit" ? "on" : "starttls", allowHalfOpen: false },
  );
  let session = new SmtpSession(socket);
  await session.expect([220]);
  await session.command(`EHLO cf-activity-observatory`, [250]);
  if (config.tlsMode === "starttls") {
    await session.command("STARTTLS", [220]);
    session = await session.upgradeTls();
    await session.command("EHLO cf-activity-observatory", [250]);
  }
  await authenticate(session, config.authMethod, config.username, password);
  await session.command(`MAIL FROM:<${config.senderAddress}>`, [250]);
  for (const recipient of config.recipients) await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
  await session.command("DATA", [354]);
  await session.write(`${mimeMessage(config, message)}\r\n.\r\n`);
  await session.expect([250]);
  await session.command("QUIT", [221]);
  await session.close();
}

export function dotStuff(value: string): string {
  return normalizeCrlf(value)
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export function mimeMessage(config: SmtpConfigInput, message: SmtpMessage): string {
  const senderName = encodeHeader(config.senderName || "CF Activity Observatory");
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${senderName} <${config.senderAddress}>`,
    `To: ${config.recipients.join(", ")}`,
    `Subject: ${encodeHeader(`${config.subjectPrefix} ${message.subject}`.trim())}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = btoa(unescape(encodeURIComponent(normalizeCrlf(message.text)))).replace(/.{1,76}/gu, "$&\r\n").trimEnd();
  return dotStuff(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

class SmtpSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";

  constructor(private socket: Socket) {
    this.reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
    this.writer = (socket.writable as WritableStream<Uint8Array>).getWriter();
  }

  async command(command: string, expected: number[]): Promise<string[]> {
    await this.write(`${command}\r\n`);
    return this.expect(expected);
  }

  async write(value: string): Promise<void> {
    await withTimeout(this.writer.write(new TextEncoder().encode(value)), "SMTP 写入超时");
  }

  async expect(expected: number[]): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const match = /^(\d{3})([ -])/u.exec(line);
      if (!match) continue;
      const code = Number(match[1]);
      if (!expected.includes(code)) throw new Error(`SMTP 服务端返回 ${code}：${line.slice(4, 240)}`);
      if (match[2] === " ") return lines;
    }
  }

  upgradeTls(): Promise<SmtpSession> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    const secured = this.socket.startTls();
    return Promise.resolve(new SmtpSession(secured));
  }

  async close(): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.socket.close();
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\r\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 2);
        return line;
      }
      const result = await withTimeout(this.reader.read(), "SMTP 响应超时");
      if (result.done) throw new Error("SMTP 服务端提前关闭连接");
      this.buffer += new TextDecoder().decode(result.value, { stream: true });
    }
  }
}

async function authenticate(session: SmtpSession, method: "plain" | "login", username: string, password: string): Promise<void> {
  if (method === "plain") {
    await session.command(`AUTH PLAIN ${btoa(`\0${username}\0${password}`)}`, [235]);
    return;
  }
  await session.command("AUTH LOGIN", [334]);
  await session.command(btoa(username), [334]);
  await session.command(btoa(password), [235]);
}

function validateSmtpConfig(config: SmtpConfigInput): void {
  if (config.port === 465 && config.tlsMode !== "implicit") throw new Error("465 端口必须使用隐式 TLS");
  if (config.port === 587 && config.tlsMode !== "starttls") throw new Error("587 端口必须使用 STARTTLS");
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/u.test(value) ? value.replaceAll("\r", "").replaceAll("\n", "") : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r?\n/gu, "\r\n").replace(/[\r\n]+$/u, "");
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), SMTP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
