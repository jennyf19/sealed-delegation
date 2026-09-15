import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCorpus, writeJson } from "./qualification-lib.mjs";

const args = process.argv.slice(2);
let manifestArg = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--output") {
    index += 1;
  } else if (!args[index].startsWith("--")) {
    manifestArg = args[index];
    break;
  }
}
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : null;
const manifestPath = resolve(
  manifestArg ?? fileURLToPath(new URL("./corpus/manifest.json", import.meta.url)),
);
const receipt = validateCorpus(manifestPath);
if (outputPath) writeJson(outputPath, receipt);
console.log(JSON.stringify(receipt, null, args.includes("--compact") ? 0 : 2));
process.exitCode = receipt.valid ? 0 : 1;
