# blockbench-spring-bone

Blockbench plugin: Spring bone physics simulation for hair / cloth / accessory bones.

Adds secondary motion (hair / cloak / chain / accessory bones following their parent through spring + damper
physics) to the animation preview in the Blockbench editor, and to the poses
[rigel-anim](https://github.com/EllaCoat/rigel-anim) exports, so the motion shows up in Minecraft Java Edition.

## Status

Personal-use plugin. Not distributed publicly. Issues / PRs may not be triaged.

## Usage

- Right-click a group in the Outliner and choose **Spring 化** (or **Spring 化 (子孫含む)** for the group and all
  groups below it). **Spring 解除** turns it off again. Spring groups are tinted in the Outliner. Group names are
  never changed.
- In animate mode, the **Spring Bone** panel edits the selected bone's parameters, and with an animation selected:
  - **In this animation** (継承 / 有効 / 無効) turns the bone's spring on or off for that animation only.
  - **Override** makes a parameter slider write to the selected animation instead of the group.
  - **Rest fade (ticks)** sets how many ticks before the end of the animation the spring motion fades out, so the
    last tick shows the keyframed pose and loops and animation changes do not jump.
- In edit mode the parameters are in the element panel.
- With rigel-anim installed, exporting a Rigel project includes the spring motion. Nothing needs to be set up.
- Right-click an animation and choose **Spring を bake (派生 animation)** to write the motion into keyframes of a new
  animation `<name>_baked`. The original animation is not changed, and the plugin does not add the spring again
  when the baked animation plays.

## Approach

- **Verlet integration** + spring + damper on a fixed 1/60 s step (three steps per Minecraft tick).
- The pose at a time is the result of stepping from the start of the animation, so it does not depend on how the
  timeline was scrubbed.
- Chain solving: root → leaf order. A bone points at its first child group's pivot; a bone without one points up.
- Per-bone parameters:
  - `drag` — inertia decay between steps
  - `stiffness` — force toward the rest direction (the parent bone's orientation)
  - `gravity` — force toward world -Y
- Per-animation overrides of `enabled` / `drag` / `stiffness` / `gravity`, per bone. Each field resolves as
  animation override → group value → plugin default. Overrides are stored on the animation as
  `spring_bone_overrides` (a record keyed by bone UUID) and travel with the `.bbmodel` file.

## rigel-anim

rigel-anim dispatches the Blockbench event `rigel_export_pose` with `{ animation, tick }` after it poses each tick
of an export, before it reads the bones. This plugin adds the spring motion there, using the same tick count and
end fade as the preview. An error while evaluating the spring stops the export.

## Build

```bash
pnpm install
pnpm build       # production build (minified)
pnpm dev         # dev build with inline sourcemap
pnpm typecheck
pnpm test
```

Output: `dist/spring_bone.js`

## Compatibility

- Blockbench 5.x (desktop).
- No project-format gate: the preview and bake work in any project with animation mode. Only rigel-anim exports
  include the motion; other exporters do not (bake the animation for them).

## License

[MIT](./LICENSE)
