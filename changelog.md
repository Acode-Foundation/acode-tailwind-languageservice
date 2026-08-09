# Changelog

All notable changes to Tailwind CSS IntelliSense for Acode are documented here.

## 0.1.0 — 2026-08-09

Initial public release.

### Added

- Tailwind CSS v4 completions, completion details, hover previews, diagnostics,
  quick fixes, document colors, and stylesheet links.
- CSS-first project discovery with multiple workspace entrypoints.
- Custom themes, relative imports, embedded `@theme` blocks, and limited local
  `@config`/`@plugin` support.
- Offline Web Worker runtime for supported Acode document languages.
- Original Tailwind-inspired plugin icon.

### Performance

- Bounded and ranked completion responses for the mobile worker bridge.
- Content-based caching for embedded Tailwind design systems.
- Coalesced validation and targeted, debounced project reloads.
- Parallelized project discovery with safety limits.
- Reduced worker bundle size with focused browser runtime shims.
