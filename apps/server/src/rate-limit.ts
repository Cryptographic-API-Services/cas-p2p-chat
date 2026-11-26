import type { NextFunction, Request, Response } from "express";

interface Bucket {
    tokens: number;
    updated: number;
}

/** A per-IP token bucket: `burst` requests at once, refilled at `refillPerSecond`. */
export function rateLimit({ burst, refillPerSecond }: { burst: number; refillPerSecond: number }) {
    const buckets = new Map<string, Bucket>();

    // Full buckets carry no state worth keeping, so drop them now and then.
    setInterval(() => {
        const now = Date.now();
        for (const [ip, bucket] of buckets) {
            if (bucket.tokens + ((now - bucket.updated) / 1000) * refillPerSecond >= burst) {
                buckets.delete(ip);
            }
        }
    }, 60_000).unref();

    return (req: Request, res: Response, next: NextFunction): void => {
        const ip = req.ip ?? "unknown";
        const now = Date.now();
        const bucket = buckets.get(ip) ?? { tokens: burst, updated: now };
        bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updated) / 1000) * refillPerSecond);
        bucket.updated = now;
        buckets.set(ip, bucket);
        if (bucket.tokens < 1) {
            res.set("Retry-After", String(Math.ceil((1 - bucket.tokens) / refillPerSecond)));
            res.status(429).json({ error: "too many requests" });
            return;
        }
        bucket.tokens -= 1;
        next();
    };
}
