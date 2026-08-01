import { readFile, writeFile } from "node:fs/promises";

// Restores the pre-0.4.x date-based release scheme (YYYY.M.D-tHHmmss,
// Asia/Shanghai), carried over from the Tauri-era desktop/scripts version.
const timeZone = "Asia/Shanghai";
const versionPattern = /^\d{4}\.\d{1,2}\.\d{1,2}-t\d{6}$/;

function currentVersion() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  // The `t` keeps an HHmmss value beginning with 0 SemVer-compatible:
  // numeric prerelease identifiers may not contain leading zeroes.
  return `${value.year}.${Number(value.month)}.${Number(value.day)}-t${value.hour}${value.minute}${value.second}`;
}

const version = process.argv[2] ?? currentVersion();
if (!versionPattern.test(version)) {
  throw new Error("版本号必须采用 YYYY.M.D-tHHmmss 格式");
}

const packagePath = new URL("../package.json", import.meta.url);
const document = JSON.parse(await readFile(packagePath, "utf8"));
document.version = version;
await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);

console.log(`应用版本：${version}`);
console.log(`Git Tag：v${version}`);
