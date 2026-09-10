/**
 * @file
 * Build the installer as a standalone executable, for every platform
 * a Community Cloud node or workstation is likely to be.
 *
 * The point of a single file is that getting started shouldn't require
 * having Bun, or Node, or a checkout. The manifests under k8s/ are
 * embedded in the binary for the same reason, as a SQLite database:
 * an installer that needs a repository next to it isn't really a
 * binary.
 *
 * Cross-compiling is Bun's own, so every target builds from whatever
 * machine this runs on.
 *
 *   bun run build            every target
 *   bun run build linux      just the ones matching "linux"
 */
import { $ } from "bun";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What gets compiled
const ENTRY_POINT = "src/cli/installer.ts";

// Where the executables go
const OUTPUT_DIRECTORY = "build";

/**
 * The platforms we publish for.
 *
 * arm64 Linux matters more than it might look: single board computers
 * and most of the cheaper hosted machines are arm64, and so are Apple
 * silicon VMs. The musl builds are for Alpine, which has no glibc.
 */
interface BuildTarget {
  name: string;
  target: string;
  output: string;
}

const TARGETS: BuildTarget[] = [
  { name: "linux-x64", target: "bun-linux-x64", output: "community-cloud-linux-x64" },
  { name: "linux-arm64", target: "bun-linux-arm64", output: "community-cloud-linux-arm64" },
  { name: "linux-x64-musl", target: "bun-linux-x64-musl", output: "community-cloud-linux-x64-musl" },
  { name: "linux-arm64-musl", target: "bun-linux-arm64-musl", output: "community-cloud-linux-arm64-musl" },
  { name: "macos-arm64", target: "bun-darwin-arm64", output: "community-cloud-macos-arm64" },
  { name: "macos-x64", target: "bun-darwin-x64", output: "community-cloud-macos-x64" },
  { name: "windows-x64", target: "bun-windows-x64", output: "community-cloud-windows-x64.exe" },
  { name: "windows-arm64", target: "bun-windows-arm64", output: "community-cloud-windows-arm64.exe" },
];

/**
 * The installer directory, wherever this was run from.
 *
 * @returns
 */
function getInstallerRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..");
}

/**
 * Build one target.
 *
 * @param root
 * @param target
 * @returns whether it worked
 */
async function build(root: string, target: BuildTarget): Promise<boolean> {
  const outfile = join(root, OUTPUT_DIRECTORY, target.output);

  process.stdout.write(`  ${target.name.padEnd(18)} `);

  // --minify and --bytecode trade build time for a smaller binary that
  // starts faster, which is the right way round for something people
  // download and run once in a while. --sourcemap keeps a real bug
  // traceable back to the source rather than to minified output.
  const result =
    await $`bun build --compile --minify --sourcemap --bytecode --target=${target.target} ${join(root, ENTRY_POINT)} --outfile ${outfile}`
      .cwd(root)
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    console.log("failed");
    console.log(result.stderr.toString().split("\n").map((line) => `      ${line}`).join("\n"));
    return false;
  }

  const { size } = await stat(outfile);
  console.log(`${(size / 1024 / 1024).toFixed(1)} MB  ${join(OUTPUT_DIRECTORY, target.output)}`);
  return true;
}

/**
 * Build everything asked for.
 */
async function main() {
  const root = getInstallerRoot();
  const filter = process.argv[2];

  const wanted = filter !== undefined
    ? TARGETS.filter((target) => target.name.includes(filter))
    : TARGETS;

  if (wanted.length === 0) {
    console.log(`Nothing matches "${filter}". Targets: ${TARGETS.map((target) => target.name).join(", ")}`);
    process.exit(1);
  }

  await mkdir(join(root, OUTPUT_DIRECTORY), { recursive: true });

  // Regenerated every time, so a manifest added to k8s/ can't be left
  // out of a release because someone forgot this step
  console.log("\nBuilding the embedded manifest database");
  const embedded = await $`bun ${join(root, "scripts", "generateEmbedded.ts")}`.cwd(root).nothrow();
  if (embedded.exitCode !== 0) {
    console.log(embedded.stderr.toString());
    process.exit(1);
  }

  console.log(`\nBuilding ${wanted.length} target${wanted.length === 1 ? "" : "s"}\n`);

  const failed: string[] = [];
  for (const target of wanted) {
    if (!(await build(root, target))) {
      failed.push(target.name);
    }
  }

  if (failed.length > 0) {
    console.log(`\n⛔ Failed: ${failed.join(", ")}\n`);
    process.exit(1);
  }

  console.log(`\n✅ ${wanted.length} executable${wanted.length === 1 ? "" : "s"} in ${OUTPUT_DIRECTORY}/\n`);
}

await main();
