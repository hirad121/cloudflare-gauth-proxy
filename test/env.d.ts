// Augments the ambient `Cloudflare.Env` type that `cloudflare:test`'s
// exported `env` is typed against, so it matches our actual Worker bindings.
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
