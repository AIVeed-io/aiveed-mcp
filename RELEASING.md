# Releasing

`development` is where changes land. `main` holds released code and is the only branch npm releases
are built from. Both branches are protected; changes reach them by pull request.

## Each release

1. On `development`, bump the version in `package.json`, `server.json` (both `version` fields) and
   `src/server.ts` (`VERSION`), and run `npm install --package-lock-only`. CI checks the three agree.
2. Open a pull request `development` -> `main`. Merge it once CI passes and a reviewer has read
   the diff.
3. Create a GitHub release with tag `v<version>` on the tip of `main`. The Publish workflow checks
   the tag, builds, tests and scans the tarball in a job without credentials, then, once a reviewer
   approves the `npm-publish` environment, publishes that tarball with provenance.
4. Update the MCP Registry listing from `server.json` with `mcp-publisher publish` (GitHub login as
   a member of the AIVeed-io organization).

A published npm version cannot be replaced. If a release is wrong, deprecate it
(`npm deprecate aiveed-mcp@<version> "<reason>"`) and release a fixed version.

## One-time setup (repository and npm owners)

- **GitHub:** protect `main` and `development` (pull request with an approving review, CI passing,
  no force pushes, no deletions); restrict who can create `v*` tags and releases; create the
  `npm-publish` environment with required reviewers and a deployment rule for `v*` tags only;
  enable secret scanning and push protection.
- **npm:** add a trusted publisher for this package (repository `AIVeed-io/aiveed-mcp`, workflow
  `publish.yml`, environment `npm-publish`), then set publishing access to "require two-factor
  authentication and disallow tokens". Keep npm owners to a minimum; they use 2FA and never publish
  by hand. A release without provenance from this workflow is not genuine.
- **First release only:** if npm requires the package to exist before a trusted publisher can be
  added, store a granular token (this package only, publish only, expiring within a day) as the
  `NPM_TOKEN` secret of the `npm-publish` environment, run the release, then delete the secret and
  the token and finish the npm setup above.
