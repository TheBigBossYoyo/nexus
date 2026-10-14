Add a setting for quiet commands to Settings > Execution.

The setting already exists in the data: `execution.quietCommands` in src/shared/settings.ts (optional boolean; absent means on). When it is on, the commands of projects that are not enrolled run on a desktop of their own so that windows they open never reach the user's screen.

What to do:
- In src/renderer/src/views/settings/sections.tsx, in the Execution section, add a checkbox "Run commands quietly (on a hidden desktop)" bound to execution.quietCommands, checked when the value is true or absent, with the hint: "Commands of projects that are not enrolled still run as you; only their windows go to a desktop nobody sees. Turn off only if a command must show a window."
- Saving it stores true or false like the other execution settings.
- Add a renderer unit test that the checkbox is checked when the value is absent and that unticking it saves false.

Constraints:
- Do not change anything under native/, src/main/modules/privilege/, electron-builder.yml, package.json or the database migrations.
- Do not push or tag.
