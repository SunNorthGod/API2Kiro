import * as http from "http";
import { info, debug } from "./log";

const RETRY_MS = 2500;
const IDENTITY_PATH = "/__api2kiro_identity";

export type OwnershipListener = (owned: boolean) => void;

/**
 * Probe a local port to see whether it is held by another API2Kiro proxy
 * instance (as opposed to a foreign process squatting the port).
 */
function probeIsOurs(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { method: "GET", host: "127.0.0.1", port, path: IDENTITY_PATH, timeout: 1500 },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json && json.proxy === "api2kiro");
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Owns a FIXED local port across multiple Kiro windows.
 *
 * Multi-instance model: every window points Kiro at the same 127.0.0.1:<port>.
 * The first window to bind the port becomes the OWNER and serves every window's
 * requests. Later windows detect the port is held by another API2Kiro instance
 * and go into STANDBY (no server of their own — their Kiro reaches the owner
 * through the shared Global endpoint config). Standby windows keep retrying, so
 * when the owner closes (or is killed) the OS frees the port and a standby
 * seamlessly takes over. No per-window port juggling, so nobody clobbers the
 * shared endpoint config.
 */
export class PortHolder {
  private server?: http.Server;
  private owned = false;
  private foreign = false;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private readonly port: number,
    private readonly label: string,
    private readonly createServer: () => http.Server,
    private readonly onChange?: OwnershipListener
  ) {}

  isOwner(): boolean {
    return this.owned;
  }

  /** True when the port is held by a NON-API2Kiro process (can't share). */
  hadForeignConflict(): boolean {
    return this.foreign;
  }

  getPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tryAcquire();
    if (!this.owned) {
      this.scheduleRetry();
    }
  }

  private tryAcquire(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.createServer();
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        try {
          server.close();
        } catch {
          /* ignore */
        }
        if (err.code === "EADDRINUSE") {
          probeIsOurs(this.port).then((ours) => {
            this.owned = false;
            this.foreign = !ours;
            debug(`${this.label} port ${this.port} busy (api2kiro=${ours})`);
            resolve();
          });
        } else {
          this.owned = false;
          this.foreign = false;
          info(`${this.label} bind error:`, err.message);
          resolve();
        }
      };
      server.once("error", onError);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        server.on("error", (e) => info(`${this.label} server error:`, (e as Error).message));
        this.server = server;
        this.owned = true;
        this.foreign = false;
        info(`${this.label} OWNER on 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.owned) {
      return;
    }
    this.retryTimer = setTimeout(async () => {
      if (this.stopped || this.owned) {
        return;
      }
      await this.tryAcquire();
      if (this.owned) {
        info(`${this.label} took over as OWNER`);
        this.onChange?.(true);
      } else {
        this.scheduleRetry();
      }
    }, RETRY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    this.owned = false;
  }
}
