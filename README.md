# blockbench-spring-bone

Blockbench plugin: Spring bone physics simulation for hair / cloth / accessory bones.

Provides real-time preview of secondary motion (= hair / cloak / chain / accessory bones
following a parent bone via spring + damper physics) directly in the Blockbench editor,
and bakes the simulation result into the AnimatedJava export pipeline so the motion
shows up in-game on Minecraft Java Edition (= datapack).

## Status

Personal-use plugin. Not distributed publicly. Issues / PRs may not be triaged.

## Approach

- **Verlet integration** + spring + damper, fixed dt with sub-stepping for stability
- Chain solving: root → leaf order, supports parent → child → grandchild bone trees
- Per-bone parameters:
  - `drag` — inertia decay factor between sub-steps
  - `stiffness` — force coefficient toward the rest direction (= parent bone orientation)
  - `gravity` — force coefficient in world -Y
  - `restLength` — distance from anchor to virtual tip. Auto-computed from the first
    child group's origin; not directly editable at the moment
- AnimatedJava integration: bake simulated transforms into the export pipeline so the
  motion is reproducible in-game

## Roadmap

- Phase 0 — plugin skeleton + Blockbench load
- Phase 1 — single bone PoC (Verlet + spring + damper, real-time preview)
- Phase 2 — chain support (gravity / drag, root → leaf solving)
- Phase 3 — editor UI (Outliner toggle, Property panel, reset action)
- Phase 5 — AnimatedJava export bake
- Future — Cloth simulation (= mass-spring grid with distance constraints)

## Build

```bash
pnpm install
pnpm build       # production build (minified)
pnpm dev         # dev build with inline sourcemap
```

Output: `dist/spring_bone.js`

## Compatibility

- Designed for the AnimatedJava (TSB fork) workflow on Blockbench 5.x (desktop variant).
- No project-format gate; activates on any project that exposes the animator panel.

## License

[MIT](./LICENSE)
