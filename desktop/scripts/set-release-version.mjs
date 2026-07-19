import { readFile, writeFile } from "node:fs/promises";

const timeZone = "Asia/Shanghai";
const versionPattern = /^\d{4}\.\d{1,2}\.\d{1,2}-\d{6}$/;

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
  return `${value.year}.${Number(value.month)}.${Number(value.day)}-${value.hour}${value.minute}${value.second}`;
}

export function toStoreVersion(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{2})(\d{2})(\d{2})$/.exec(version);
  if (!match) {
    throw new Error(`无效的时间版本号：${version}`);
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}.${Number(month) * 100 + Number(day)}.${Number(hour) * 100 + Number(minute)}.${Number(second)}`;
}

const version = process.argv[2] ?? currentVersion();
if (!versionPattern.test(version)) {
  throw new Error("版本号必须采用 YYYY.M.D-HHmmss 格式");
}

const packagePath = new URL("../package.json", import.meta.url);
const tauriPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const cargoPath = new URL("../src-tauri/Cargo.toml", import.meta.url);
const cargoLockPath = new URL("../src-tauri/Cargo.lock", import.meta.url);

for (const filePath of [packagePath, tauriPath]) {
  const document = JSON.parse(await readFile(filePath, "utf8"));
  document.version = version;
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

const cargo = await readFile(cargoPath, "utf8");
const updatedCargo = cargo.replace(
  /(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/,
  `$1${version}$2`,
);
if (updatedCargo === cargo) {
  throw new Error("未能更新 Cargo.toml 中的应用版本");
}
await writeFile(cargoPath, updatedCargo);

const cargoLock = await readFile(cargoLockPath, "utf8");
const updatedCargoLock = cargoLock.replace(
  /(\[\[package\]\]\nname = "tietiezhi-desktop"\nversion = ")[^"]+("\n)/,
  `$1${version}$2`,
);
if (updatedCargoLock === cargoLock) {
  throw new Error("未能更新 Cargo.lock 中的应用版本");
}
await writeFile(cargoLockPath, updatedCargoLock);

console.log(`应用版本：${version}`);
console.log(`Git Tag：v${version}`);
console.log(`Microsoft Store 版本：${toStoreVersion(version)}`);
