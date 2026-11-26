import { rmSync } from "node:fs";

for (const dir of ["packages/core/dist", "apps/server/dist", "apps/desktop/dist"]) {
    rmSync(dir, { recursive: true, force: true });
}
