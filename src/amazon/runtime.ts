import { randomBytes } from "node:crypto";

import type { Clock, IdGenerator } from "./types.ts";

export const systemClock: Clock = {
  now: () => new Date(),
};

export const cryptoIdGenerator: IdGenerator = {
  randomId(prefix: string): string {
    return `${prefix}_${randomBytes(24).toString("base64url")}`;
  },
};
