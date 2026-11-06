#!/usr/bin/env node
// prepublishOnly: stops an accidental `npm publish` from a working copy. It is a guard against
// mistakes, not the access control: releases are published by .github/workflows/publish.yml from
// a prebuilt tarball (which skips this script), and npm only accepts them because the package is
// configured for trusted publishing from that workflow with tokens disallowed (see RELEASING.md).
console.error('Refusing to publish from a working copy: aiveed-mcp is released by the Publish workflow from a release on main.');
process.exit(1);
