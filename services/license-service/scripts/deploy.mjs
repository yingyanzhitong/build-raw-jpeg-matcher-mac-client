import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const token = process.env.EDGEONE_API_TOKEN;
if (!token) {
  throw new Error("请设置 EDGEONE_API_TOKEN。");
}

const deploymentDir = await mkdtemp(path.join(tmpdir(), "rjm-edgeone-deploy-"));
try {
  await Promise.all([
    cp(path.join(projectRoot, "cloud-functions"), path.join(deploymentDir, "cloud-functions"), {
      recursive: true,
    }),
    cp(path.join(projectRoot, "src"), path.join(deploymentDir, "src"), {
      recursive: true,
    }),
    cp(
      path.join(projectRoot, "package-lock.json"),
      path.join(deploymentDir, "package-lock.json"),
    ),
  ]);
  const sourcePackage = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(deploymentDir, "package.json"),
    `${JSON.stringify(
      {
        name: sourcePackage.name,
        version: sourcePackage.version,
        private: true,
        type: "module",
        dependencies: sourcePackage.dependencies,
      },
      null,
      2,
    )}\n`,
  );

  run(npmCommand(), ["ci", "--omit=dev", "--ignore-scripts"], {
    cwd: deploymentDir,
    stdio: "ignore",
  });
  run(
    edgeOneCommand(),
    [
      "makers",
      "deploy",
      deploymentDir,
      "--name",
      "raw-jpeg-matcher-license",
      "--token",
      token,
      "--env",
      "production",
      "--area",
      "overseas",
      "--json",
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
} finally {
  await rm(deploymentDir, { recursive: true, force: true });
}

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function edgeOneCommand() {
  return path.join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "edgeone.cmd" : "edgeone",
  );
}
