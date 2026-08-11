import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");

if (packageJson.license !== "AGPL-3.0-only") throw new Error("package.json 必须声明 AGPL-3.0-only");
if (!license.includes("GNU AFFERO GENERAL PUBLIC LICENSE") || !license.includes("Version 3, 19 November 2007")) {
  throw new Error("LICENSE 不是完整的 AGPL-3.0 正文");
}
