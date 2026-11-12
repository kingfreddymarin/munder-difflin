# Validation and release actions

The automated sequence has separate typecheck, test and build workflows. A product build is generated only for a pull request targeting `release`.

1. **Develop and validate.** `CI` runs for PRs targeting other branches and pushes to `main`, `dev` or `release`. It calls `typecheck.yml`, then `tests.yml`. Neither generates the application's compiled output or installer. Installing dependencies can compile native modules required by the tests.
2. **Execute the release PR.** Open or update a PR whose base branch is `release`. `Release PR` runs typechecks, then tests, then calls `build.yml` only if both pass. Opened, reopened, synchronized, ready-for-review and edited release PRs trigger the sequence. A tag push or manual workflow dispatch does not build the application.
3. **Inspect the candidate.** Download `paramount-pr-<number>-<built-commit>-mac-arm64` from the successful run's artifacts. It contains the unsigned arm64 DMG, `SHA256SUMS.txt` and `build-info.json`. Check the checksum and recorded source identity, then install and observe the candidate. This workflow does not publish a GitHub Release, sign the app or replace a local installation.

`actions/checkout` uses the PR merge commit. The metadata distinguishes that built commit from the PR head commit. Every source update receives a new run; concurrency cancels superseded runs for the same PR. Failed stages upload their logs separately.

The reusable workflows have no push, tag or manual triggers. Packaging additionally requires a `pull_request` event whose base is `release`. All stages use read-only contents permissions and receive no inherited secrets. The build uses `electron-builder.config.cjs` so the matching `ui/dist` is included in the app.

## Repository setup

The owner must create/select the `release` target branch before executing a release PR. The repository currently uses `main` as its default branch; this change does not create branches or change that default. If branch protection requires the former combined CI check, update it to the new typecheck/test checks after the workflows are present. Release PR protection should also require the candidate-build check.

Local structural checks:

```sh
node --test test/paramount-actions.test.cjs test/paramount-packaging.test.cjs
```

These checks validate the trigger/dependency policy and existing packaging configuration without compiling or packaging the application. Hosted-runner execution remains to be verified when the workflow changes are pushed and a release PR is executed.

Trigger and reuse semantics follow GitHub's [workflow event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) and [reusable workflow documentation](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
