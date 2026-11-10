# Branchlight project instructions

This is the standalone Git app. Keep its runtime and source separate from DevDeck's other tools.

- Keep the running package.json version visible in the repository toolbar. Bump package.json and both root entries in package-lock.json for each delivered update.
- Keep the application identity local.branchlight.git and profile branchlight-git independent from DevDeck.
- Do not bundle machine-specific paths, user data, credentials, Dispatch, factory tools, or the separate service manager.
- Run npm test and npm run test:desktop for runtime changes. Build Windows with npm run build:win and verify the asar contents and checksum with npm run test:package.
- The normal Windows outputs are dist/Branchlight.exe and dist/win-unpacked/Branchlight.exe. Before replacing a previously delivered build, inspect running executable paths. If that unpacked copy is running, stage the update and ask the user to close it; never force-close their session. Verify both executable versions and bundled package metadata/assets before reporting an update as installed.
- Keep Git changes behind argument arrays and explicit user actions. Preserve the existing confirmation and revalidation safeguards for discard and deletion.
- Use a release tag matching package.json. Update RELEASE_NOTES.md before tagging. Share source privately unless the owner explicitly changes visibility or licensing.
