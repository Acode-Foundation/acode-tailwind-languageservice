# Tailwind CSS IntelliSense for Acode

Fast, offline Tailwind CSS IntelliSense for Acode, powered by a lightweight
Web Worker language service.

## Features

- Class completions with generated CSS details
- Hover previews, colors, diagnostics, and quick fixes
- Tailwind CSS v4 project discovery and multiple entrypoints
- Custom `@theme` values and relative CSS imports
- Limited local `@config` and `@plugin` support
- Embedded `@theme` blocks in supported markup files
- Support for `clsx`, `cn`, `cva`, `tw`, and `twMerge`
- No terminal, remote server, or internet connection required

Supported languages include HTML, CSS, SCSS, Less, JavaScript, TypeScript,
JSX, TSX, Vue, Svelte, Astro, PHP, Blade, Twig, and ERB.

## Getting started

Install **Tailwind CSS IntelliSense** from Acode's **Plugins → Explore** page,
then open your project as a workspace folder.

The plugin automatically discovers Tailwind stylesheets containing directives
such as:

```css
@import "tailwindcss";

@theme {
  --color-brand: #06b6d4;
}
```

Custom classes are then available in supported documents:

```html
<button class="rounded-lg bg-brand px-4 py-2 text-white">
  Save
</button>
```

If no Tailwind entrypoint is found, the bundled Tailwind v4 defaults are used.

## Compatibility

- Requires Acode version code `1002` or newer.
- Tailwind CSS v4 is recommended.
- Simple local JavaScript configs and plugins are supported.
- Packages requiring Node.js APIs cannot run inside the Web Worker.
- Tailwind v3 projects use the bundled Tailwind v4 fallback design system.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Report issues on
[GitHub](https://github.com/Acode-Foundation/acode-tailwind-languageservice/issues).

## License

[MIT](LICENSE). This community plugin is not affiliated with or endorsed by
Tailwind Labs.
