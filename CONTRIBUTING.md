# Contributing

Thanks for helping improve `pi-commandcode-provider`.

This is an unofficial Command Code provider for pi. Keep changes small, tested, and easy to review.

## Development setup

```sh
npm install
npm test
```

Useful commands:

```sh
npm run typecheck
npm run format:check
npm run test:unit
npm run test:models
npm run test:oauth
npm run test:abort
npm run test:stream
npm run test:pi-isolated
npm run test:pi-authenticated
npm run test:pi-local
```

Start an isolated pi instance with only the current checkout installed and no existing Command Code credentials:

```sh
npm run pi:isolated
```

Run `/login` inside pi. Temporary credentials, configuration, and sessions are deleted when pi exits.

Start the current checkout with your existing pi credentials and only Command Code models in the model picker:

```sh
npm run pi:authenticated
```

Both commands accept additional pi arguments after `--`, for example `npm run pi:authenticated -- --model claude-sonnet-4-6`.

Before opening a PR, run:

```sh
npm test
npm run format:check
git diff --check
```

For release and npm smoke-test steps, see [RELEASE.md](RELEASE.md).

## Pull request guidelines

- Keep PRs focused on one problem or feature.
- Add or update tests for behavior changes.
- Update `README.md`, `CHANGELOG.md`, or `RELEASE.md` when user-facing behavior changes.
- Avoid broad refactors unless the PR is specifically about refactoring.
- Do not include API keys, tokens, real auth files, `.env` files, or other secrets.
- Prefer documented/public Command Code API behavior. If compatibility with CLI behavior is needed, document why.
- Make sure npm package contents still make sense when `package.json` `files` changes.

## Testing pi integration changes

For provider, auth, request-shape, or stream changes, test both local code and the package form when possible.

Local extension smoke:

```sh
pi --no-extensions -e ./index.ts --list-models commandcode
```

Npm package smoke and isolated `/login` testing are documented in [RELEASE.md](RELEASE.md#test-the-npm-package-in-pi).

## Commit message rules

Use Angular-style Conventional Commits.

Format:

```txt
<type>(<scope>): <subject>
```

Examples:

```txt
feat(auth): support Command Code CLI auth files
fix(core): cap max tokens by selected model
docs(release): document npm smoke testing
test(stream): cover reasoning start events
chore(release): publish 0.1.1
```

### Types

Use one of these types:

- `feat`: a new user-facing feature
- `fix`: a bug fix
- `docs`: documentation-only changes
- `style`: formatting-only changes, no behavior change
- `refactor`: code restructuring without behavior change
- `perf`: performance improvement
- `test`: adding or changing tests
- `build`: package, dependency, or build-system changes
- `ci`: CI workflow changes
- `chore`: maintenance that does not fit another type
- `revert`: revert a previous commit

### Scopes

Use a short lowercase scope. Prefer existing project areas:

- `auth`
- `oauth`
- `core`
- `models`
- `stream`
- `tests`
- `docs`
- `release`
- `deps`
- `ci`

A scope is strongly recommended. If no scope fits, choose the closest project area instead of omitting it.

### Subject line

- Use imperative mood: `fix(auth): read oauth credentials`, not `fixed` or `fixes`.
- Keep it concise.
- Start lowercase after the colon.
- Do not end with a period.

### Body and footers

Use a body when the reason is not obvious:

```txt
fix(core): cap max tokens by selected model

Command Code can return models with lower output limits than the provider-wide cap.
Clamp defaults to the selected model so requests do not exceed upstream limits.
```

Breaking changes must be marked with `!` or a `BREAKING CHANGE:` footer:

```txt
feat(api)!: switch to provider api endpoints

BREAKING CHANGE: removes support for the legacy internal generate endpoint.
```
