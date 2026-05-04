const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const sourceRenderer = path.join(projectRoot, "src", "renderer");
const outputRenderer = path.join(projectRoot, "dist", "renderer");

const staticEntries = ["index.html", "styles.css", "assets"];

fs.mkdirSync(outputRenderer, { recursive: true });

staticEntries.forEach((entry) => {
  const source = path.join(sourceRenderer, entry);
  const destination = path.join(outputRenderer, entry);

  fs.rmSync(destination, { force: true, recursive: true });
  fs.cpSync(source, destination, { recursive: true });
});
