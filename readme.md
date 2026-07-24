# Tailwind CSS IntelliSense for Acode

A Tailwind CSS language service for Acode. The plugin runs
entirely inside the editor process and does not launch a terminal, Node.js
process, STDIO server, or remote service.

## Features

- Tailwind class completion in HTML, CSS, JavaScript, TypeScript, JSX, TSX,
  Vue, Svelte, Astro, PHP, Blade, Twig and ERB documents.
- Completion details generated from the active Tailwind design system.
- Hover previews with the CSS generated for a class.
- Tailwind diagnostics and quick fixes.
- Document colors and Tailwind stylesheet links.
- Tailwind v4 CSS-first project discovery.
- Support for multiple Tailwind CSS entrypoints in one workspace.
- Custom `@theme` values and relative CSS imports.
- Custom `@theme` blocks embedded in the current HTML document.
- Automatic reload when an open Tailwind entrypoint is saved.
- Bundled Tailwind v4 defaults when no project entrypoint can be found.
- Offline operation after the plugin is installed.

Common class helper functions such as `clsx`, `cn`, `cva`, `tw`, and
`twMerge` are recognized.

## Project detection

The plugin scans the open workspace for CSS files containing one or more of:

```css
@import "tailwindcss";
@theme { }
@tailwind utilities;
@config "...";
@plugin "...";
```

The scan excludes dependency, VCS and build-output folders and has safety
limits for very large or remote workspaces.

## JavaScript configs and plugins

Simple local `@config` and `@plugin` modules can run in the worker. The worker
provides `tailwindcss/colors`, `tailwindcss/defaultTheme`, and
`tailwindcss/plugin`.

Arbitrary npm packages and modules requiring Node.js APIs cannot run in a Web
Worker. If such a module prevents loading, the plugin keeps the project’s CSS
theme but omits its `@config` and `@plugin` directives. A message is written to
the Acode console when this compatibility fallback is used.

Tailwind v3 projects receive the bundled Tailwind v4 design system fallback.
Full JavaScript-config execution for Tailwind v3 would require a Node-compatible
runtime and is intentionally not emulated by this worker-only plugin.

## Build

```sh
bun install
bun run typecheck
bun test
```

The installable artifact is written to `plugin.zip`.
