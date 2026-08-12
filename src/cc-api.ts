import { request } from "node:http";
import { socketPath as defaultSocketPath } from "./paths.js";

export interface SendMarkdownOptions {
  project: string;
  sessionKey: string;
  markdown: string;
  socketPath?: string;
  timeoutMs?: number;
}

export async function sendMarkdownThroughCCConnect(
  options: SendMarkdownOptions,
): Promise<void> {
  const payload = JSON.stringify({
    project: options.project,
    session_key: options.sessionKey,
    message: options.markdown,
  });

  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        socketPath: options.socketPath ?? defaultSocketPath(),
        path: "/send",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: options.timeoutMs ?? 5_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode === 200) {
            resolve();
            return;
          }
          const body = Buffer.concat(chunks).toString("utf8").trim();
          reject(
            new Error(
              `CC Connect /send returned HTTP ${response.statusCode ?? "unknown"}${
                body ? `: ${body}` : ""
              }`,
            ),
          );
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("CC Connect /send timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
