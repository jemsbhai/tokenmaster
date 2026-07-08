// Removes dist/ before a rebuild so stale output never ships.
import { rmSync } from "node:fs";

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
