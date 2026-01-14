import { PassThrough } from "node:stream";

import type { AppLoadContext, EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  statusCode: number,
  headers: Headers,
  context: EntryContext,
  loadContext: AppLoadContext
) {
  void loadContext;
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: statusCode,
      headers
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || context.isSpaMode ? "onAllReady" : "onShellReady";

    const timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort(), streamTimeout + 1000);

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={context} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback: (error?: Error | null) => void) {
              clearTimeout(timeoutId);
              callback();
            }
          });
          const stream = createReadableStreamFromReadable(body);

          headers.set("Content-Type", "text/html");
          pipe(body);

          resolve(
            new Response(stream, {
              headers,
              status: statusCode
            })
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          statusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        }
      }
    );
  });
}
