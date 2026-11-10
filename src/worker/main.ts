/** Entry point of the bundle that lives on a worker machine. */
import { runCli } from "./cli.ts";
import { serveWorker } from "./server.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "serve") {
  await serveWorker();
} else {
  process.exitCode = await runCli(command, args);
}
