import { chmod, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(projectRoot, ".scf-dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, "src/scf-server.ts")],
  outfile: path.join(outputDir, "server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});
await cp(
  path.join(projectRoot, "scf/scf_bootstrap"),
  path.join(outputDir, "scf_bootstrap"),
);
await chmod(path.join(outputDir, "scf_bootstrap"), 0o755);

console.log(`SCF 部署包已生成：${outputDir}`);
