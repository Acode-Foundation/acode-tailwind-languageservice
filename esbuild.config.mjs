import * as esbuild from "esbuild";
import { execFile } from "node:child_process";

const isServe = process.argv.includes("--serve");

// Function to pack the ZIP file
function packZip() {
  execFile(process.execPath, ["./pack-zip.js"], (err, stdout) => {
    if (err) {
      console.error("Error packing zip:", err);
      return;
    }
    console.log(stdout.trim());
  });
}

// Custom plugin to pack ZIP after build or rebuild
const zipPlugin = {
  name: "zip-plugin",
  setup(build) {
    build.onEnd(() => {
      packZip();
    });
  },
};

// Base build configuration
const buildConfig = {
  entryPoints: {
    main: "src/main.ts",
    "tailwind.worker": "src/worker/server.ts",
  },
  bundle: true,
  minify: true,
  platform: "browser",
  target: ["chrome90"],
  format: "iife",
  define: {
    __dirname: '"/"',
  },
  logLevel: "info",
  color: true,
  outdir: "dist",
  alias: {
    fs: "./src/shims/fs.ts",
    os: "os-browserify/browser",
    path: "path-browserify",
    util: "util",
  },
  inject: ["./src/shims/process.ts"],
  loader: {
    ".css": "text",
  },
  plugins: [zipPlugin],
};

// Main function to handle both serve and production builds
(async function () {
  if (isServe) {
    console.log("Starting development server...");

    // Watch and Serve Mode
    const ctx = await esbuild.context(buildConfig);

    await ctx.watch();
    const { host, port } = await ctx.serve({
      servedir: ".",
      port: 3000,
    });
    console.log(`Development server: http://${host}:${port}`);

  } else {
    console.log("Building for production...");
    await esbuild.build(buildConfig);
    console.log("Production build complete.");
  }
})();
