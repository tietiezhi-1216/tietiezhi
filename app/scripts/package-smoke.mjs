import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const executable = resolve(process.argv[2] ?? "");
if (!existsSync(executable)) {
  throw new Error(`找不到待验证的应用可执行文件：${executable}`);
}

const dataDirectory = mkdtempSync(join(tmpdir(), "tietiezhi-package-smoke-"));
try {
  const result = spawnSync(executable, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      TIETIEZHI_DATA_DIR: dataDirectory,
      TIETIEZHI_HEADLESS: "1",
    },
    timeout: 30_000,
    windowsHide: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`打包应用退出码异常：${String(result.status)}`);
  }
  if (!result.stdout.includes("[host] ready:")) {
    throw new Error("打包应用未完成 Main 模块注册");
  }
} finally {
  rmSync(dataDirectory, { recursive: true, force: true });
}
