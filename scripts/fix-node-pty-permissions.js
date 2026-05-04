const fs = require("fs");
const path = require("path");

const candidatePaths = [
  path.join(
    __dirname,
    "..",
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper"
  ),
  path.join(
    __dirname,
    "..",
    "node_modules",
    "node-pty",
    "build",
    "Release",
    "spawn-helper"
  )
];

candidatePaths.forEach((helperPath) => {
  if (!fs.existsSync(helperPath)) return;
  fs.chmodSync(helperPath, 0o755);
});
